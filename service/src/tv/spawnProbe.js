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
const TIMEOUT = 3000;
// After kill we wait this long for 'close' or 'exit'; some Node builds on constrained runtimes do
// not fire the usual signals, so eventually we give up and report what we have.
const GRACE = 500;

const safeImport = () => {
    try {
        return { module: require('child_process'), threw: null };
    } catch (err) {
        return { module: null, threw: (err && (err.code || err.message)) || String(err) };
    }
};

const tryOne = (shell, cp, note) => new Promise((resolve) => {
    const start = Date.now();
    let child;
    let out = '';
    let err = '';
    let truncated = false;
    let done = false;
    let timer = null;
    let graceTimer = null;
    const events = [];

    const finish = (exitCode, signal, spawnError) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        if (graceTimer) clearTimeout(graceTimer);
        resolve({
            shell,
            ok: !spawnError && exitCode === 0,
            exitCode,
            signal,
            durationMs: Date.now() - start,
            stdout: out,
            stderr: err,
            truncated,
            spawnError: spawnError && ((spawnError.code || spawnError.message) || String(spawnError)),
            events
        });
    };

    try {
        child = cp.spawn(shell, ['-c', SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (synchronous) {
        events.push('spawn-threw');
        return finish(null, null, synchronous);
    }

    note(`spawn ${shell}: pid=${child.pid || 'none'}`);
    events.push(`spawn-returned pid=${child.pid || 'none'}`);

    const take = (which) => (chunk) => {
        if (done || truncated) return;
        const room = CAP - out.length - err.length;
        if (chunk.length > room) {
            chunk = chunk.slice(0, Math.max(0, room));
            truncated = true;
        }
        if (which === 'out') out += chunk; else err += chunk;
    };

    if (child.stdin) {
        child.stdin.on('error', () => { /* a closed-early stdin is normal */ });
        try { child.stdin.end(); } catch (e) { /* ignored */ }
    }
    if (child.stdout) child.stdout.on('data', take('out'));
    if (child.stderr) child.stderr.on('data', take('err'));

    child.on('spawn', () => { events.push('spawn-event'); });
    child.on('error', (e) => { events.push(`error ${e.code || e.message}`); finish(null, null, e); });
    child.on('exit', (code, signal) => { events.push(`exit ${code}/${signal}`); finish(code, signal, null); });
    child.on('close', (code, signal) => { events.push(`close ${code}/${signal}`); finish(code, signal, null); });

    timer = setTimeout(() => {
        if (done) return;
        events.push('timeout-kill');
        try { child.kill('SIGKILL'); } catch (e) { events.push(`kill-threw ${e.code || e.message}`); }
        graceTimer = setTimeout(() => {
            if (done) return;
            events.push('grace-expired');
            finish(null, 'TIMEOUT', null);
        }, GRACE);
    }, TIMEOUT);
});

const run = async (log) => {
    const say = log && typeof log === 'function' ? log : () => {};
    say('spawnProbe: starting');

    const nodeVersion = typeof process !== 'undefined' && process.versions && process.versions.node;
    const imported = safeImport();
    say(`spawnProbe: require('child_process') ${imported.module ? 'ok' : 'threw ' + imported.threw}`);

    if (!imported.module) {
        return {
            when: new Date().toISOString(),
            node: nodeVersion || null,
            moduleUnavailable: imported.threw,
            attempts: []
        };
    }

    const attempts = [];
    for (const shell of CANDIDATES) {
        say(`spawnProbe: trying ${shell}`);
        const result = await tryOne(shell, imported.module, say);
        say(`spawnProbe: ${shell} -> ok=${result.ok} exit=${result.exitCode} ` +
            `events=[${(result.events || []).join(', ')}]`);
        attempts.push(result);
        if (result.ok) break;
    }

    say('spawnProbe: done');
    return {
        when: new Date().toISOString(),
        node: nodeVersion || null,
        attempts
    };
};

module.exports = { run, CANDIDATES };
