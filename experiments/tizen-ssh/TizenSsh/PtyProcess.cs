using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace TizenSsh
{
    /// <summary>
    /// Spawns a shell child on a real pseudo-terminal. The master fd is exposed as a
    /// bidirectional <see cref="Stream"/>, so the SSH channel pump reads and writes one stream
    /// instead of juggling separate stdout/stderr/stdin pipes. Readline, curses apps, Ctrl-C,
    /// and job control all work because the child sees a real controlling terminal.
    ///
    /// Implementation: posix_openpt → grantpt → unlockpt → ptsname → open slave, then
    /// fork + execve. All native memory for execve is pre-allocated before fork, so the child
    /// (whose managed runtime is in an undefined state post-fork) touches only async-signal-safe
    /// libc calls before execve replaces the process image.
    /// </summary>
    public sealed class PtyProcess : IDisposable
    {
        private readonly int _masterFd;
        private readonly int _childPid;
        private readonly MasterPtyStream _stream;
        private readonly object _writeLock = new object();
        private bool _disposed;

        public int Pid => _childPid;
        public Stream MasterStream => _stream;

        private PtyProcess(int masterFd, int childPid)
        {
            _masterFd = masterFd;
            _childPid = childPid;
            _stream = new MasterPtyStream(masterFd);
        }

        // ptsname() uses a static buffer — serialise the entire open-pty sequence.
        private static readonly object _spawnLock = new object();

        /// <summary>
        /// Opens a pty pair, forks, and execs the shell on the slave side. Returns a
        /// <see cref="PtyProcess"/> whose <see cref="MasterStream"/> carries all I/O.
        /// Throws on any failure; callers should fall back to pipe-based ShellProcess.
        /// </summary>
        public static PtyProcess Spawn(string shell, string[] shellArgs,
                                       ushort rows = 24, ushort cols = 80)
        {
            int master, slave;

            lock (_spawnLock)
            {
                master = PtyNative.posix_openpt(PtyNative.O_RDWR | PtyNative.O_NOCTTY);
                if (master < 0)
                    throw new IOException($"posix_openpt: errno={Marshal.GetLastWin32Error()}");

                // Mark master close-on-exec so it doesn't leak into future children.
                PtyNative.fcntl(master, PtyNative.F_SETFD, PtyNative.FD_CLOEXEC);

                if (PtyNative.grantpt(master) < 0)
                    throw Fail("grantpt", master);

                if (PtyNative.unlockpt(master) < 0)
                    throw Fail("unlockpt", master);

                IntPtr namePtr = PtyNative.ptsname(master);
                if (namePtr == IntPtr.Zero)
                    throw Fail("ptsname", master);

                string slaveName = Marshal.PtrToStringAnsi(namePtr);

                slave = PtyNative.open(slaveName, PtyNative.O_RDWR | PtyNative.O_NOCTTY);
                if (slave < 0)
                    throw Fail($"open({slaveName})", master);
            }

            // Set initial window size on the slave before the child starts.
            var ws = new PtyNative.WinSize { ws_row = rows, ws_col = cols };
            PtyNative.ioctl_winsize(slave, PtyNative.TIOCSWINSZ, ref ws);

            // ---- Pre-allocate native memory for execve (before fork) ----

            var argv = new string[1 + shellArgs.Length];
            argv[0] = shell;
            Array.Copy(shellArgs, 0, argv, 1, shellArgs.Length);

            var envp = new[]
            {
                "TERM=xterm-256color",
                "PATH=/usr/local/sbin:/usr/sbin:/usr/local/bin:/usr/bin:/bin:/sbin",
                "HOME=/home/owner",
                "USER=root",
                "LOGNAME=root",
                "SHELL=" + shell,
                "LANG=C.UTF-8",
            };

            IntPtr nativePath = Marshal.StringToHGlobalAnsi(shell);
            IntPtr nativeArgv = PtyNative.AllocNativeStringArray(argv);
            IntPtr nativeEnvp = PtyNative.AllocNativeStringArray(envp);

            int pid;
            try
            {
                pid = PtyNative.fork();
            }
            catch
            {
                Cleanup(master, slave, nativePath, nativeArgv, argv.Length, nativeEnvp, envp.Length);
                throw;
            }

            if (pid < 0)
            {
                int e = Marshal.GetLastWin32Error();
                Cleanup(master, slave, nativePath, nativeArgv, argv.Length, nativeEnvp, envp.Length);
                throw new IOException($"fork: errno={e}");
            }

            if (pid == 0)
            {
                // ═══════════════════════════════════════════════════════
                // CHILD — only async-signal-safe libc calls until execve
                // ═══════════════════════════════════════════════════════
                PtyNative.close(master);

                // New session, acquire the slave as controlling terminal.
                PtyNative.setsid();
                int zero = 0;
                PtyNative.ioctl_int(slave, PtyNative.TIOCSCTTY, ref zero);

                // Wire stdin/stdout/stderr to the slave pty.
                PtyNative.dup2(slave, 0);
                PtyNative.dup2(slave, 1);
                PtyNative.dup2(slave, 2);
                if (slave > 2) PtyNative.close(slave);

                // Close leaked fds from the server (listening socket, other client
                // connections, dotnet runtime internals). close() on an invalid fd
                // returns EBADF harmlessly; the loop is cheaper than scanning /proc.
                for (int fd = 3; fd < 1024; fd++) PtyNative.close(fd);

                // Replace process image with the shell.
                PtyNative.execve(nativePath, nativeArgv, nativeEnvp);

                // execve only returns on failure.
                PtyNative._exit(127);
            }

            // ═══════════════════════════════════════════════════════
            // PARENT
            // ═══════════════════════════════════════════════════════
            PtyNative.close(slave);
            PtyNative.FreeNativeStringArray(nativeArgv, argv.Length);
            PtyNative.FreeNativeStringArray(nativeEnvp, envp.Length);
            Marshal.FreeHGlobal(nativePath);

            Log.Info($"pty child spawned: pid={pid}, master fd={master}");
            return new PtyProcess(master, pid);
        }

        /// <summary>Writes data from the SSH channel into the pty master (the child's stdin).</summary>
        public void WriteFromClient(byte[] data, int offset, int count)
        {
            if (_disposed) return;
            lock (_writeLock) { _stream.Write(data, offset, count); }
        }

        /// <summary>
        /// Updates the pty's window size. The kernel delivers SIGWINCH to the child's
        /// foreground process group automatically.
        /// </summary>
        public void SetWindowSize(ushort rows, ushort cols)
        {
            if (_disposed) return;
            var ws = new PtyNative.WinSize { ws_row = rows, ws_col = cols };
            PtyNative.ioctl_winsize(_masterFd, PtyNative.TIOCSWINSZ, ref ws);
        }

        /// <summary>
        /// Waits up to <paramref name="timeoutMs"/> for the child to exit.
        /// Returns the exit code (0-255), 128+signal if killed, or -2 on timeout.
        /// </summary>
        public int WaitExit(int timeoutMs)
        {
            int elapsed = 0;
            while (elapsed < timeoutMs)
            {
                int rc = PtyNative.waitpid(_childPid, out int status, PtyNative.WNOHANG);
                if (rc > 0)
                {
                    if ((status & 0x7F) == 0) return (status >> 8) & 0xFF;   // WIFEXITED
                    return 128 + (status & 0x7F);                             // WIFSIGNALED
                }
                Thread.Sleep(50);
                elapsed += 50;
            }
            return -2;
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;

            // SIGHUP is the "terminal hung up" signal — the shell handles it gracefully.
            try { PtyNative.kill(_childPid, PtyNative.SIGHUP); } catch { }
            if (WaitExit(500) < -1)
            {
                try { PtyNative.kill(_childPid, PtyNative.SIGKILL); } catch { }
                try { PtyNative.waitpid(_childPid, out _, 0); } catch { }
            }

            _stream.Dispose();
        }

        // ---- Helpers ----

        private static IOException Fail(string call, int masterToClose)
        {
            int e = Marshal.GetLastWin32Error();
            PtyNative.close(masterToClose);
            return new IOException($"{call}: errno={e}");
        }

        private static void Cleanup(int master, int slave,
                                     IntPtr path, IntPtr argv, int argc, IntPtr envp, int envc)
        {
            PtyNative.close(master);
            PtyNative.close(slave);
            PtyNative.FreeNativeStringArray(argv, argc);
            PtyNative.FreeNativeStringArray(envp, envc);
            Marshal.FreeHGlobal(path);
        }
    }
}
