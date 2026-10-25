# tizen-ssh

A pure-managed SSH-2 server for a rooted Samsung Tizen 6.5 TV, run through the
TV's own signed `/usr/bin/dotnet`. UEP never sees an unsigned ELF — the
interpreter is signed and the SSH code runs as data under it.

Target: `netcoreapp3.1` (the TV ships 3.1.3 under
`/usr/share/dotnet/shared/Microsoft.NETCore.App/`). Framework-dependent build,
~50 KB after publishing; the FxSsh dependency is another ~130 KB.

## What it does

- Listens on TCP (default 2222).
- Accepts SSH-2 clients, pubkey auth only.
- Spawns `/bin/bash -i` for each session with a real pseudo-terminal (pty).
  Readline, curses apps (`vim`, `top`, `htop`), Ctrl-C, and job control all
  work. Falls back to plain pipes if pty allocation fails.
- Supports `exec` channels (`ssh host 'ls /'`) and plain `shell` channels.

## What it doesn't do (yet)

- **No window-change forwarding.** The pty starts at 80×24; running
  `stty cols 120 rows 40` inside the session is the workaround until FxSsh
  exposes the `window-change` request.
- No port forwarding (`-L`/`-R`), no sftp.
- No password auth, ever. Pubkey only.
- No `authorized_keys` options (`from=`, `command=`, `no-pty`). A key is
  allowed or it isn't.

## Modern OpenSSH clients

FxSsh 1.1 signs host-key proofs with SHA-1 (`ssh-rsa`), which OpenSSH 8.2+
disabled by default. Your first connect from a modern client needs:

```sh
ssh -p 2222 \
  -o HostKeyAlgorithms=+ssh-rsa \
  -o PubkeyAcceptedAlgorithms=+ssh-rsa \
  -o KexAlgorithms=+diffie-hellman-group14-sha1 \
  root@<tv>
```

Add this once to `~/.ssh/config` under a `Host` entry and future connects need
no flags:

```
Host freestyle
    HostName 192.168.77.139
    Port 2222
    User root
    HostKeyAlgorithms +ssh-rsa
    PubkeyAcceptedAlgorithms +ssh-rsa
    KexAlgorithms +diffie-hellman-group14-sha1
    IdentityFile ~/.ssh/id_rsa_freestyle
```

**RSA keys only.** FxSsh 1.1 does not support Ed25519 client keys at the
protocol level — the auth callback never fires and the client hangs at
`debug2: we sent a publickey packet, wait for reply`. Generate an RSA key:

```sh
ssh-keygen -t rsa -b 4096 -f ~/.ssh/id_rsa_freestyle
```

## Config

`config.json` is created next to the executable on first run:

```json
{
  "listen": "0.0.0.0",
  "port": 2222,
  "shell": "/bin/bash",
  "shell_args": ["-i"],
  "banner": "SSH-2.0-TizenSsh_0.1",
  "authorized_keys": "authorized_keys",
  "host_key": "host_rsa.key"
}
```

Relative paths resolve against the executable's directory.

## authorized_keys

OpenSSH format, one key per line:

```
ssh-rsa AAAAB3Nza...== laptop
ssh-rsa AAAAB3Nza...== phone
```

The server compares the base64 blob only, so a trailing comment can be
anything. Comments and blank lines are ignored.

## Deploy

The CI job builds this and uploads `tizen-ssh.zip` to a draft release on each
push to a tizen-ssh branch. Download it, unzip onto the TV somewhere writable
(e.g. your archive-root watchdog's directory, or `/home/owner/share/tizen-ssh/`),
and launch via your root channel:

```sh
cd /home/owner/share/tizen-ssh/
/usr/bin/dotnet TizenSsh.dll
```

On first run the server writes `config.json`, `authorized_keys` (empty — add
your key) and `host_rsa.key`. On second run, you're in.

For persistence across reboots, have your archive-root bootstrap re-launch
this the same way it re-arms root.

## Troubleshooting

- **`Permission denied (publickey)`**: your key isn't in `authorized_keys`, or
  it's in there but was trimmed. The server logs `authorized_keys: N key(s) loaded`
  on startup; make sure N > 0.
- **Client hangs after `debug1: Server host key: ssh-rsa`**: your OpenSSH client
  rejected the host-key algorithm. Add `-o HostKeyAlgorithms=+ssh-rsa` (see
  above).
- **Client hangs at `we sent a publickey packet, wait for reply`**: you're
  using an Ed25519 key. FxSsh 1.1 only supports RSA client keys. Generate one
  with `ssh-keygen -t rsa -b 4096` and point your config at it.
- **`Process.Start returned null`** or `errno 13` in logs: the dotnet process
  isn't allowed to exec `/bin/bash` under its Smack label. Launch dotnet via
  your archive-root route (which has `cap_sys_admin`) rather than from a
  limited uid.
- **`shell` is `/bin/bash` but the TV uses something else**: edit `config.json`
  and set `"shell": "/usr/bin/bash"` or similar. The TV's `$PATH` isn't
  consulted — the executable path must be exact.
