using FxSsh;
using FxSsh.Services;
using System;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Threading;

namespace TizenSsh
{
    // Thin wrapper over FxSsh's SshServer. Wires auth and shell/exec channels onto the
    // ShellSession class, which does the actual pipe pumping to the bash child.
    //
    // We only touch the FxSsh API surface that is stable across 1.4..1.5: SshServer with
    // StartingInfo, AddHostKey, ConnectionAccepted, Session.ServiceRegistered, UserauthService
    // with its Userauth event, and ConnectionService with CommandOpened. Pty-req/env events
    // and the KeyAlgorithm/Fingerprint fields on UserauthArgs are not used here, so a minor
    // library version bump that reshapes them does not break the build.
    public sealed class SshHost : IDisposable
    {
        private readonly Config _config;
        private readonly AuthorizedKeys _keys;
        private readonly SshServer _server;
        private int _nextSessionId;

        public SshHost(Config config, string baseDir)
        {
            _config = config;
            _keys = AuthorizedKeys.Load(config.Resolve(baseDir, config.AuthorizedKeys));

            var listen = IPAddress.Parse(config.Listen);
            _server = new SshServer(new StartingInfo(listen, config.Port, config.Banner));
            _server.AddHostKey("ssh-rsa", LoadOrCreateHostKey(config.Resolve(baseDir, config.HostKey)));
            _server.ConnectionAccepted += OnConnectionAccepted;
            _server.ExceptionRasied += (_, ex) => Log.Err("server error", ex);
        }

        public void Start()
        {
            _server.Start();
            Log.Info($"listening on {_config.Listen}:{_config.Port}  (banner: {_config.Banner})");
            if (_keys.Count == 0)
                Log.Warn($"NO KEYS LOADED — all logins will be refused. Add one to {_keys.Path}");
        }

        public void Stop() => _server.Stop();
        public void Dispose() => Stop();

        private void OnConnectionAccepted(object sender, Session session)
        {
            var id = Interlocked.Increment(ref _nextSessionId);
            Log.Info($"[sess#{id}] opened");

            session.ServiceRegistered += (_, svc) =>
            {
                switch (svc)
                {
                    case UserauthService auth:
                        auth.Userauth += (_, args) => OnUserauth(id, args);
                        break;
                    case ConnectionService conn:
                        conn.CommandOpened += (_, args) => OnCommandOpened(id, args);
                        break;
                }
            };
        }

        private void OnUserauth(int sessId, UserauthArgs args)
        {
            // Publickey only. FxSsh calls back once per key the client offers; we accept the first
            // one that matches an authorized_keys entry.
            args.Result = _keys.Allows(args.Key);
            Log.Info($"[sess#{sessId}] auth {args.Username} -> " +
                     $"{(args.Result ? "accepted" : "refused")}");
        }

        private void OnCommandOpened(int sessId, CommandRequestedArgs args)
        {
            Log.Info($"[sess#{sessId}] channel {args.ShellType}" +
                     (args.ShellType == "exec" ? $" command=\"{args.CommandText}\"" : ""));

            try
            {
                string[] shellArgs = args.ShellType == "exec"
                    ? new[] { "-c", args.CommandText ?? "" }
                    : _config.ShellArgs;

                var ss = new ShellSession(sessId, args.Channel, _config.Shell, shellArgs);
                ss.Run();
            }
            catch (Exception ex)
            {
                Log.Err($"[sess#{sessId}] failed to start session", ex);
                try { args.Channel.SendClose(255); } catch { /* already gone */ }
            }
        }

        // Load or generate (and persist) an RSA host key. We store it as base64 of an RSA
        // CSP PRIVATEKEYBLOB — the same format FxSsh's AddHostKey expects to receive. 3072 bits
        // for the modulus; FxSsh's own default is 1024 and that's too short for anything today.
        private static string LoadOrCreateHostKey(string path)
        {
            if (File.Exists(path))
            {
                var text = File.ReadAllText(path).Trim();
                Log.Info($"host key loaded from {path}  ({text.Length} base64 chars)");
                return text;
            }

            using var rsa = new RSACryptoServiceProvider(3072);
            var blob = rsa.ExportCspBlob(true);
            var b64 = Convert.ToBase64String(blob);
            File.WriteAllText(path, b64);
            try { Syscalls.Chmod(path, Convert.ToInt32("600", 8)); } catch { /* best effort */ }
            Log.Info($"generated new RSA 3072 host key, saved to {path}");
            return b64;
        }
    }
}
