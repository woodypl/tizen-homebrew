'use strict';

// The sdb proxy against a stand-in sdbd that behaves as a retail set does: one transport at a time,
// with a second connection closed before a byte is answered. The service holds that one transport
// (its device sweep does on a TV), so the computer has to be carried over it, and both have to work
// at once. The computer side is this repository's own ADB client, pointed at the proxy.

const net = require('net');

const adb = require('../src/tv/adb.js');
const sdb = require('../src/tv/sdb.js');
const { SdbProxy } = require('../src/tv/proxy.js');

const { COMMANDS, HEADER_BYTES, encodePacket } = adb;

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
};

const quiet = { info: () => {}, warn: () => {}, err: () => {} };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DUID = 'CPCLIM2YRW7DO';
const BANNER = 'device::ro.product.name=fake;';

const freePort = () => new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
    });
});

// One transport at a time; services: getduid, refused (CLSE before OKAY), echo: (lock-step, both ways).
const fakeSdbd = () => new Promise((resolve) => {
    const stats = { accepted: 0, turnedAway: 0, opens: [] };
    let active = null;
    const sockets = new Set();

    const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on('error', () => {});
        socket.on('close', () => {
            sockets.delete(socket);
            if (active === socket) active = null;
        });

        if (active) {
            stats.turnedAway += 1;
            socket.end();
            return;
        }

        active = socket;
        stats.accepted += 1;

        let buffer = Buffer.alloc(0);
        let nextRemote = 100;
        const echoes = new Map(); // remote id -> { local, pending: [Buffer], inFlight }

        const pump = (remote) => {
            const echo = echoes.get(remote);
            if (!echo || echo.inFlight || echo.pending.length === 0) return;
            echo.inFlight = true;
            socket.write(encodePacket(COMMANDS.WRTE, remote, echo.local, echo.pending.shift()));
        };

        socket.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            while (buffer.length >= HEADER_BYTES && buffer.length >= HEADER_BYTES + buffer.readUInt32LE(12)) {
                const command = buffer.readUInt32LE(0);
                const arg1 = buffer.readUInt32LE(4);
                const arg2 = buffer.readUInt32LE(8);
                const length = buffer.readUInt32LE(12);
                const data = buffer.slice(HEADER_BYTES, HEADER_BYTES + length);
                buffer = buffer.slice(HEADER_BYTES + length);

                if (command === COMMANDS.CNXN) {
                    socket.write(encodePacket(COMMANDS.CNXN, 0x01000000, 4096, BANNER));
                } else if (command === COMMANDS.OPEN) {
                    const service = data.toString().replace(/\0$/, '');
                    const remote = nextRemote++;
                    stats.opens.push(service);
                    if (service === 'shell:0 getduid') {
                        socket.write(encodePacket(COMMANDS.OKAY, remote, arg1));
                        socket.write(encodePacket(COMMANDS.WRTE, remote, arg1, Buffer.from(`${DUID}\n`)));
                        socket.write(encodePacket(COMMANDS.CLSE, remote, arg1));
                    } else if (service === 'echo:') {
                        echoes.set(remote, { local: arg1, pending: [], inFlight: false });
                        socket.write(encodePacket(COMMANDS.OKAY, remote, arg1));
                    } else {
                        socket.write(encodePacket(COMMANDS.CLSE, 0, arg1));
                    }
                } else if (command === COMMANDS.WRTE) {
                    const echo = echoes.get(arg2);
                    if (!echo) continue;
                    socket.write(encodePacket(COMMANDS.OKAY, arg2, arg1));
                    echo.pending.push(Buffer.from(data));
                    pump(arg2);
                } else if (command === COMMANDS.OKAY) {
                    const echo = echoes.get(arg2);
                    if (echo) {
                        echo.inFlight = false;
                        pump(arg2);
                    }
                } else if (command === COMMANDS.CLSE) {
                    echoes.delete(arg2);
                }
            }
        });
    });

    server.listen(0, '127.0.0.1', () => resolve({
        port: server.address().port,
        stats,
        kill: () => sockets.forEach((socket) => socket.destroy()),
        close: () => new Promise((done) => {
            sockets.forEach((socket) => socket.destroy());
            server.close(() => done());
        })
    }));
});

// The computer: an ADB host connection to the proxy, resolved on its handshake.
const computer = (port) => new Promise((resolve, reject) => {
    const connection = adb.createConnection({ host: '127.0.0.1', port });
    const timer = setTimeout(() => reject(new Error('no handshake from the proxy')), 3000);
    connection._socket.on('error', (error) => { clearTimeout(timer); reject(error); });
    connection._socket.on('close', () => { clearTimeout(timer); reject(new Error('closed before the handshake')); });
    connection.on('connect', () => { clearTimeout(timer); resolve(connection); });
});

// One command on the computer's connection: what came back, or why it failed.
const run = (connection, service, input) => new Promise((resolve) => {
    const stream = connection.createStream(service);
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', (error) => resolve({ error: error.code || error.message }));
    stream.on('end', () => resolve({ output: Buffer.concat(chunks) }));
    if (input) {
        stream.write(input, () => setTimeout(() => stream.close(), 300));
    }
});

const echoed = (connection, payload) => new Promise((resolve) => {
    const stream = connection.createStream('echo:');
    const chunks = [];
    let length = 0;
    const timer = setTimeout(() => resolve(Buffer.concat(chunks)), 10000);
    stream.on('data', (chunk) => {
        chunks.push(chunk);
        length += chunk.length;
        if (length >= payload.length) {
            clearTimeout(timer);
            stream.close();
            resolve(Buffer.concat(chunks));
        }
    });
    stream.write(payload);
});

const hangsUp = (port, bytes) => new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    let got = 0;
    socket.on('error', () => {});
    socket.on('connect', () => { if (bytes) socket.write(bytes); });
    socket.on('data', (chunk) => { got += chunk.length; });
    socket.on('close', () => resolve({ closed: true, got }));
    setTimeout(() => { socket.destroy(); resolve({ closed: false, got }); }, 2500);
});

(async () => {
    const daemon = await fakeSdbd();
    const port = await freePort();
    const session = { port: daemon.port, timeout: 2000, attempts: 1 };
    const proxy = new SdbProxy({ port, session, log: quiet, handshakeTimeout: 500 });

    // The stand-in reproduces the set: the service's transport held, a second one turned away.
    const appDuid = await sdb.withSession(session, (s) => s.getDuid());
    const direct = await hangsUp(daemon.port, encodePacket(COMMANDS.CNXN, 0x01000000, 4096, 'host::'));
    check('the stand-in turns away a second transport, as the set does',
        appDuid === DUID && direct.closed && direct.got === 0 && daemon.stats.turnedAway === 1,
        `duid=${appDuid} closed=${direct.closed} got=${direct.got}`);

    check('the proxy is off unless explicitly enabled', proxy.enabled === false, JSON.stringify(proxy.state()));

    for (const bad of [undefined, '', 'tv.local', '0.0.0.0', '192.168.1', '2001:db8::1']) {
        const outcome = await proxy.setEnabled(true, bad).then(() => 'started', (error) => error.code);
        check(`refuses ${JSON.stringify(bad)} as the allowed computer`, outcome === 'proxyBadHost', outcome);
    }

    const offline = await hangsUp(port);
    check('nothing listens while it is off', offline.closed && offline.got === 0, JSON.stringify(offline));

    await proxy.setEnabled(true, '127.0.0.1');

    // The computer's handshake is answered with sdbd's own banner, over the one transport.
    const pc = await computer(port).catch((error) => error);
    check('the computer completes a handshake through the proxy', !(pc instanceof Error),
        pc instanceof Error ? pc.message : '');
    if (pc instanceof Error) process.exit(1);

    check('the computer is given sdbd\'s banner and packet size',
        pc._banner.join(':').indexOf('ro.product.name=fake') !== -1 && pc.maxPayload() === 4096,
        `${pc._banner.join(':')} / ${pc.maxPayload()}`);

    const fromPc = await run(pc, 'shell:0 getduid');
    check('a command from the computer runs', fromPc.output && fromPc.output.toString() === `${DUID}\n`,
        JSON.stringify(fromPc));
    check('sdbd still saw only one transport', daemon.stats.accepted === 1 && daemon.stats.turnedAway === 1,
        JSON.stringify(daemon.stats));

    // Both at once: the service's own command and the computer's, interleaved on one transport.
    const [mine, theirs] = await Promise.all([
        sdb.withSession(session, (s) => s.getDuid()),
        run(pc, 'shell:0 getduid')
    ]);
    check('the service and the computer work at the same time',
        mine === DUID && theirs.output && theirs.output.toString() === `${DUID}\n`,
        `service=${mine} computer=${JSON.stringify(theirs)}`);

    const refused = await run(pc, 'shell:0 ls /');
    check('a command sdbd refuses reaches the computer as a refusal', refused.error === 'ESDBREFUSED',
        JSON.stringify(refused));

    // A megabyte each way, in 4096-byte packets, with every OKAY carried end to end.
    const big = Buffer.alloc(1024 * 1024);
    for (let index = 0; index < big.length; index++) big[index] = (index * 31 + 7) & 0xff;
    const back = await echoed(pc, big);
    check('1 MiB crosses both ways intact, lock-step', back.equals(big), `${back.length} of ${big.length} bytes`);

    check('an open computer is counted', proxy.state().clients === 1, JSON.stringify(proxy.state()));

    // The service's transport outlives the computer.
    pc._socket.destroy();
    await wait(150);
    check('a computer leaving is no longer counted', proxy.state().clients === 0, JSON.stringify(proxy.state()));
    const after = await sdb.withSession(session, (s) => s.getDuid());
    check('the service keeps working after the computer leaves', after === DUID, String(after));

    // Hostile or confused clients are hung up on.
    const silent = await hangsUp(port);
    check('a client that never handshakes is hung up on', silent.closed && silent.got === 0, JSON.stringify(silent));
    const garbage = await hangsUp(port, Buffer.from('GET / HTTP/1.1\r\nHost: tv\r\n\r\n'));
    check('something that is not sdb is hung up on', garbage.closed && garbage.got === 0, JSON.stringify(garbage));

    // Admission.
    const held = await computer(port);
    let heldClosed = false;
    held._socket.on('close', () => { heldClosed = true; });
    await proxy.setEnabled(true, '192.0.2.10');
    await wait(150);
    check('changing the allowed computer drops the previous one', heldClosed, 'it stayed connected');
    const stranger = await hangsUp(port, encodePacket(COMMANDS.CNXN, 0x01000000, 4096, 'host::'));
    check('a computer that is not named is refused', stranger.closed && stranger.got === 0, JSON.stringify(stranger));

    await proxy.setEnabled(true, '127.0.0.1');
    const live = await computer(port);
    let liveClosed = false;
    live._socket.on('close', () => { liveClosed = true; });
    await proxy.setEnabled(false);
    await wait(150);
    check('turning it off drops a connected computer', liveClosed, 'it stayed connected');
    const closedPort = await hangsUp(port);
    check('turning it off closes the port', closedPort.closed && closedPort.got === 0, JSON.stringify(closedPort));

    // The service's transport dying takes the computer with it, rather than leaving it hanging.
    await proxy.setEnabled(true, '127.0.0.1');
    const orphan = await computer(port);
    let orphanClosed = false;
    orphan._socket.on('close', () => { orphanClosed = true; });
    daemon.kill();
    await wait(200);
    check('losing sdbd hangs up on the computer', orphanClosed, 'it stayed connected');

    // sdbd gone altogether: the computer's handshake goes unanswered and it is hung up on.
    await daemon.close();
    sdb.release();
    const noDaemon = await hangsUp(port, encodePacket(COMMANDS.CNXN, 0x01000000, 4096, 'host::'));
    check('with no sdbd the computer is hung up on', noDaemon.closed && noDaemon.got === 0, JSON.stringify(noDaemon));
    await proxy.close();

    const squatter = net.createServer().listen(port, '0.0.0.0');
    await wait(50);
    const taken = new SdbProxy({ port, log: quiet });
    const outcome = await taken.setEnabled(true, '127.0.0.1').then(() => 'started', (error) => error.code);
    check('a taken port is reported, not ignored', outcome === 'proxyFailed' &&
        /already taken/.test(taken.state().error || ''), `${outcome} ${JSON.stringify(taken.state())}`);
    squatter.close();
    sdb.release();

    const failed = results.filter((result) => !result).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed.`);
    process.exit(failed ? 1 : 0);
})().catch((error) => {
    console.error('\nHarness error:', error.stack || error.message);
    process.exit(1);
});
