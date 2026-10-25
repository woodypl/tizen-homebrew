using FxSsh.Services;
using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;

namespace TizenSsh
{
    /// <summary>
    /// Bridges one SSH channel to a shell child. For interactive "shell" sessions, allocates a
    /// real pseudo-terminal (PtyProcess) so readline, curses apps (vim, htop, top), Ctrl-C, and
    /// job control all work. For "exec" sessions and as a fallback when pty allocation fails,
    /// uses plain pipes (ShellProcess).
    /// </summary>
    public sealed class ShellSession
    {
        private readonly int _sessId;
        private readonly SessionChannel _channel;
        private readonly string _shellPath;
        private readonly string[] _shellArgs;
        private readonly bool _wantPty;

        public ShellSession(int sessId, SessionChannel channel,
                            string shellPath, string[] shellArgs, bool wantPty)
        {
            _sessId = sessId;
            _channel = channel;
            _shellPath = shellPath;
            _shellArgs = shellArgs;
            _wantPty = wantPty;
        }

        public void Run()
        {
            if (_wantPty)
            {
                try
                {
                    RunWithPty();
                    return;
                }
                catch (Exception ex)
                {
                    Log.Warn($"[sess#{_sessId}] pty failed ({ex.Message}), falling back to pipes");
                }
            }
            RunWithPipes();
        }

        // ════════════════════════════════════════════════════════════
        // Pty mode — single bidirectional stream, real terminal
        // ════════════════════════════════════════════════════════════

        private void RunWithPty()
        {
            var child = PtyProcess.Spawn(_shellPath, _shellArgs);
            Log.Info($"[sess#{_sessId}] pty shell pid={child.Pid}");

            var stop = new CancellationTokenSource();

            // Single read pump: master → SSH channel. The pty merges stdout and stderr
            // and handles echo, line discipline, etc.
            var tRead = Task.Run(() => Pump(child.MasterStream, (buf, n) =>
            {
                var slice = new byte[n];
                Buffer.BlockCopy(buf, 0, slice, 0, n);
                _channel.SendData(slice);
            }, stop));

            // SSH channel → pty master (the child's stdin).
            _channel.DataReceived += (_, data) =>
            {
                if (stop.IsCancellationRequested) return;
                try { child.WriteFromClient(data, 0, data.Length); }
                catch (Exception ex)
                {
                    Log.Warn($"[sess#{_sessId}] pty write failed: {ex.Message}");
                    stop.Cancel();
                }
            };

            _channel.EofReceived += (_, __) =>
            {
                Log.Info($"[sess#{_sessId}] channel eof");
                // Can't half-close a pty — send Ctrl-D to hint the shell to exit.
                try { child.WriteFromClient(new byte[] { 0x04 }, 0, 1); } catch { }
            };

            _channel.CloseReceived += (_, __) =>
            {
                Log.Info($"[sess#{_sessId}] channel close received");
                stop.Cancel();
                child.Dispose();
            };

            // Reaper: once the read pump returns (child exited → master returns EIO → EOF),
            // collect the exit code and close the SSH channel.
            Task.Run(() =>
            {
                tRead.Wait();
                int code = child.WaitExit(2000);
                if (code < 0) code = 0;
                try { _channel.SendEof(); } catch { }
                try { _channel.SendClose((uint)code); } catch { }
                stop.Cancel();
                child.Dispose();
                Log.Info($"[sess#{_sessId}] pty shell exited (code={code})");
            });
        }

        // ════════════════════════════════════════════════════════════
        // Pipe mode — separate stdout/stderr/stdin, no terminal
        // (exec channels and pty-fallback)
        // ════════════════════════════════════════════════════════════

        private void RunWithPipes()
        {
            ShellProcess child;
            try
            {
                child = ShellProcess.Spawn(_shellPath, _shellArgs);
            }
            catch (Exception ex)
            {
                Log.Err($"[sess#{_sessId}] spawn failed", ex);
                SendBanner("tizen-ssh: cannot start shell: " + ex.Message + "\n");
                SafeClose(255);
                return;
            }

            Log.Info($"[sess#{_sessId}] pipe shell pid={child.Pid}");

            var stop = new CancellationTokenSource();

            // stdout → channel
            var tOut = Task.Run(() => Pump(child.Output, (buf, n) =>
            {
                var slice = new byte[n];
                Buffer.BlockCopy(buf, 0, slice, 0, n);
                _channel.SendData(slice);
            }, stop));

            // stderr → channel (merged into the same SSH data stream)
            var tErr = Task.Run(() => Pump(child.Error, (buf, n) =>
            {
                var slice = new byte[n];
                Buffer.BlockCopy(buf, 0, slice, 0, n);
                _channel.SendData(slice);
            }, stop));

            _channel.DataReceived += (_, data) =>
            {
                if (stop.IsCancellationRequested) return;
                try { child.WriteFromClient(data, 0, data.Length); }
                catch (Exception ex)
                {
                    Log.Warn($"[sess#{_sessId}] stdin write failed: {ex.Message}");
                    stop.Cancel();
                }
            };

            _channel.EofReceived += (_, __) =>
            {
                Log.Info($"[sess#{_sessId}] channel eof -> closing shell stdin");
                child.CloseStdin();
            };

            _channel.CloseReceived += (_, __) =>
            {
                Log.Info($"[sess#{_sessId}] channel close received");
                stop.Cancel();
                child.Dispose();
            };

            Task.Run(() =>
            {
                Task.WaitAny(tOut, tErr);
                int code = child.WaitExit(2000);
                if (code < 0) code = 0;
                try { _channel.SendEof(); } catch { }
                try { _channel.SendClose((uint)code); } catch { }
                stop.Cancel();
                child.Dispose();
                Log.Info($"[sess#{_sessId}] pipe shell exited (code={code})");
            });
        }

        // ════════════════════════════════════════════════════════════
        // Shared
        // ════════════════════════════════════════════════════════════

        private static void Pump(Stream from, Action<byte[], int> onChunk,
                                 CancellationTokenSource stop)
        {
            var buf = new byte[4096];
            try
            {
                while (!stop.IsCancellationRequested)
                {
                    int n = from.Read(buf, 0, buf.Length);
                    if (n <= 0) break;
                    onChunk(buf, n);
                }
            }
            catch (IOException) { /* child exited / pipes closed */ }
            catch (ObjectDisposedException) { /* teardown race */ }
            catch (Exception ex) { Log.Warn("pump: " + ex.Message); }
        }

        private void SendBanner(string text)
        {
            try { _channel.SendData(System.Text.Encoding.UTF8.GetBytes(text)); } catch { }
        }

        private void SafeClose(uint code)
        {
            try { _channel.SendEof(); } catch { }
            try { _channel.SendClose(code); } catch { }
        }
    }
}
