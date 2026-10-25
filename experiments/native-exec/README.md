# native-exec experiment

Does a native ARMv7 binary run on a retail Samsung Tizen TV when installed as a
Partner-signed service application?

The TV's kernel refuses to `exec()` any ELF whose signature it does not accept.
A spawn from inside tizen-homebrew's service crashes the whole runtime, so we
can't test the kernel verifier from in-service. This experiment goes the long
way round: a tiny C program, cross-compiled, packaged as an unsigned `.tpk`,
installed through tizen-homebrew (which re-signs with the stored Partner pair),
then launched by hand. If the binary runs, native exec is on. If it refuses,
the error tells us which gate said no.

## What's here

| File | Why |
| --- | --- |
| `src/hello.c` | Trivial ARMv7 Linux binary; writes one line to a file and to stdout, then exits 0. |
| `tizen-manifest.xml` | Minimal `service-application` manifest with `type="capp"`, no privileges, no on-boot. |
| `build.sh` | Cross-compiles with `arm-linux-gnueabihf-gcc` (or a musl variant if installed) and zips the `.tpk`. |

Nothing in the `.tpk` is signed. tizen-homebrew signs on install.

## Running the experiment

1. **Build.** Push to the branch and the `native-exec experiment` workflow
   produces a draft release carrying `org.homebrew.nativeexec-0.1.0.tpk`.
   Local build also works if `gcc-arm-linux-gnueabihf` is installed:

   ```sh
   experiments/native-exec/build.sh
   ```

2. **Install.** Download the `.tpk` from the draft release page, upload it to
   tizen-homebrew the same way as a `.wgt`. The installer re-signs with your
   stored Partner certificate before dispatching to `vd_appinstall`.

3. **Launch.** From an sdb shell on the TV (via the proxy or SVE path):

   ```sh
   sdb shell 0 was_execute org.homebrew.nativeexec.hello
   ```

   `was_execute` is the launcher the retail sdbd allowlist exposes. If the TV
   has a `/usr/bin/app_launcher` or similar reachable, use that instead.

4. **Check for output.**

   ```sh
   sdb shell 0 shell:0 cat /home/owner/share/native-exec-test.log
   ```

   (Yes, the exact path depends on how the service's uid is mapped; the service
   probe said `/home/owner/share` is writable to uid 5001.) If the file exists
   with a `native-exec: ran OK` line in it, the binary ran. If the file is
   missing but no error surfaces anywhere, Smack probably ate the write — exec
   worked, but the running process couldn't open the file. Either way, exec
   worked. If the launch itself fails with `[Verification fail]` or a signature
   error, that's the kernel verifier refusing — Partner tier isn't enough on
   this firmware.

## What each result means

- **File written.** Native exec is on. The follow-up is to add network and
  filesystem privileges to the manifest and try dropbear.
- **File missing, process exits 0 anyway.** Exec worked, Smack blocked the
  file write. Follow-up: `strace`-style tracing isn't available, but
  requesting the filesystem privilege and re-trying usually fixes this.
- **Launch fails with "not signed" or "signature verification failed".**
  The exec verifier didn't accept this install's signature chain. Partner
  isn't enough, or something in the signing chain the installer uses isn't
  trusted for native exec. Native binaries are out on this TV at this
  firmware level.
- **Launch fails with a different error ("application not found", "cannot
  launch").** The `.tpk` didn't install cleanly. Check the installer output;
  likely a manifest problem.

## Cleaning up

```sh
sdb shell 0 uninstall org.homebrew.nativeexec
```

The log file at `/home/owner/share/native-exec-test.log` (if any) is left
behind on purpose, so you can see later that it did run.
