'use strict';

// sdbd admits one address, its developer host IP, and once that is 127.0.0.1 no computer can reach it.
// This lets one named computer in again without that setting changing and the TV restarting.
//
// It cannot simply forward bytes: sdbd holds one transport per host, and the service already holds
// it (the device sweep keeps it open), so a second connection from 127.0.0.1 is closed unanswered.
// So the proxy answers the computer's CNXN itself, with what sdbd told the service, and carries each
// of the computer's streams over the service's own connection, renumbered there and back. Flow
// control stays end to end: every OKAY is the far end's, forwarded, never invented here.
//
// It unlocks nothing sdbd refuses; its command allowlist applies exactly as before.

const net = require('net');

const adb = require('./adb.js');
const sdb = require('./sdb.js');

const { COMMANDS, HEADER_BYTES, encodePacket } = adb;

const DEFAULT_PORT = 26102;
// A computer that connects and says nothing is not kept waiting on a socket forever.
const HANDSHAKE_TIMEOUT = 10000;
// sdb pings an idle transport rarely; a dead peer still has to be noticed.
const KEEPALIVE_MS = 30000;
// A CNXN banner is short; anything longer before the handshake is not sdb.
const MAX_HANDSHAKE_PAYLOAD = 64 * 1024;

const NAMES = Object.keys(COMMANDS).reduce((all, name) => Object.assign(all, { [COMMANDS[name]]: name }), {});

// `::ffff:192.168.1.20` is how Node reports an IPv4 client on a dual-stack listener.
const plainAddress = (address) => String(address || '').replace(/^::ffff:/, '');

function SdbProxy(options) {
    const opts = options || {};

    this.port = opts.port || DEFAULT_PORT;
    // Passed to sdb.withSession, so tests can point the shared connection at a stand-in daemon.
    this.session = Object.assign({}, opts.session || {});
    this.sdb = opts.sdb || sdb;
    this.handshakeTimeout = opts.handshakeTimeout || HANDSHAKE_TIMEOUT;
    this.log = opts.log || { info: () => {}, warn: () => {}, err: () => {} };
    this.onChange = opts.onChange || function () {};

    this.enabled = false;
    this.allowedHost = null;
    this.error = null;

    this._server = null;
    this._pairs = new Set();
}

// One concrete address. 0.0.0.0 would read as "anyone"; loopback is harmless, since anything on the TV
// can reach sdbd directly already.
SdbProxy.isAllowedHost = (value) => typeof value === 'string' && net.isIPv4(value) && value !== '0.0.0.0';

SdbProxy.prototype.state = function () {
    return {
        enabled: this.enabled,
        allowedHost: this.allowedHost,
        port: this.port,
        clients: this._pairs.size,
        error: this.error
    };
};

SdbProxy.prototype._changed = function () {
    try { this.onChange(this.state()); } catch (e) { /* a listener's fault is not the proxy's */ }
};

// Resolves with the state once the port is listening or closed, so the UI shows the truth.
SdbProxy.prototype.setEnabled = function (enabled, allowedHost) {
    if (!enabled) return this._stop('turned off').then(() => this.state());

    if (!SdbProxy.isAllowedHost(allowedHost)) {
        return Promise.reject(Object.assign(new Error(
            'The sdb proxy needs the IPv4 address of the one computer allowed through, ' +
            'such as 192.168.1.20.'), { code: 'proxyBadHost' }));
    }

    const changedHost = this.allowedHost !== allowedHost;

    this.allowedHost = allowedHost;

    // A different computer drops whoever the previous one had connected.
    if (changedHost) this._dropAll(`only ${allowedHost} is allowed now`);

    if (this._server) {
        this.log.warn(`sdb proxy now admits ${allowedHost} only`);
        this._changed();
        return Promise.resolve(this.state());
    }

    return this._start().then(() => this.state());
};

SdbProxy.prototype._start = function () {
    const server = net.createServer((client) => this._accept(client));

    this._server = server;

    return new Promise((resolve, reject) => {
        const failed = (error) => {
            this._server = null;
            this.enabled = false;
            this.error = error.code === 'EADDRINUSE'
                ? `port ${this.port} is already taken by something else on the TV`
                : `cannot listen on ${this.port}: ${error.message}`;
            this.log.err(`sdb proxy ${this.error}`);
            this._changed();
            reject(Object.assign(new Error(`The sdb proxy could not start: ${this.error}.`), { code: 'proxyFailed' }));
        };

        server.once('error', failed);

        server.listen(this.port, '0.0.0.0', () => {
            server.removeListener('error', failed);
            // Later errors (rare once bound) are logged rather than left to crash the service.
            server.on('error', (error) => this.log.err(`sdb proxy listener: ${error.message}`));

            this.enabled = true;
            this.error = null;
            this.log.warn(`sdb proxy ON: ${this.allowedHost} may reach sdbd at <tv-ip>:${this.port}`);
            this._changed();
            resolve();
        });
    });
};

SdbProxy.prototype._stop = function (why) {
    const server = this._server;

    this._server = null;
    this._dropAll(why);

    if (!server) {
        this.enabled = false;
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        server.close(() => resolve());
    }).then(() => {
        this.enabled = false;
        this.log.info(`sdb proxy off (${why})`);
        this._changed();
    });
};

SdbProxy.prototype._dropAll = function (why) {
    if (this._pairs.size === 0) return;

    this.log.info(`sdb proxy closing ${this._pairs.size} connection(s): ${why}`);
    Array.from(this._pairs).forEach((pair) => pair.close(why));
};

SdbProxy.prototype._accept = function (client) {
    const from = plainAddress(client.remoteAddress);

    client.on('error', () => { /* reported through close below */ });

    if (!this.enabled || from !== this.allowedHost) {
        this.log.warn(`sdb proxy refused ${from || 'an unknown address'}: only ${this.allowedHost} is allowed`);
        client.destroy();
        return;
    }

    const bridge = new Bridge(this, client, from);

    this._pairs.add(bridge);
    this.log.info(`sdb proxy ${from} connected; waiting for its handshake`);
    this._changed();
};

// One computer's ADB session, carried over the service's connection to sdbd.
function Bridge(proxy, client, from) {
    this.proxy = proxy;
    this.client = client;
    this.from = from;
    this.startedAt = Date.now();
    this.toTv = 0;
    this.fromTv = 0;
    this.streams = new Map(); // the computer's local id -> { tunnel, pcId }
    this.connection = null;    // the service's AdbConnection, once its session is held
    this.queue = [];           // what arrives while that session is being acquired
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.handshook = false;
    this.release = null;

    client.setNoDelay(true);
    if (client.setKeepAlive) client.setKeepAlive(true, KEEPALIVE_MS);

    this.timer = setTimeout(() => this.close('it never sent an sdb handshake'), proxy.handshakeTimeout);

    client.on('data', (chunk) => this.receive(chunk));
    client.on('close', () => this.close('it hung up'));
}

Bridge.prototype.sendToClient = function (command, arg1, arg2, data) {
    if (this.closed) return;
    const packet = encodePacket(command, arg1, arg2, data || null);
    this.fromTv += packet.length;
    this.client.write(packet);
};

Bridge.prototype.receive = function (chunk) {
    this.toTv += chunk.length;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;

    while (!this.closed && this.buffer.length >= HEADER_BYTES) {
        const header = adb.decodeHeader(this.buffer.slice(0, HEADER_BYTES));
        const limit = this.connection ? this.connection.maxPayload() : MAX_HANDSHAKE_PAYLOAD;

        if (header.magic !== ((header.command ^ 0xFFFFFFFF) >>> 0)) {
            return this.close('it sent something that is not sdb (bad packet magic)');
        }
        if (header.dataLength > limit) {
            return this.close(`it sent ${header.dataLength} bytes in one packet, past the ${limit} sdbd agreed`);
        }
        if (this.buffer.length < HEADER_BYTES + header.dataLength) return;

        header.data = this.buffer.slice(HEADER_BYTES, HEADER_BYTES + header.dataLength);
        this.buffer = this.buffer.slice(HEADER_BYTES + header.dataLength);

        if (this.connection) this.handle(header);
        else this.queue.push(header);

        if (header.command === COMMANDS.CNXN && !this.handshook && !this.release) this.attach(header);
    }
};

// Holds the service's session for as long as the computer stays, so the idle timer cannot close it.
Bridge.prototype.attach = function (cnxn) {
    const proxy = this.proxy;
    const options = Object.assign({ log: () => {} }, proxy.session);

    this.release = () => {};

    proxy.sdb.withSession(options, (session) => new Promise((resolve) => {
        if (this.closed) return resolve();

        this.release = resolve;
        this.connection = session._client;
        clearTimeout(this.timer);

        // A transport that dies with no stream open has nobody to tell; the socket itself does.
        const socket = this.connection._socket;
        if (!socket || socket.destroyed) return this.close('the service lost its connection to sdbd');
        socket.once('close', () => this.close('the service lost its connection to sdbd'));

        const peer = this.connection.peer();

        this.handshook = true;
        this.sendToClient(COMMANDS.CNXN, peer.version || cnxn.arg1, peer.maxPayload, peer.banner);
        proxy.log.info(`sdb proxy ${this.from} handshake done (sdb ${hex(cnxn.arg1)} ⇄ sdbd ` +
            `${hex(peer.version)}, ${peer.maxPayload}-byte packets)`);

        const queued = this.queue;
        this.queue = [];
        queued.forEach((packet) => this.handle(packet));
    })).catch((error) => {
        proxy.log.err(`sdb proxy cannot reach sdbd for ${this.from}: ${error.message}`);
        this.close('sdbd could not be reached');
    });
};

Bridge.prototype.handle = function (packet) {
    const connection = this.connection;
    const entry = this.streams.get(packet.arg1);

    switch (packet.command) {
        case COMMANDS.CNXN:
            return; // answered in attach; a repeat changes nothing here

        case COMMANDS.OPEN: {
            if (entry) return;
            const pcId = packet.arg1;
            const service = String(packet.data || '').replace(/\0+$/, '');
            const tunnel = connection.openTunnel(packet.data,
                (reply) => this.fromSdbd(pcId, reply),
                () => this.close('the service lost its connection to sdbd'));
            this.streams.set(pcId, { tunnel, pcId });
            this.proxy.log.info(`sdb proxy ${this.from} opened ${service.slice(0, 120)}`);
            return;
        }

        case COMMANDS.OKAY:
            if (entry) connection.sendTunnel(entry.tunnel, COMMANDS.OKAY, packet.arg2);
            return;

        case COMMANDS.WRTE:
            if (entry) connection.sendTunnel(entry.tunnel, COMMANDS.WRTE, packet.arg2, packet.data);
            return;

        case COMMANDS.CLSE:
            if (!entry) return;
            this.streams.delete(packet.arg1);
            connection.sendTunnel(entry.tunnel, COMMANDS.CLSE,
                packet.arg2 || (entry.tunnel.remoteId === -1 ? 0 : entry.tunnel.remoteId));
            return;

        default:
            // SYNC and AUTH from a host mean nothing to sdbd mid-session; nothing is forwarded blind.
            this.proxy.log.info(`sdb proxy ignored ${NAMES[packet.command] || hex(packet.command)} from ${this.from}`);
    }
};

// sdbd's answer on a tunnel, renumbered for the computer.
Bridge.prototype.fromSdbd = function (pcId, packet) {
    if (packet.command === COMMANDS.CLSE) this.streams.delete(pcId);
    this.sendToClient(packet.command, packet.arg1, pcId, packet.data);
};

Bridge.prototype.close = function (why) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);

    if (this.connection) this.streams.forEach((entry) => this.connection.closeTunnel(entry.tunnel));
    this.streams.clear();

    this.client.destroy();
    if (this.release) this.release();

    const proxy = this.proxy;
    proxy._pairs.delete(this);

    const seconds = Math.round((Date.now() - this.startedAt) / 1000);
    proxy.log.info(`sdb proxy ${this.from} disconnected after ${seconds}s, ${why} ` +
        `(${this.toTv} bytes from it, ${this.fromTv} back)`);
    proxy._changed();
};

const hex = (value) => `0x${((value || 0) >>> 0).toString(16)}`;

SdbProxy.prototype.close = function () {
    return this._stop('the service is stopping');
};

module.exports = { SdbProxy, DEFAULT_PORT, plainAddress };
