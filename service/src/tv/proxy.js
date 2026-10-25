'use strict';

// sdbd admits one address, its developer host IP, and once that is 127.0.0.1 no computer can reach it.
// This forwards a second port to it byte for byte, so a connection arrives from 127.0.0.1 and is let in,
// and does the admitting itself: one computer, named in the UI, changeable without restarting the TV.
// It unlocks nothing sdbd refuses; its command allowlist applies exactly as before.

const net = require('net');

const DEFAULT_PORT = 26102;
const SDB_PORT = 26101;
const CONNECT_TIMEOUT = 8000;
// sdb pings an idle transport rarely; a dead peer on either side still has to be noticed.
const KEEPALIVE_MS = 30000;

// `::ffff:192.168.1.20` is how Node reports an IPv4 client on a dual-stack listener.
const plainAddress = (address) => String(address || '').replace(/^::ffff:/, '');

function SdbProxy(options) {
    const opts = options || {};

    this.port = opts.port || DEFAULT_PORT;
    this.target = { host: opts.targetHost || '127.0.0.1', port: opts.targetPort || SDB_PORT };
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
    Array.from(this._pairs).forEach((pair) => pair.close());
};

SdbProxy.prototype._accept = function (client) {
    const from = plainAddress(client.remoteAddress);

    client.on('error', () => { /* reported through close below */ });

    if (!this.enabled || from !== this.allowedHost) {
        this.log.warn(`sdb proxy refused ${from || 'an unknown address'}: only ${this.allowedHost} is allowed`);
        client.destroy();
        return;
    }

    const upstream = net.connect(this.target.port, this.target.host);
    const startedAt = Date.now();
    let toTv = 0;
    let fromTv = 0;
    let closed = false;

    const pair = {
        close: () => {
            if (closed) return;
            closed = true;
            this._pairs.delete(pair);
            client.destroy();
            upstream.destroy();
            const seconds = Math.round((Date.now() - startedAt) / 1000);
            this.log.info(`sdb proxy ${from} disconnected after ${seconds}s ` +
                `(${toTv} bytes to sdbd, ${fromTv} back)`);
            this._changed();
        }
    };

    this._pairs.add(pair);

    const timer = setTimeout(() => {
        this.log.err(`sdb proxy: sdbd did not accept within ${CONNECT_TIMEOUT}ms`);
        pair.close();
    }, CONNECT_TIMEOUT);

    upstream.on('connect', () => {
        clearTimeout(timer);
        this.log.info(`sdb proxy ${from} connected`);
        this._changed();
    });

    upstream.on('error', (error) => {
        clearTimeout(timer);
        if (error.code === 'ECONNREFUSED') {
            this.log.err('sdb proxy: nothing listens on 127.0.0.1:26101 — Developer Mode may be off');
        } else {
            this.log.err(`sdb proxy upstream: ${error.message}`);
        }
        pair.close();
    });

    [client, upstream].forEach((socket) => {
        socket.setNoDelay(true);
        if (socket.setKeepAlive) socket.setKeepAlive(true, KEEPALIVE_MS);
        socket.on('close', () => { clearTimeout(timer); pair.close(); });
    });

    client.on('data', (chunk) => { toTv += chunk.length; });
    upstream.on('data', (chunk) => { fromTv += chunk.length; });

    // pipe() keeps backpressure in place: a slow side pauses the fast one rather than buffering a push.
    client.pipe(upstream);
    upstream.pipe(client);
};

SdbProxy.prototype.close = function () {
    return this._stop('the service is stopping');
};

module.exports = { SdbProxy, DEFAULT_PORT, plainAddress };
