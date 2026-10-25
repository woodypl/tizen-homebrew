'use strict';

// The sdb proxy against a stand-in sdbd that echoes, on ephemeral ports: what gets in, what is kept out,
// and that bytes cross intact in both directions with backpressure in place.

const net = require('net');

const { SdbProxy } = require('../src/tv/proxy.js');

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  <- ${detail}`}`);
};

const quiet = { info: () => {}, warn: () => {}, err: () => {} };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const freePort = () => new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
    });
});

// Echoes everything and remembers who connected, as sdbd would see them.
const fakeSdbd = () => new Promise((resolve) => {
    const peers = [];
    const sockets = new Set();
    const server = net.createServer((socket) => {
        peers.push(socket.remoteAddress.replace(/^::ffff:/, ''));
        sockets.add(socket);
        socket.on('error', () => {});
        socket.on('close', () => sockets.delete(socket));
        socket.pipe(socket);
    });
    server.listen(0, '127.0.0.1', () => resolve({
        port: server.address().port,
        peers,
        close: () => new Promise((done) => {
            sockets.forEach((socket) => socket.destroy());
            server.close(() => done());
        })
    }));
});

// Connects, sends `payload`, and reports what came back and whether the proxy hung up.
const roundTrip = (port, payload, options) => new Promise((resolve) => {
    const opts = options || {};
    const socket = net.connect(port, '127.0.0.1');
    const received = [];
    let length = 0;
    let settled = false;

    const finish = (closed) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve({ data: Buffer.concat(received), closed, socket });
    };

    socket.on('error', () => finish(true));
    socket.on('close', () => finish(true));
    socket.on('connect', () => { if (payload) socket.write(payload); });
    socket.on('data', (chunk) => {
        received.push(chunk);
        length += chunk.length;
        if (!opts.keep && payload && length >= payload.length) finish(false);
    });
    setTimeout(() => finish(false), opts.timeout || 2000);
});

const connectAndHold = (port) => new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    const held = { socket, closed: false };
    socket.on('error', () => {});
    socket.on('close', () => { held.closed = true; });
    socket.on('connect', () => resolve(held));
});

(async () => {
    const sdbd = await fakeSdbd();
    const port = await freePort();
    const changes = [];
    const proxy = new SdbProxy({ port, targetPort: sdbd.port, log: quiet, onChange: (state) => changes.push(state) });

    check('the proxy is off unless explicitly enabled', proxy.enabled === false && proxy.state().enabled === false,
        JSON.stringify(proxy.state()));

    for (const bad of [undefined, '', 'tv.local', '0.0.0.0', '192.168.1', '2001:db8::1']) {
        const outcome = await proxy.setEnabled(true, bad).then(() => 'started', (error) => error.code);
        check(`refuses ${JSON.stringify(bad)} as the allowed computer`, outcome === 'proxyBadHost', outcome);
    }
    check('a refused address leaves it off', proxy.enabled === false, JSON.stringify(proxy.state()));

    const off = await roundTrip(port, Buffer.from('CNXN'));
    check('nothing listens while it is off', off.closed && off.data.length === 0, `got ${off.data.length} bytes`);

    // Admitted: bytes cross both ways and sdbd sees loopback.
    await proxy.setEnabled(true, '127.0.0.1');
    check('turning it on reports the state', proxy.enabled && changes.length > 0 &&
        changes[changes.length - 1].enabled === true, JSON.stringify(changes));

    const greeting = Buffer.from('CNXN host::\0');
    const admitted = await roundTrip(port, greeting);
    check('an admitted computer reaches sdbd, both ways', admitted.data.equals(greeting),
        JSON.stringify(admitted.data.toString()));
    check('sdbd sees the connection come from 127.0.0.1', sdbd.peers[sdbd.peers.length - 1] === '127.0.0.1',
        JSON.stringify(sdbd.peers));

    // A megabyte in one write: pipe's backpressure has to carry it without loss or reordering.
    const big = Buffer.alloc(1024 * 1024);
    for (let index = 0; index < big.length; index++) big[index] = (index * 31 + 7) & 0xff;
    const bulk = await roundTrip(port, big, { timeout: 8000 });
    check('a 1 MiB transfer arrives intact', bulk.data.equals(big), `${bulk.data.length} of ${big.length} bytes`);

    // Counted while open, and gone once the computer hangs up.
    const open = await connectAndHold(port);
    await wait(100);
    check('an open connection is counted', proxy.state().clients === 1, JSON.stringify(proxy.state()));
    open.socket.destroy();
    await wait(100);
    check('a closed connection is no longer counted', proxy.state().clients === 0, JSON.stringify(proxy.state()));

    // Anyone else is turned away before sdbd hears of them.
    const before = sdbd.peers.length;
    const held = await connectAndHold(port);
    await proxy.setEnabled(true, '192.0.2.10');
    await wait(100);
    check('changing the allowed computer drops the previous one', held.closed, 'the old connection stayed open');
    const stranger = await roundTrip(port, Buffer.from('CNXN'));
    check('a computer that is not named is refused', stranger.closed && stranger.data.length === 0,
        `got ${stranger.data.length} bytes`);
    check('a refused computer never reaches sdbd', sdbd.peers.length === before + 1,
        `sdbd saw ${sdbd.peers.length - before} new connection(s)`);

    // Off again: the port closes and live connections go with it.
    await proxy.setEnabled(true, '127.0.0.1');
    const live = await connectAndHold(port);
    await proxy.setEnabled(false);
    await wait(100);
    check('turning it off drops live connections', live.closed, 'the connection survived');
    const afterOff = await roundTrip(port, Buffer.from('CNXN'));
    check('turning it off closes the port', afterOff.closed && afterOff.data.length === 0,
        `got ${afterOff.data.length} bytes`);

    // sdbd not running: the computer is hung up on rather than left waiting.
    await sdbd.close();
    await proxy.setEnabled(true, '127.0.0.1');
    const noDaemon = await roundTrip(port, Buffer.from('CNXN'), { timeout: 3000 });
    check('with no sdbd the computer is hung up on', noDaemon.closed, 'the connection was left open');
    await proxy.close();

    // The port already taken: a clear error, and the state says so.
    const squatter = net.createServer().listen(port, '0.0.0.0');
    await wait(50);
    const taken = new SdbProxy({ port, log: quiet });
    const outcome = await taken.setEnabled(true, '127.0.0.1').then(() => 'started', (error) => error.code);
    check('a taken port is reported, not ignored', outcome === 'proxyFailed' && taken.enabled === false &&
        /already taken/.test(taken.state().error || ''), `${outcome} ${JSON.stringify(taken.state())}`);
    squatter.close();

    const failed = results.filter((result) => !result).length;
    console.log(`\n${results.length - failed}/${results.length} checks passed.`);
    process.exit(failed ? 1 : 0);
})().catch((error) => {
    console.error('\nHarness error:', error.stack || error.message);
    process.exit(1);
});
