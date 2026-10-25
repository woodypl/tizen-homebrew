using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

namespace TizenSsh
{
    // Launches a shell child and bridges its stdin/stdout/stderr to the SSH channel.
    //
    // No pty. .NET's Process.Start uses fork+exec safely under the hood (the runtime cleans up
    // its own threads correctly across fork), whereas hand-rolling fork() from managed code is
    // unsafe — the GC and JIT threads survive the fork and can deadlock before our execve.
    // The cost of using Process.Start is: no controlling terminal, so interactive niceties
    // (readline, prompt redraw, Ctrl-C delivering SIGINT via tty) are degraded. For commands
    // and scripts it's fine; `vim` and `top` are not. A later version can add pty support
    // by shelling out to a signed socat/script binary on the TV.
    public sealed class ShellProcess : IDisposable
    {
        private readonly Process _proc;
        private readonly object _writeLock = new object();
        private bool _disposed;

        public Stream Input => _proc.StandardInput.BaseStream;    // our side writes here
        public Stream Output => _proc.StandardOutput.BaseStream;  // our side reads here
        public Stream Error => _proc.StandardError.BaseStream;    // merged into output by the pump
        public int Pid => _proc.Id;

        private ShellProcess(Process p) { _proc = p; }

        public static ShellProcess Spawn(string path, string[] args)
        {
            var psi = new ProcessStartInfo
            {
                FileName = path,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = "/",
            };
            foreach (var a in args) psi.ArgumentList.Add(a);

            // Minimal, deterministic environment. Not inheriting the dotnet host's env prevents
            // surprises from DOTNET_* and ASPNETCORE_* and so on leaking into the user's shell.
            psi.Environment.Clear();
            psi.Environment["TERM"] = "dumb";               // no pty, so no cursor magic
            psi.Environment["PATH"] = "/usr/local/sbin:/usr/sbin:/usr/local/bin:/usr/bin:/bin:/sbin";
            psi.Environment["HOME"] = "/home/owner";
            psi.Environment["USER"] = "root";
            psi.Environment["LOGNAME"] = "root";
            psi.Environment["SHELL"] = "/bin/bash";
            psi.Environment["LANG"] = "C.UTF-8";

            var p = Process.Start(psi) ?? throw new IOException("Process.Start returned null");
            return new ShellProcess(p);
        }

        public void WriteFromClient(byte[] data, int offset, int count)
        {
            if (_disposed) return;
            lock (_writeLock)
            {
                _proc.StandardInput.BaseStream.Write(data, offset, count);
                _proc.StandardInput.BaseStream.Flush();
            }
        }

        public void CloseStdin()
        {
            try { _proc.StandardInput.Close(); } catch { /* already gone */ }
        }

        public int WaitExit(int timeoutMs)
        {
            if (_proc.WaitForExit(timeoutMs)) return _proc.ExitCode;
            return -2;
        }

        public void Signal(int sig)
        {
            try { Syscalls.Kill(_proc.Id, sig); } catch { /* best effort */ }
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;

            if (!_proc.HasExited)
            {
                try { Syscalls.Kill(_proc.Id, 1 /*SIGHUP*/); } catch { }
                if (!_proc.WaitForExit(500))
                {
                    try { Syscalls.Kill(_proc.Id, 9 /*SIGKILL*/); } catch { }
                }
            }
            try { _proc.Dispose(); } catch { }
        }
    }
}
