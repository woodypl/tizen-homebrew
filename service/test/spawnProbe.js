'use strict';

// The spawn probe runs here, on the dev machine, exactly as it will on the TV: we don't stub it.
// On any Linux dev host the first candidate (/bin/sh) exists and succeeds, which lets us assert
// the shape of a positive report. The negative-shape case stands in a non-existent shell list.

const spawnProbe = require('../src/tv/spawnProbe.js');

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
};

(async () => {
    const report = await spawnProbe.run();

    check('report has a timestamp', typeof report.when === 'string' && /T.*Z$/.test(report.when), report.when);
    check('report carries the node version', !report.node || /^\d+\.\d+\.\d+/.test(report.node), report.node);
    check('report has at least one attempt', Array.isArray(report.attempts) && report.attempts.length > 0,
        JSON.stringify(report.attempts).slice(0, 160));

    const won = report.attempts.find((attempt) => attempt.ok);
    check('on a Linux host, at least one shell succeeded', !!won,
        JSON.stringify(report.attempts.map((attempt) => ({
            shell: attempt.shell, exitCode: attempt.exitCode, threw: attempt.threw,
            spawnError: attempt.spawnError
        }))));

    if (won) {
        check('a successful attempt names the shell', typeof won.shell === 'string' && won.shell.length > 0, won.shell);
        check('a successful attempt reports exit code 0', won.exitCode === 0, String(won.exitCode));
        check('a successful attempt has stdout', typeof won.stdout === 'string' && won.stdout.length > 0,
            JSON.stringify(won.stdout).slice(0, 100));
        check('a successful attempt reports a duration', typeof won.durationMs === 'number' && won.durationMs >= 0,
            String(won.durationMs));
        check('the probe script ran `id`', /uid=\d+/.test(won.stdout || ''), won.stdout);
        check('the probe script ran `uname`', /=== uname ===/.test(won.stdout || ''), won.stdout);
    }

    // Stops at the first ok, so a successful first candidate means a one-element array; otherwise it
    // walks the list.
    check('the probe stops after the first successful shell',
        !won || report.attempts[report.attempts.length - 1] === won,
        JSON.stringify(report.attempts.map((attempt) => attempt.shell)));

    const failed = results.filter((r) => !r).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed.`);
    process.exit(failed ? 1 : 0);
})();
