// Prose in the UI face, anything the machine produced in monospace, and `data-focus` on everything reachable.

import { html } from '../core/view.js';
import { wordmark } from './television.js';

const masthead = (state) => html`
  <div class="bar">
    ${wordmark()}
    <span class="inline">
      <span class="micro mono">${state.connection}</span>
      <button class="btn btn-quiet" data-focus="theme" data-on-click="theme"
              aria-pressed="${state.themeOn}"
              title="The Homebrew Channel theme">${state.themeOn ? 'theme · on' : 'theme · off'}</button>
    </span>
  </div>`;

// The only thing on screen until it is done, dressed as the other half of the code shown on the TV.
const pairing = (state) => (state.restoring ? html`
  <div class="state state-warn">
    <span class="state-head">Pairing</span>
    <span class="small">Offering the code this phone paired with last.</span>
  </div>` : html`
  <div class="glass pad stack stack-wide">
    <div class="stack stack-tight">
      <span class="label">Pairing required</span>
      <p class="small">Enter the six digits shown on the TV. They change each time the
        channel restarts.</p>
    </div>

    <input class="field code-field mono" id="pin" type="tel" inputmode="numeric" maxlength="6"
           autocomplete="off" placeholder="······" data-focus="pin" data-on-input="pin">

    ${state.pinError
        ? html`<div class="state state-fault">
             <span class="state-head">Rejected</span>
             <span class="small">${state.pinError}</span>
           </div>`
        : ''}
  </div>`);

const status = (state) => {
    const { device } = state;

    const band = (tone, head, body) => html`
      <div class="state state-${tone}">
        <span class="state-head">${head}</span>
        <span class="small">${body}</span>
      </div>`;

    if (!device) return band('warn', 'Checking', 'Asking the TV about itself.');

    if (!device.onTv) return band('warn', 'Off device', 'Running as a development harness. Installs need real hardware.');

    // Working is the ordinary state, and the page closes up over a band saying so.
    if (device.ready) return html``;

    if (device.reason === 'debugModeOff') {
        return band('warn', 'Developer mode off',
            html`Turn it on in Apps › 12345 › Settings, then restart the TV.`);
    }

    // The current developer IP is deliberately not quoted: the device API has reported 127.0.0.1 while sdbd
    // accepted only another machine.
    return band('warn', 'No sdb route',
        html`Set <span class="mono ink">Host PC IP</span> to <span class="mono ink">127.0.0.1</span>
             in Apps › 12345 › Settings, then restart the TV — that value is only read at startup.`);
};

const weight = (bytes) => (bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`);

const monogram = (name) => String(name || '?').trim().charAt(0) || '?';

const tile = (app, hero = false) => html`
  <span class="tile${hero ? ' tile-hero' : ''}">
    <span class="tile-mark">${monogram(app.name || app.packageId)}</span>
    ${app.icon ? html`<img class="tile-art" src="${app.icon}" alt="">` : ''}
  </span>`;

// Spans throughout: a USB row is a `<button>`, whose content model is phrasing content only.
const identity = (app, below = '', hero = false) => html`
  <span class="ident">
    ${tile(app, hero)}
    <span class="stack stack-tight">
      <span class="inline">
        <span class="name truncate">${app.name || app.packageId || 'Unnamed'}</span>
        ${app.version ? html`<span class="mono micro">${app.version}</span>` : ''}
      </span>
      ${below}
    </span>
  </span>`;

const TABS = [
    ['catalog', 'apps'],
    ['upload', 'upload'],
    ['github', 'github'],
    ['url', 'url'],
    ['usb', 'usb'],
    ['relay', 'shell']
];

const tabs = (state) => html`
  <div class="tabs" role="tablist">
    ${TABS.map(([id, label]) => html`
      <button class="tab" role="tab" aria-selected="${state.tab === id}"
              data-focus="tab:${id}" data-on-click="tab:${id}">${label}</button>`)}
  </div>`;

const section = (label, body, footer = '') => html`
  <div class="glass pad stack stack-snug">
    <span class="label">${label}</span>
    ${body}
    ${footer}
  </div>`;

const catalogued = (app) => {
    if (!app.installed) return html`<span class="small truncate">${app.description || app.source.ref}</span>`;

    const held = html`<span class="mono">${app.installed}</span>`;

    if (app.update) {
        return html`<span class="small truncate">${held} → <span class="mono ink">${app.available}</span></span>`;
    }

    return html`<span class="small truncate">${held} installed${app.checked
        ? (app.available ? ' · up to date' : ' · no release found')
        : ''}</span>`;
};

const action = (app) => (app.installed
    ? html`<button class="btn ${app.update ? 'btn-signal' : 'btn-ghost'}"
                   data-focus="app:${app.id}" data-on-click="install:catalog:${app.id}"
                   ${app.update ? '' : 'disabled'}>update</button>`
    : html`<button class="btn btn-ghost" data-focus="app:${app.id}"
                   data-on-click="install:catalog:${app.id}">install</button>`);

const recheck = (app, checking) => (app.source.type !== 'github' ? '' : html`
  <button class="btn btn-quiet" data-focus="check:${app.id}" data-on-click="check:${app.id}"
          ${checking ? 'disabled' : ''}>${checking === app.id ? 'checking…' : 'check'}</button>`);

const catalog = (state) => section('Available', state.catalog.length === 0
    ? html`<p class="small">Nothing listed yet. Use upload, github or url.</p>`
    : html`<div class="list">
        ${state.catalog.map((app) => html`
          <div class="row split">
            ${identity(app, catalogued(app))}
            <span class="controls">
              ${recheck(app, state.checking)}
              ${action(app)}
            </span>
          </div>`)}
      </div>`,
    html`<span class="controls">
      <button class="btn btn-ghost" data-focus="refresh" data-on-click="catalog:refresh">refresh</button>
      <button class="btn btn-ghost" data-focus="check-all" data-on-click="checkAll"
              ${state.checking ? 'disabled' : ''}>${state.checking === 'all'
        ? 'checking…' : 'check all'}</button>
    </span>`);

// The archive is on the phone already, so it is opened and the well shows the app rather than the filename.
const chosen = (state) => {
    if (!state.file) {
        return html`
          <span class="mono small">choose a file</span>
          <span class="micro mono">or drag one here</span>`;
    }

    const app = state.identity || { name: state.file.name };

    const facts = [
        state.identity && state.identity.packageId,
        state.identity && state.file.name,
        weight(state.file.size)
    ].filter(Boolean).join(' · ');

    return identity(app, html`
      <span class="mono micro truncate">${state.reading ? 'reading the package…' : facts}</span>`, true);
};

const upload = (state) => section('Upload a package', html`
    <p class="small">Send a .wgt straight from this device. Nothing needs hosting.</p>

    <label for="file" class="drop${state.file ? ' drop-filled' : ''}">${chosen(state)}</label>
    <input id="file" type="file" accept=".wgt,.tpk" hidden data-on-change="file">

    ${state.uploading !== null ? html`<div class="meter"><i style="width:${state.uploading}%"></i></div>` : ''}`,
    state.file
        ? html`<button class="btn btn-signal btn-wide" data-focus="upload" data-on-click="upload"
                       ${state.uploading !== null ? 'disabled' : ''}>install</button>`
        : '');

const remoteSource = ({ label, id, placeholder, action, hint, value }) => section(label, html`
    <div class="entry">
      <input class="field" id="${id}" placeholder="${placeholder}" value="${value || ''}"
             data-focus="${id}" data-on-enter="${action}"
             autocapitalize="off" autocorrect="off" spellcheck="false">
      <button class="btn" data-focus="${id}:go" data-on-click="${action}">install</button>
    </div>
    <p class="small">${hint}</p>`);

const fromGitHub = (state) => remoteSource({
    label: 'GitHub release', id: 'gh', placeholder: 'owner/repo', action: 'install:github',
    hint: 'The newest release’s .wgt asset. Public repositories only.', value: state.github
});

const fromUrl = (state) => remoteSource({
    label: 'Direct URL', id: 'url', placeholder: 'https://…/App.wgt', action: 'install:url',
    hint: 'Must be https.', value: state.url
});

const usb = (state) => section('Attached storage', html`
    <span class="mono small truncate">${state.usbPath}</span>
    <div class="list">
      ${state.usb.map((entry) => (entry.isDirectory
        ? html`
          <button class="row row-button inline" data-focus="path:${entry.path}"
                  data-on-click="usb:${entry.path}">
            <span class="mono micro">/</span>
            <span class="mono truncate small">${entry.name}</span>
          </button>`
        : html`
          <button class="row row-button" data-focus="path:${entry.path}"
                  data-on-click="usb:${entry.path}">
            ${identity(entry.identity || { name: entry.name }, html`
              <span class="mono micro truncate">${[
                  entry.identity && entry.identity.packageId,
                  entry.identity && entry.name,
                  entry.size ? weight(entry.size) : null
              ].filter(Boolean).join(' · ')}</span>`)}
          </button>`))}
    </div>`);

const relay = (state) => section('Command relay', html`
    <p class="small">Developer Mode is pinned to loopback, so no other machine can reach this
      TV’s sdb daemon. The channel runs on the TV, so it can — and can relay for you.</p>

    <div class="state state-warn">
      <span class="state-head">Arbitrary commands</span>
      <span class="small">Leave this off unless you are using it.</span>
    </div>

    <label class="toggle">
      <input type="checkbox" data-focus="relay" ${state.relayEnabled ? 'checked' : ''}
             data-on-change="relay:toggle">
      <span class="small">Enable the relay</span>
    </label>

    ${state.relayEnabled ? html`
      <div class="entry">
        <input class="field" id="cmd" placeholder="pkgcmd -l" data-focus="cmd"
               data-on-enter="relay:run" autocapitalize="off" autocorrect="off" spellcheck="false">
        <button class="btn" data-focus="cmd:go" data-on-click="relay:run"
                ${state.relayBusy ? 'disabled' : ''}>run</button>
      </div>
      <pre class="log shell">${state.relayOutput || ' '}</pre>` : ''}`);

// sdbd lets in only its developer host IP, which is 127.0.0.1 once installed; this forwards a second port to
// it so one named computer can use sdb again without that setting changing and the TV restarting.
// The phone reached the TV at this address, so the computer can too; the TV's own page only knows loopback.
const tvAddress = () => {
    const name = typeof location !== 'undefined' ? location.hostname : '';
    return name && !/^(127\.|localhost$|\[?::1)/.test(name) ? name : '<tv-ip>';
};

const sdbProxy = (state) => {
    const proxy = state.proxy || {};
    const clients = proxy.clients || 0;

    return section('sdb proxy', html`
    <p class="small">Lets one computer use <span class="mono">sdb</span> with this TV while its
      developer host IP stays 127.0.0.1. sdbd’s command allowlist still applies.</p>

    ${proxy.error ? html`
      <div class="state state-fault">
        <span class="state-head">Not running</span>
        <span class="small">${proxy.error}</span>
      </div>` : proxy.enabled ? html`
      <div class="state state-warn">
        <span class="state-head">On for ${proxy.allowedHost}</span>
        <span class="small">On that computer: <span class="mono">sdb connect ${tvAddress()}:${proxy.port}</span>
          · ${clients} ${clients === 1 ? 'connection' : 'connections'}</span>
      </div>` : html`
      <div class="state state-warn">
        <span class="state-head">Installs from your network</span>
        <span class="small">The named computer can install and run apps. Leave this off unless you are using it.</span>
      </div>`}

    <div class="entry">
      <input class="field" id="proxyHost" placeholder="computer's IP, e.g. 192.168.1.20" data-focus="proxyHost"
             value="${proxy.allowedHost || state.proxyHostDraft || ''}" inputmode="decimal"
             ${proxy.enabled ? 'disabled' : ''} autocapitalize="off" autocorrect="off" spellcheck="false">
    </div>

    <label class="toggle">
      <input type="checkbox" data-focus="proxy" ${proxy.enabled ? 'checked' : ''}
             data-on-change="proxy:toggle">
      <span class="small">Enable the sdb proxy</span>
    </label>`);
};

// Diagnostic: does the service runtime actually get to run /bin/sh? If yes, a proper terminal can
// live right here with no sdbd games. The report is dense on purpose — it is for one of us to read.
const spawnProbe = (state) => {
    const report = state.spawnReport;

    const summary = (() => {
        if (!report) return null;
        const won = (report.attempts || []).find((attempt) => attempt.ok);
        if (won) return html`<span class="state-head">Spawn works</span>
            <span class="small">${won.shell} returned 0 in ${won.durationMs} ms.</span>`;
        return html`<span class="state-head">Spawn did not work</span>
            <span class="small">Nothing in ${(report.attempts || []).map((attempt) => attempt.shell).join(', ') || 'the candidates'} ran.</span>`;
    })();

    const detail = (() => {
        if (!report) return html``;
        const lines = ['when   : ' + report.when, 'node   : ' + (report.node || 'unknown')];
        (report.attempts || []).forEach((attempt, index) => {
            lines.push('');
            lines.push(`attempt ${index + 1}: ${attempt.shell}`);
            if (attempt.threw) {
                lines.push('  spawn threw: ' + attempt.threw);
                return;
            }
            if (attempt.spawnError) lines.push('  spawn error: ' + attempt.spawnError);
            lines.push('  exit        : ' + attempt.exitCode + (attempt.signal ? ` (signal ${attempt.signal})` : ''));
            lines.push('  duration ms : ' + attempt.durationMs);
            if (attempt.truncated) lines.push('  [output was truncated]');
            if (attempt.stdout) lines.push('  --- stdout ---\n' + attempt.stdout.replace(/^/gm, '  '));
            if (attempt.stderr) lines.push('  --- stderr ---\n' + attempt.stderr.replace(/^/gm, '  '));
        });
        return html`<pre class="log shell">${lines.join('\n')}</pre>`;
    })();

    return section('Local spawn probe', html`
    <p class="small">Can this service run a shell on the TV without going through sdbd? One click runs
      <span class="mono">/bin/sh -c "id; uname -a; …"</span> inside the service and reports what came back.
      Harmless to run; nothing is written anywhere.</p>

    <div class="entry">
      <button class="btn" data-focus="probe:go" data-on-click="spawn:probe"
              ${state.spawnBusy ? 'disabled' : ''}>${state.spawnBusy ? 'probing…' : 'probe'}</button>
    </div>

    ${summary ? html`<div class="state state-warn">${summary}</div>` : ''}
    ${detail}`);
};

const shell = (state) => html`${relay(state)}${sdbProxy(state)}${spawnProbe(state)}`;

const PANELS = { catalog, upload, github: fromGitHub, url: fromUrl, usb, relay: shell };

const panel = (state) => PANELS[state.tab](state);

const PHASES = ['probing', 'fetching', 'resigning', 'staging', 'installing'];

const PHASE_WORDS = {
    probing: 'Checking the TV',
    fetching: 'Downloading',
    resigning: 'Re-signing',
    staging: 'Copying to the TV',
    installing: 'Installing'
};

const outcome = (state) => {
    if (state.phase) {
        const step = PHASES.indexOf(state.phase) + 1;
        const app = state.identity;

        const named = app && (app.name || app.packageId);
        const detail = state.phaseDetail && state.phaseDetail !== named
            ? ` · ${state.phaseDetail}`
            : '';

        return html`
          <div class="glass pad stack stack-snug">
            ${app ? identity(app, html`<span class="mono micro truncate">${app.packageId}</span>`) : ''}
            <div class="split split-baseline">
              <span class="value truncate">${PHASE_WORDS[state.phase] || state.phase}</span>
              <span class="mono micro">${step}/${PHASES.length}${detail}</span>
            </div>
            <div class="meter"><i style="width:${Math.round((step / PHASES.length) * 100)}%"></i></div>
          </div>`;
    }

    if (state.error) {
        // What went wrong, what the television said, and what to do about it — the last absent when nothing
        // has a cure.
        return html`
          <div class="state state-fault">
            <span class="state-head">Failed</span>
            <span class="small ink">${state.error.title}</span>
            <span class="mono micro wrap">${state.error.detail}</span>
            ${state.error.remedy ? html`<span class="small wrap">${state.error.remedy}</span>` : html``}
          </div>`;
    }

    if (state.done) {
        const app = state.identity || state.done;

        return html`
          <div class="state state-ok">
            <span class="state-head">Installed</span>
            ${identity(app, html`<span class="mono micro truncate">${app.packageId || ''}</span>`)}
            <span class="small">On the TV’s home row.</span>
          </div>`;
    }

    return html``;
};

export { masthead, pairing, status, tabs, panel, outcome };
