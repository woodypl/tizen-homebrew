'use strict';

// Checks what happens if the service runtime tries to run a signed system binary. On retail Tizen,
// the kernel verifies ELF hashes against the signed-install database before `exec()`: an unsigned
// binary never runs, but /bin/sh and friends come from a signed OS install, so they should.
// A yes to this question would let the "shell" tab talk to a real shell on the TV from within the
// service, with no sdbd, no injection, no reliance on an unpatched flaw. A no says why: a thrown
// `spawn` means the Node build has no child_process (unlikely); a non-zero exit or an immediate
// kill with no output usually means Smack blocked the exec; an EACCES on the exec() path, same.

const CANDIDATES = ['/bin/sh', '/bin/bash', '/usr/bin/sh', '/usr/bin/bash'];
const SCRIPT = [
    'echo === id ===',
    'id',
    'echo === uname ===',
    'uname -a',
    'echo === pwd ===',
    'echo "$PWD"',
    'echo === listing /opt/usr ===',
    'ls -la /opt/usr 2>&1 | head -20',
    'echo === done ==='
].join('\n');
const CAP = 64 * 1024;
const TIMEOUT = 5000;

const tryOne = (shell) => new Promise((resolve) => {
    let child;
    try {
        child = require('child_process').spawn(shell, ['-c', SCRIPT], {
            stdio: ['ignore', 'pipe', 'pipe']
        });
    } catch (err) {
        resolve({ shell, ok: false, threw: err && (err.code || err.message) || String(err) });
        return;
    }

    const start = Date.now();
    let out = '';
    let err = '';
    let truncated = false;
    let done = false;

    const take = (which) => (chunk) => {
        if (done || truncated) return;
        const room = CAP - out.length - err.length;
        if (chunk.length > room) {
            chunk = chunk.slice(0, Math.max(0, room));
            truncated = true;
        }
        if (which === 'out') out += chunk; else err += chunk;
    };

    child.stdout.on('data', take('out'));
    child.stderr.on('data', take('err'));

    const timer = setTimeout(() => {
        if (done) return;
        try { child.kill('SIGKILL'); } catch (e) { /* ignored */ }
    }, TIMEOUT);

    const finish = (exitCode, signal, spawnError) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({
            shell,
            ok: !spawnError && exitCode === 0,
            exitCode,
            signal,
            durationMs: Date.now() - start,
            stdout: out,
            stderr: err,
            truncated,
            spawnError: spawnError && (spawnError.code || spawnError.message)
        });
    };

    child.on('error', (e) => finish(null, null, e));
    child.on('close', (code, signal) => finish(code, signal, null));
});

const run = async () => {
    const nodeVersion = typeof process !== 'undefined' && process.versions && process.versions.node;
    const attempts = [];

    for (const shell of CANDIDATES) {
        const result = await tryOne(shell);
        attempts.push(result);
        if (result.ok) break;
    }

    return {
        when: new Date().toISOString(),
        node: nodeVersion || null,
        attempts
    };
};

module.exports = { run, CANDIDATES };
