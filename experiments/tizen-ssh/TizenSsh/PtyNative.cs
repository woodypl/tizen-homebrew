using System;
using System.Runtime.InteropServices;

namespace TizenSsh
{
    /// <summary>
    /// P/Invoke bindings for pseudo-terminal operations. Uses only libc symbols (posix_openpt
    /// and friends) to avoid the libutil.so dependency that older guides recommend — glibc on
    /// Tizen ships everything we need in libc itself.
    /// </summary>
    internal static class PtyNative
    {
        private const string LIBC = "libc";

        // ---- Pty creation (POSIX, all in libc) ----

        [DllImport(LIBC, SetLastError = true)]
        public static extern int posix_openpt(int flags);

        [DllImport(LIBC, SetLastError = true)]
        public static extern int grantpt(int fd);

        [DllImport(LIBC, SetLastError = true)]
        public static extern int unlockpt(int fd);

        /// <summary>
        /// Returns a pointer to a static buffer containing the slave device path.
        /// Not thread-safe — callers must serialise around the open-pty sequence.
        /// </summary>
        [DllImport(LIBC, SetLastError = true)]
        public static extern IntPtr ptsname(int fd);

        // ---- File descriptor operations ----

        [DllImport(LIBC, SetLastError = true, CharSet = CharSet.Ansi)]
        public static extern int open([MarshalAs(UnmanagedType.LPStr)] string path, int flags);

        [DllImport(LIBC, SetLastError = true)]
        public static extern int close(int fd);

        [DllImport(LIBC, SetLastError = true)]
        public static extern int read(int fd, IntPtr buf, int count);

        [DllImport(LIBC, SetLastError = true)]
        public static extern int write(int fd, IntPtr buf, int count);

        [DllImport(LIBC, SetLastError = true)]
        public static extern int fcntl(int fd, int cmd, int arg);

        // ---- Process lifecycle ----

        [DllImport(LIBC, SetLastError = true)]
        public static extern int fork();

        [DllImport(LIBC, SetLastError = true)]
        public static extern int setsid();

        [DllImport(LIBC, SetLastError = true)]
        public static extern int dup2(int oldfd, int newfd);

        /// <summary>
        /// Replaces the current process image. All three pointers must be pre-allocated
        /// native memory (not managed strings) because this is called in the child after
        /// fork, where the managed runtime is in an undefined state.
        /// </summary>
        [DllImport(LIBC, SetLastError = true)]
        public static extern int execve(IntPtr path, IntPtr argv, IntPtr envp);

        [DllImport(LIBC)]
        public static extern void _exit(int status);

        [DllImport(LIBC, SetLastError = true)]
        public static extern int waitpid(int pid, out int status, int options);

        [DllImport(LIBC, SetLastError = true)]
        public static extern int kill(int pid, int sig);

        // ---- Terminal ioctl ----

        [DllImport(LIBC, SetLastError = true, EntryPoint = "ioctl")]
        public static extern int ioctl_int(int fd, uint request, ref int value);

        [DllImport(LIBC, SetLastError = true, EntryPoint = "ioctl")]
        public static extern int ioctl_winsize(int fd, uint request, ref WinSize ws);

        // ---- Constants (ARM Linux — same values as x86) ----

        public const int O_RDWR   = 0x0002;
        public const int O_NOCTTY = 0x0100;

        public const int F_SETFD    = 2;
        public const int FD_CLOEXEC = 1;

        public const uint TIOCSCTTY  = 0x540E;
        public const uint TIOCSWINSZ = 0x5414;

        public const int SIGHUP  = 1;
        public const int SIGKILL = 9;
        public const int WNOHANG = 1;

        public const int EINTR = 4;
        public const int EIO   = 5;
        public const int EBADF = 9;

        [StructLayout(LayoutKind.Sequential)]
        public struct WinSize
        {
            public ushort ws_row;
            public ushort ws_col;
            public ushort ws_xpixel;
            public ushort ws_ypixel;
        }

        // ---- Native string-array helpers for execve ----

        /// <summary>
        /// Allocates a null-terminated <c>char**</c> array of ANSI strings on the native heap.
        /// Must be called BEFORE fork() so the child process inherits the pointers via
        /// copy-on-write. Free with <see cref="FreeNativeStringArray"/> in the parent after fork.
        /// </summary>
        public static IntPtr AllocNativeStringArray(string[] strings)
        {
            int count = strings.Length;
            IntPtr array = Marshal.AllocHGlobal(IntPtr.Size * (count + 1));
            for (int i = 0; i < count; i++)
                Marshal.WriteIntPtr(array, i * IntPtr.Size, Marshal.StringToHGlobalAnsi(strings[i]));
            Marshal.WriteIntPtr(array, count * IntPtr.Size, IntPtr.Zero);
            return array;
        }

        /// <summary>Frees a native string array allocated by <see cref="AllocNativeStringArray"/>.</summary>
        public static void FreeNativeStringArray(IntPtr array, int count)
        {
            if (array == IntPtr.Zero) return;
            for (int i = 0; i < count; i++)
            {
                IntPtr s = Marshal.ReadIntPtr(array, i * IntPtr.Size);
                if (s != IntPtr.Zero) Marshal.FreeHGlobal(s);
            }
            Marshal.FreeHGlobal(array);
        }
    }
}
