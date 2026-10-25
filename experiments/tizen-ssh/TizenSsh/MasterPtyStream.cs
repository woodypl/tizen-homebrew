using System;
using System.IO;
using System.Runtime.InteropServices;

namespace TizenSsh
{
    /// <summary>
    /// Wraps a pty master file descriptor in a <see cref="Stream"/>. Read and write go through
    /// libc's read(2)/write(2) with EINTR retry. When the child exits, the kernel delivers EIO
    /// on the master — we map that to EOF (return 0) so the pump shuts down cleanly.
    /// </summary>
    public sealed class MasterPtyStream : Stream
    {
        private int _fd;
        private volatile bool _closed;

        public MasterPtyStream(int masterFd) { _fd = masterFd; }

        public override bool CanRead  => !_closed;
        public override bool CanWrite => !_closed;
        public override bool CanSeek  => false;
        public override long Length   => throw new NotSupportedException();
        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            if (_closed || count == 0) return 0;

            var handle = GCHandle.Alloc(buffer, GCHandleType.Pinned);
            try
            {
                IntPtr ptr = Marshal.UnsafeAddrOfPinnedArrayElement(buffer, offset);
                while (true)
                {
                    int n = PtyNative.read(_fd, ptr, count);
                    if (n > 0) return n;
                    if (n == 0) return 0;

                    int err = Marshal.GetLastWin32Error();
                    if (err == PtyNative.EINTR) continue;          // interrupted — retry
                    if (err == PtyNative.EIO)   return 0;          // child exited
                    if (err == PtyNative.EBADF) return 0;          // fd closed under us
                    throw new IOException($"pty read: errno={err}");
                }
            }
            finally { handle.Free(); }
        }

        public override void Write(byte[] buffer, int offset, int count)
        {
            if (_closed || count == 0) return;

            var handle = GCHandle.Alloc(buffer, GCHandleType.Pinned);
            try
            {
                int written = 0;
                while (written < count)
                {
                    IntPtr ptr = Marshal.UnsafeAddrOfPinnedArrayElement(buffer, offset + written);
                    int n = PtyNative.write(_fd, ptr, count - written);
                    if (n >= 0) { written += n; continue; }

                    int err = Marshal.GetLastWin32Error();
                    if (err == PtyNative.EINTR) continue;
                    if (err == PtyNative.EIO || err == PtyNative.EBADF) return;
                    throw new IOException($"pty write: errno={err}");
                }
            }
            finally { handle.Free(); }
        }

        public override void Flush() { /* pty has no userspace buffer to flush */ }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();

        protected override void Dispose(bool disposing)
        {
            if (!_closed)
            {
                _closed = true;
                PtyNative.close(_fd);
                _fd = -1;
            }
            base.Dispose(disposing);
        }
    }
}
