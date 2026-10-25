using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace TizenSsh
{
    // One line per key, OpenSSH authorized_keys format:
    //   <type> <base64 blob> [comment]
    // Blank lines and lines starting with '#' are ignored. Options and from= restrictions are not
    // parsed — a key is either accepted or it is not. That is the one thing standing between
    // the TV's shell and the network, so we keep it dead simple.
    public class AuthorizedKeys
    {
        private readonly HashSet<string> _blobs = new HashSet<string>(StringComparer.Ordinal);
        private readonly string _path;

        public int Count => _blobs.Count;
        public string Path => _path;

        private AuthorizedKeys(string path, IEnumerable<string> blobs)
        {
            _path = path;
            foreach (var b in blobs) _blobs.Add(b);
        }

        public static AuthorizedKeys Load(string path)
        {
            if (!File.Exists(path))
            {
                File.WriteAllText(path,
                    "# One key per line in OpenSSH format: `ssh-rsa AAAA... alice@laptop`\n" +
                    "# Keys with any other algorithm (ed25519, ecdsa) are also accepted.\n" +
                    "# Lines starting with # are ignored.\n");
                Log.Warn($"created empty {path} — add at least one key or no one can log in");
                return new AuthorizedKeys(path, Array.Empty<string>());
            }

            var blobs = new List<string>();
            foreach (var raw in File.ReadAllLines(path))
            {
                var line = raw.Trim();
                if (line.Length == 0 || line[0] == '#') continue;

                // Split on whitespace: [type, blob, comment?]
                var parts = line.Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length < 2)
                {
                    Log.Warn($"authorized_keys: skipped malformed line: {line}");
                    continue;
                }
                blobs.Add(parts[1]);
            }
            Log.Info($"authorized_keys: {blobs.Count} key(s) loaded from {path}");
            return new AuthorizedKeys(path, blobs);
        }

        // FxSsh gives us the raw SSH wire-format public key (DER, type-prefixed). We compare in
        // base64 against what the authorized_keys file holds, which is OpenSSH's canonical form.
        public bool Allows(byte[] publicKey)
        {
            if (publicKey == null || publicKey.Length == 0) return false;
            var b64 = Convert.ToBase64String(publicKey);
            return _blobs.Contains(b64);
        }
    }
}
