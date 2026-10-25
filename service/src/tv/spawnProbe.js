'use strict';

// This started life as a spawn probe, but calling child_process.spawn on the TV takes the whole
// WAS Node runtime down — likely a Smack/integrity signal the exec path can't translate into a
// JavaScript exception. So the probe no longer touches child_process; what it reports instead is
// everything else a shell would be useful for: who the service's user is, what Smack label it
// wears, what is writable, where /bin/sh and friends sit on disk. All read-only Node, no fork.

const { readFileSync, readdirSync, readlinkSync, statSync, accessSync, writeFileSync, unlinkSync, constants } = require('fs');
const { resolve } = require('path');

const CAP = 32 * 1024;

const INTERESTING_ENV = ['HOME', 'PATH', 'TMPDIR', 'TMP', 'USER', 'LOGNAME', 'PWD', 'LANG', 'LC_ALL'];

const PATHS = [
    '/', '/bin', '/sbin', '/usr', '/usr/bin', '/usr/sbin',
    '/etc', '/tmp', '/var', '/var/tmp',
    '/opt', '/opt/usr', '/opt/share', '/opt/home',
    '/home', '/home/owner', '/home/sdk',
    '/mnt', '/mnt/opt', '/sdcard', '/dev', '/proc', '/sys', '/run',
    '/system'
];

const SHELL_CANDIDATES = [
    '/bin/sh', '/bin/bash', '/bin/ash', '/bin/busybox', '/bin/dash',
    '/usr/bin/sh', '/usr/bin/bash', '/usr/bin/busybox',
    '/system/bin/sh'
];

const peek = (path, bytes) => {
    try {
        const data = readFileSync(path, { encoding: 'utf8' });
        return bytes && data.length > bytes ? data.slice(0, bytes) + '…' : data;
    } catch (err) {
        return { error: (err && (err.code || err.message)) || String(err) };
    }
};

const canI = (path, mode, modeName) => {
    try {
        accessSync(path, mode);
        return `yes (${modeName})`;
    } catch (err) {
        return `${modeName} denied: ${(err && err.code) || err.message}`;
    }
};

const describePath = (path) => {
    let info;
    try {
        info = statSync(path);
    } catch (err) {
        return { path, error: (err && (err.code || err.message)) || String(err) };
    }

    const kind = info.isDirectory() ? 'dir'
        : info.isSymbolicLink() ? 'link'
            : info.isFile() ? 'file'
                : info.isBlockDevice() ? 'blk'
                    : info.isCharacterDevice() ? 'chr'
                        : info.isFIFO() ? 'fifo'
                            : info.isSocket() ? 'sock'
                                : 'other';

    const row = {
        path,
        kind,
        mode: '0' + (info.mode & 0o7777).toString(8),
        uid: info.uid,
        gid: info.gid,
        size: info.size
    };

    if (kind === 'dir') {
        row.read = canI(path, constants.R_OK, 'R');
        row.write = canI(path, constants.W_OK, 'W');
        row.execute = canI(path, constants.X_OK, 'X');

        try {
            const entries = readdirSync(path, { withFileTypes: true });
            row.children = entries.length;
            row.sampleChildren = entries.slice(0, 20).map((entry) => entry.name).join(', ');
        } catch (err) {
            row.readError = (err && (err.code || err.message)) || String(err);
        }
    }

    if (kind === 'link') {
        try {
            row.linkTarget = readlinkSync(path);
        } catch (err) {
            row.linkError = (err && (err.code || err.message)) || String(err);
        }
    }

    return row;
};

const describeShell = (path) => {
    const row = describePath(path);
    row.readable = canI(path, constants.R_OK, 'R');
    row.executable = canI(path, constants.X_OK, 'X');
    return row;
};

const run = async (log) => {
    const say = typeof log === 'function' ? log : () => {};
    say('envReport: gathering');

    const pr = typeof process !== 'undefined' ? process : {};
    const env = pr.env || {};
    const versions = pr.versions || {};

    const envFiltered = {};
    INTERESTING_ENV.forEach((key) => {
        if (env[key] !== undefined) envFiltered[key] = env[key];
    });

    const identity = {
        pid: pr.pid,
        ppid: pr.ppid,
        uid: typeof pr.getuid === 'function' ? pr.getuid() : null,
        gid: typeof pr.getgid === 'function' ? pr.getgid() : null,
        groups: typeof pr.getgroups === 'function' ? (() => {
            try { return pr.getgroups(); } catch (err) { return { error: err.code || err.message }; }
        })() : null,
        euid: typeof pr.geteuid === 'function' ? pr.geteuid() : null,
        egid: typeof pr.getegid === 'function' ? pr.getegid() : null,
        cwd: (() => { try { return pr.cwd(); } catch (err) { return { error: err.code || err.message }; } })()
    };

    const procSelf = {
        status: peek('/proc/self/status', CAP),
        attrCurrent: peek('/proc/self/attr/current', 256),
        attrExec: peek('/proc/self/attr/exec', 256),
        loginuid: peek('/proc/self/loginuid', 32),
        mountinfo: peek('/proc/self/mountinfo', CAP),
        limits: peek('/proc/self/limits', CAP)
    };

    const osRelease = peek('/etc/os-release', 2048);
    const tizenInfo = peek('/etc/tizen-platform.conf', CAP);

    const paths = PATHS.map(describePath);
    const shells = SHELL_CANDIDATES.map(describeShell);

    // Writing probes: try to touch a per-path test file. We delete immediately. If creation fails
    // or deletion fails, we report both. These are the directories most likely to be writable by
    // whatever user the service runs as.
    const writeTargets = ['/tmp', '/opt/usr', '/opt/share', '/opt/home', '/home/owner', '/home/owner/share',
        '/home/owner/share/tmp', '/home/owner/data', pr.cwd && typeof pr.cwd === 'function' ? (() => {
            try { return pr.cwd(); } catch (err) { return null; }
        })() : null].filter(Boolean);

    const writes = writeTargets.map((dir) => {
        const stamp = `.homebrew-env-probe-${pr.pid}-${Date.now()}`;
        const file = resolve(dir, stamp);
        try {
            writeFileSync(file, 'probe\n');
            try {
                unlinkSync(file);
                return { dir, writable: true };
            } catch (err) {
                return { dir, writable: true, cleanupError: (err && (err.code || err.message)) || String(err) };
            }
        } catch (err) {
            return { dir, writable: false, error: (err && (err.code || err.message)) || String(err) };
        }
    });

    say('envReport: done');

    return {
        when: new Date().toISOString(),
        node: versions.node || null,
        platform: pr.platform || null,
        arch: pr.arch || null,
        identity,
        env: envFiltered,
        procSelf,
        osRelease,
        tizenInfo,
        paths,
        shells,
        writes,
        // Backwards-compat with the UI: pretend we performed no spawn attempts and no module failure.
        attempts: [],
        kind: 'envReport'
    };
};

module.exports = { run };
