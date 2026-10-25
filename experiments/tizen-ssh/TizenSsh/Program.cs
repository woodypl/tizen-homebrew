using System;
using System.IO;
using System.Threading;

namespace TizenSsh
{
    public static class Program
    {
        public static int Main(string[] args)
        {
            // The executable's directory is where we keep everything: config, host key,
            // authorized_keys. Launching from anywhere is fine; nothing uses CWD.
            var baseDir = AppContext.BaseDirectory;
            Log.Info($"tizen-ssh starting  (dir={baseDir})");

            Config cfg;
            try { cfg = Config.LoadOrSeed(Path.Combine(baseDir, "config.json")); }
            catch (Exception ex) { Log.Err("failed to load config", ex); return 2; }

            SshHost host;
            try { host = new SshHost(cfg, baseDir); }
            catch (Exception ex) { Log.Err("failed to initialize", ex); return 3; }

            var done = new ManualResetEventSlim();
            Console.CancelKeyPress += (_, e) => { e.Cancel = true; done.Set(); };
            AppDomain.CurrentDomain.ProcessExit += (_, __) => done.Set();

            try { host.Start(); }
            catch (Exception ex) { Log.Err("failed to start listener", ex); return 4; }

            Log.Info("ready. Ctrl-C to stop.");
            done.Wait();

            Log.Info("stopping");
            host.Dispose();
            return 0;
        }
    }
}
