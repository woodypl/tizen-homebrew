using System;

namespace TizenSsh
{
    // A one-line logger. stderr only — we never want log noise mixed into the SSH channels on stdout.
    // Time is UTC because a TV with no real-time clock is a thing; local timezone is a surprise waiting
    // to happen when the user looks at logs over sdb.
    internal static class Log
    {
        private static readonly object _lock = new object();

        public static void Info(string message) => Write("INFO ", message);
        public static void Warn(string message) => Write("WARN ", message);
        public static void Err(string message) => Write("ERROR", message);
        public static void Err(string message, Exception ex) => Write("ERROR", message + " :: " + ex);

        private static void Write(string level, string message)
        {
            lock (_lock)
            {
                var line = $"[{DateTime.UtcNow:HH:mm:ss.fff}] {level} {message}";
                Console.Error.WriteLine(line);
            }
        }
    }
}
