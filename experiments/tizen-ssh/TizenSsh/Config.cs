using System;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace TizenSsh
{
    // The server reads this JSON once at startup. Fields missing from the file get their defaults.
    // Short names on purpose — a config this small does not need a schema.
    public class Config
    {
        [JsonPropertyName("listen")]
        public string Listen { get; set; } = "0.0.0.0";

        [JsonPropertyName("port")]
        public int Port { get; set; } = 2222;

        // What to launch for an interactive session. Pass arguments by setting ShellArgs.
        [JsonPropertyName("shell")]
        public string Shell { get; set; } = "/bin/bash";

        [JsonPropertyName("shell_args")]
        public string[] ShellArgs { get; set; } = { "-i" };

        // How we announce ourselves. Visible to clients; some audit tools match on it.
        [JsonPropertyName("banner")]
        public string Banner { get; set; } = "SSH-2.0-TizenSsh_0.1";

        // Files are resolved relative to the executable's directory when not absolute.
        [JsonPropertyName("authorized_keys")]
        public string AuthorizedKeys { get; set; } = "authorized_keys";

        [JsonPropertyName("host_key")]
        public string HostKey { get; set; } = "host_rsa.key";

        public static Config LoadOrSeed(string path)
        {
            if (File.Exists(path))
            {
                var json = File.ReadAllText(path);
                var cfg = JsonSerializer.Deserialize<Config>(json, Options())
                    ?? throw new InvalidDataException($"{path}: empty JSON");
                Log.Info($"config loaded from {path}");
                return cfg;
            }

            var seeded = new Config();
            File.WriteAllText(path, JsonSerializer.Serialize(seeded, Options()));
            Log.Info($"wrote default config to {path} (edit it and restart to change)");
            return seeded;
        }

        public string Resolve(string baseDir, string value)
        {
            return Path.IsPathRooted(value) ? value : Path.Combine(baseDir, value);
        }

        private static JsonSerializerOptions Options() => new JsonSerializerOptions
        {
            WriteIndented = true,
            PropertyNameCaseInsensitive = true,
            ReadCommentHandling = JsonCommentHandling.Skip
        };
    }
}
