'use strict';

// The probe is now read-only: it gathers who-am-I and what's writable from Node's own fs/process
// APIs, without ever forking. It runs here on the dev machine too — it should always succeed on
// any Linux host, since nothing it does is risky.

const spawnProbe = require('../src/tv/spawnProbe.js');

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
};

(async () => {
    const report = await spawnProbe.run();

    check('report has a timestamp', typeof report.when === 'string' && /T.*Z$/.test(report.when), report.when);
    check('report declares its kind', report.kind === 'envReport', String(report.kind));
    check('report carries the node version', !report.node || /^\d+\.\d+\.\d+/.test(report.node), report.node);
    check('report carries platform and arch', typeof report.platform === 'string', report.platform);

    check('identity has a pid', report.identity && typeof report.identity.pid === 'number', JSON.stringify(report.identity));
    check('identity has a uid on linux', report.platform !== 'linux' || typeof report.identity.uid === 'number',
        JSON.stringify(report.identity));

    check('procSelf.status has at least a Name line', typeof report.procSelf.status === 'string' &&
        /Name:/.test(report.procSelf.status), JSON.stringify(report.procSelf.status).slice(0, 120));

    check('paths is a non-empty array', Array.isArray(report.paths) && report.paths.length > 0, '');
    check('every path entry names its path', report.paths.every((row) => typeof row.path === 'string'), '');
    check('/tmp is reported as a dir', (() => {
        const tmp = report.paths.find((row) => row.path === '/tmp');
        return tmp && (tmp.kind === 'dir' || tmp.kind === 'link');
    })(), JSON.stringify(report.paths.find((row) => row.path === '/tmp')));

    check('shells is a non-empty array', Array.isArray(report.shells) && report.shells.length > 0, '');
    check('/bin/sh is reported (either exists or ENOENT)', (() => {
        const sh = report.shells.find((row) => row.path === '/bin/sh');
        return sh && (sh.kind || sh.error);
    })(), JSON.stringify(report.shells.find((row) => row.path === '/bin/sh')));

    check('writes is an array of attempted directories', Array.isArray(report.writes) && report.writes.length > 0, '');
    check('/tmp should be writable on a dev host', report.writes.some((row) => row.dir === '/tmp' && row.writable),
        JSON.stringify(report.writes.find((row) => row.dir === '/tmp')));
    check('writes leave no trace', report.writes.every((row) => !row.writable || !row.cleanupError),
        JSON.stringify(report.writes.filter((row) => row.cleanupError)));

    check('report keeps a backwards-compat attempts: []', Array.isArray(report.attempts), '');

    const failed = results.filter((r) => !r).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed.`);
    process.exit(failed ? 1 : 0);
})();
