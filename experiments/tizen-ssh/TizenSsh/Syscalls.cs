using System.Runtime.InteropServices;

namespace TizenSsh
{
    // Minimal libc bindings for things .NET Core 3.1 does not expose portably.
    internal static class Syscalls
    {
        [DllImport("libc", EntryPoint = "chmod", SetLastError = true)]
        public static extern int Chmod([MarshalAs(UnmanagedType.LPStr)] string path, int mode);

        [DllImport("libc", EntryPoint = "kill", SetLastError = true)]
        public static extern int Kill(int pid, int sig);
    }
}
