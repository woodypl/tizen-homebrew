# boot-agent — untethered boot root for Samsung Tizen TVs

A headless dotnet-inhouse service app that runs at every boot, re-acquires
root via the localhost sdbd injection (SVE-2025-50109), and executes a
configurable set of boot modules — all without any host computer attached.

Inspired by [levkropp/samsung-tv-root-untethered](https://github.com/levkropp/samsung-tv-root-untethered).

## How it works

```
TV boots
  → app-boot-manager launches the squatted app via aul
  → .NET IL runs as uid 5001 (User::Pkg::*)
  → TCP connect to 127.0.0.1:26101 (sdbd)
  → ADB wire protocol handshake + capability
  → SVE-2025-50109: shell injection via appinstall tpk filename
  → cat launch.sh | bash  (UEP-safe stdin bypass)
  → dotnet archive-root payload with cap_setuid → uid 0
  → module runner iterates /opt/usr/share/selfroot/modules/*/boot.sh
```

The agent is a **headless svcapp** (no NUI, no UI window). All management
happens over SSH once the `02-ssh-service` module brings up
[tizen-ssh](../tizen-ssh/).

## Prerequisites

- **Rooted TV** — initial root must be established first (e.g. via
  tizen-homebrew's normal tethered flow). The boot agent takes over from
  there.
- **Developer Mode Host PC IP = `127.0.0.1`** — sdbd authorizes by the
  host IP cached at startup. Set this in the TV's developer settings
  *before* deploying the agent, then reboot so sdbd picks it up.
- **Squattable app** — the agent replaces a pre-installed Samsung app's
  DLL. The default is `com.samsung.tv.ghservice` (Gaming Hub service).
  Change `AssemblyName` in `BootAgent.csproj` and `DefaultAppId` in
  `Program.cs` to match whatever app is available on your model. The app
  must have `on-boot="true"` in its manifest or in the
  `package_app_info` SQLite table.

## Building

### Requirements

- .NET Core SDK 3.1 (the TV ships dotnet 3.1.3)
- Tizen framework DLLs pulled from the TV: `Tizen.dll` and
  `Tizen.Applications.Common.dll` from `/usr/share/dotnet.tizen/framework/`
- Python 3 + OpenSSL CLI (for staging artifacts)

### Steps

```sh
# 1. Set the framework DLL path.
export TV_FRAMEWORK_DIR=/path/to/dotnet.tizen/framework

# 2. Build the agent (framework-dependent, no self-contained runtime).
cd BootAgent
dotnet publish -c Release --no-self-contained -o publish

# 3. Build the staging artifacts (keypair, signed tarball, passwd view).
cd ..
python3 staging/build.py
```

The CI workflow (`.github/workflows/boot-agent.yaml`) automates this with
stub Tizen DLLs and produces a `boot-agent.zip` release artifact.

## Deploying

After building, you need root on the TV (via the normal tethered route)
to stage everything:

```sh
# Connect via SDB or tizen-ssh.

# 1. Stage chain artifacts into the squatted app's res/ dir.
APP=/opt/usr/apps/com.samsung.tv.ghservice
mkdir -p $APP/res/selfroot
scp staging/out/public.pem $APP/res/selfroot/
scp staging/out/passwd $APP/res/selfroot/
scp staging/out/archive-root-*.tar.gz $APP/res/selfroot/
scp staging/out/archive-root-*.tar.gz.signature $APP/res/selfroot/

# 2. Replace the app's DLL with the boot agent.
cp BootAgent/publish/com.samsung.tv.ghservice.dll $APP/bin/

# 3. Stage modules.
mkdir -p /opt/usr/share/selfroot/modules
cp -r modules/* /opt/usr/share/selfroot/modules/

# 4. Stage tizen-ssh (for module 02-ssh-service).
mkdir -p /opt/usr/share/selfroot/ssh
cp ../tizen-ssh/stage/* /opt/usr/share/selfroot/ssh/

# 5. Set on-boot flag in the package DB (if not already set).
sqlite3 /opt/dbspace/.pkgmgr_parser.db \
  "UPDATE package_app_info SET app_onboot='true' \
   WHERE app_id='com.samsung.tv.ghservice';"

# 6. Set Developer Mode Host PC IP to 127.0.0.1 (TV settings).

# 7. Reboot.
reboot
```

## Modules

Boot modules live at `/opt/usr/share/selfroot/modules/<id>/` and run in
alphabetical order as root at every boot. Each module directory contains:

| File          | Purpose                                          |
|---------------|--------------------------------------------------|
| `module.json` | Metadata (id, name, version, description)        |
| `boot.sh`     | Executed via `cat boot.sh \| bash` (UEP-safe)    |
| `disabled`    | Touch this file to skip the module without removing it |

### Included modules

| Module | Description |
|--------|-------------|
| `00-canary` | Proof-of-concept — writes a canary file to confirm the runner works |
| `01-telemetry-off` | Masks ad/telemetry daemons (adagent, pisa, canalysis, etc.) |
| `02-ssh-service` | Launches [tizen-ssh](../tizen-ssh/) as a supervised systemd service |
| `03-bridge-service` | Token-gated SDB bridge relay on port 26103 |
| `04-sw-update-off` | Blocks firmware OTA and app background updates |

### Writing a custom module

```sh
mkdir -p /opt/usr/share/selfroot/modules/99-my-module
cat > /opt/usr/share/selfroot/modules/99-my-module/module.json <<'EOF'
{"id":"99-my-module","name":"My module","version":"1.0.0",
 "description":"Does something useful at boot.","scripts":{"boot":"boot.sh"}}
EOF
cat > /opt/usr/share/selfroot/modules/99-my-module/boot.sh <<'EOF'
#!/bin/sh
echo "hello from my module at $(date)"
EOF
```

The module runner exports `MODULE_DIR` (absolute path to the module) and
`EVIDENCE` (path to the evidence log directory) as environment variables.

## Platform notes

- **UEP (Unsigned Execution Prevention):** The kernel blocks `exec()` of
  unsigned ELF binaries. Managed IL run via `/usr/bin/dotnet` is unaffected.
  Shell scripts must be piped via stdin (`cat script | bash`), not executed
  as files (`bash script`).
- **SELP:** Path-based execution policy. A copy of `/usr/bin/dotnet` from
  a non-Samsung path refuses to run. Only the original paths work.
- **SMACK:** The pooled app runs as `User::Pkg::com.samsung.tv.ghservice`
  with empty effective caps but full bounding set and `NoNewPrivs: 0`.
  It cannot exec capped dotnet directly — the sdbd route (System label)
  is required.
- **Systemd units:** Modules write to `/run/systemd/system/` (tmpfs).
  Units are rewritten at every boot and do not survive a reboot on their
  own — they don't need to, because the module runner recreates them.
- **Evidence directory:** Pre-created by the launch script with
  `User::App::Shared` SMACK labels so the agent (User::Pkg::*) can append
  to log files. Located at `/home/owner/share/tmp/sdk_tools/selfroot-evidence/`.

## Safety

- **Safe mode:** Touch `/opt/usr/share/selfroot/safemode` to prevent the
  agent from running the chain. The agent exits cleanly.
- **Module disable:** Touch `disabled` in any module directory to skip it.
- **Recovery:** If something goes wrong, connect via tethered SDB and
  remove the agent DLL or the on-boot DB flag.

## License

Same as the parent repository.
