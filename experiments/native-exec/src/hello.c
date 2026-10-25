/*
 * A trivial ARMv7 Linux binary we try to run on a Samsung Tizen TV as a service app.
 *
 * The question the experiment answers is: does a native binary signed and installed
 * through tizen-homebrew's Partner certificate pass the TV's kernel-level exec
 * verifier? Nothing in this program matters except that it exits 0 — the result is
 * decided by whether exec() is allowed at all. The log line is for us: if we see
 * the file written on the TV, the binary ran, which is the headline finding.
 *
 * No dependencies beyond POSIX. Statically linked against musl (ideally) or glibc
 * so the Tizen image's libc version is irrelevant.
 */
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

/*
 * The service's probe said /home/owner/share is writable to uid 5001. A service app
 * installed through pkgmgr runs under its own per-package uid with its own home dir,
 * so this path is a guess that stands or falls with the install's layout. The log
 * line also goes to stdout, in case something is still catching it.
 */
#define LOG_PATH "/home/owner/share/native-exec-test.log"

int main(int argc, char **argv) {
    char line[320];
    time_t now = time(NULL);
    int n = snprintf(line, sizeof(line),
                     "native-exec: ran OK  pid=%d  uid=%u  gid=%u  argv0=%s  epoch=%ld\n",
                     (int)getpid(), (unsigned)getuid(), (unsigned)getgid(),
                     argc > 0 && argv[0] ? argv[0] : "(none)", (long)now);

    int fd = open(LOG_PATH, O_WRONLY | O_CREAT | O_APPEND, 0644);
    if (fd >= 0) {
        (void)write(fd, line, (size_t)n);
        close(fd);
    }

    (void)write(1, line, (size_t)n);
    return 0;
}
