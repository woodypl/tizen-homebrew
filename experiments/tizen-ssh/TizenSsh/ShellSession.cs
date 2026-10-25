using FxSsh.Services;
using System;
using System.Threading;
using System.Threading.Tasks;

namespace TizenSsh
{
    // Bridges one SSH channel to a /bin/bash child.
    //
    // Three I/O pumps run concurrently:
    //   - stdout -> SSH channel (data)
    //   - stderr -> SSH channel (data; merged with stdout since SSH shell channels have one stream)
    //   - SSH channel data -> stdin
    //
    // All three stop and the shell is torn down when any side closes. No pty — the bash child
    // runs on plain pipes, so `vim`/`top`/readline won't work right. Commands and scp are fine.
    public sealed class ShellSession
    {
        private readonly int _sessId;
        private readonly SessionChannel _channel;
        private readonly string _shellPath;
        private readonly string[] _shellArgs;

        public ShellSession(int sessId, SessionChannel channel, string shellPath, string[] shellArgs)
        {
            _sessId = sessId;
            _channel = channel;
            _shellPath = shellPath;
            _shellArgs = shellArgs;
        }

        public void Run()
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

            Log.Info($"[sess#{_sessId}] shell pid={child.Pid}");

            var stop = new CancellationTokenSource();

            // stdout -> channel.
            var tOut = Task.Run(() => Pump(child.Output, (buf, n) =>
            {
                var slice = new byte[n];
                Buffer.BlockCopy(buf, 0, slice, 0, n);
                _channel.SendData(slice);
            }, stop));

            // stderr -> channel (same stream as stdout — SSH session channels are one-way merged).
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

            // Reaper: wait until either output pump has returned, then wait for the shell process.
            Task.Run(() =>
            {
                Task.WaitAny(tOut, tErr);
                int code = child.WaitExit(2000);
                if (code < 0) code = 0;
                try { _channel.SendEof(); } catch { }
                try { _channel.SendClose((uint)code); } catch { }
                stop.Cancel();
                child.Dispose();
                Log.Info($"[sess#{_sessId}] shell exited (code={code})");
            });
        }

        private static void Pump(System.IO.Stream from, Action<byte[], int> onChunk, CancellationTokenSource stop)
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
            catch (System.IO.IOException) { /* child exited, pipes closed */ }
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
