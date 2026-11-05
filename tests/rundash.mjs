#!/usr/bin/env node
// The queue tab's run dashboard (W73) over CDP, desktop and phone, on a dry run:
// copies of the real daily-run.sh and night-run.sh, with their paths moved to the
// scratch backlog folder, a stub `claude` (/usage from a file; an item waits for
// the test, then ticks itself) and stubs for end-of-run, memory and cleanup.
// Steps through running, wrapping up, waiting for the session reset, finishing,
// cap reached, queue empty and a killed run. Needs a scratch web app whose
// DTWEB_BACKLOG_DIR is --dir; never the real backlog folder or :8010.
//
//   node tests/rundash.mjs --dir /tmp/w73-backlog --src ~/darktableluamcp/darktable-api/launchd
//     [--url http://127.0.0.1:8030] [--only desktop|phone] [--out /tmp/w73] [--brief]

import {chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {startChrome, openPage} from './cdp.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i < 0 ? dflt : args[i + 1]; };
const URL_ = opt('url', 'http://127.0.0.1:8030').replace(/\/$/, '');
const PORT = +opt('port', 9333);
const DIR = opt('dir', null), SRC = opt('src', null);
const OUT = opt('out', '/tmp/w73');
const ONLY = opt('only', null);
const BRIEF = args.includes('--brief');
if (/:8010\b/.test(URL_)) { console.error('rundash: refusing :8010; use a scratch web app'); process.exit(2); }
if (!DIR || !SRC || /darktableluamcp\/darktable-api\/?$/.test(DIR)) {
  console.error('rundash: --dir (a scratch copy of the backlog folder) and --src (the launchd scripts) are needed'); process.exit(2);
}
mkdirSync(OUT, {recursive: true});

const results = [];
const log = (s) => { if (!BRIEF) console.log(s); };
const assert = (c, m) => { if (!c) throw new Error(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HERE = `${DIR}/launchd`, STUB = `${DIR}/stub`, QUEUE = `${DIR}/QUEUE.md`, STATUS = `${HERE}/.run-status.json`, LOCK = `${HERE}/.daily-run.lock`;
const stub = (path, text) => { writeFileSync(path, text); chmodSync(path, 0o755); };

function setup() {
  mkdirSync(HERE, {recursive: true}); mkdirSync(STUB, {recursive: true}); mkdirSync(`${DIR}/forecast`, {recursive: true});
  for (const f of ['daily-run.sh', 'night-run.sh', 'usage.zsh', 'run-status.zsh', 'night-run-prompt.md']) {
    const t = readFileSync(`${SRC}/${f}`, 'utf8').replaceAll('/Users/clark/darktableluamcp/darktable-api', DIR)
      .replaceAll('$HOME/Library/Logs/darktable-night-run.log', `${DIR}/night.log`);
    assert(!/\$HOME\/Library|darktableluamcp\/darktable-api/.test(t), `${f} still has a real path`);
    stub(`${HERE}/${f}`, t);
  }
  stub(`${HERE}/run-procs.zsh`, 'stop_started() { : }\n');
  stub(`${HERE}/mem-check.sh`, '#!/bin/sh\nexit 0\n');
  stub(`${HERE}/run-memwatch.sh`, '#!/bin/sh\nexit 0\n');
  stub(`${HERE}/usage-review-check.sh`, '#!/bin/sh\nexit 0\n');
  stub(`${HERE}/end-of-run.sh`, `#!/bin/sh\nuntil [ -f ${STUB}/end-go ]; do sleep 0.2; done\n`);
  stub(`${STUB}/osascript`, '#!/bin/sh\nexit 0\n');
  stub(`${STUB}/claude`, `#!/bin/sh
case "$*" in
  "-p /usage") cat ${STUB}/usage ;;
  *) until [ -f ${STUB}/go ]; do sleep 0.2; done
     awk '!d && /^- \\[ \\]/ { sub(/\\[ \\]/, "[x]"); d = 1 } { print }' ${QUEUE} > ${QUEUE}.new && mv ${QUEUE}.new ${QUEUE} ;;
esac
`);
}

const hhmm = (d) => d.toLocaleTimeString('en-US', {hour: 'numeric', minute: '2-digit'}).replace(/\s/g, '').toLowerCase();
const day = (d) => `${d.toLocaleDateString('en-US', {month: 'short'})} ${d.getDate()} at ${hhmm(d)}`;
function usage(s, w) {
  const now = Date.now();
  writeFileSync(`${STUB}/usage.new`, `Current session: ${s}% used · resets ${hhmm(new Date(now + 30 * 60e3))} (America/New_York)\n` +
    `Current week (all models): ${w}% used · resets ${day(new Date(now + 3 * 86400e3))} (America/New_York)\n`);
  cpSync(`${STUB}/usage.new`, `${STUB}/usage`);
}
const items = (...l) => writeFileSync(QUEUE, `# Night queue\n\n## Queue\n${l.map((x) => `- [ ] **${x}** dry-run item. est 0.1\n`).join('')}\n## Deferred\n`);
const flag = (name, on) => { if (on) writeFileSync(`${STUB}/${name}`, ''); else rmSync(`${STUB}/${name}`, {force: true}); };

let proc = null;
function start(cap) {
  proc = spawn('/bin/zsh', [`${HERE}/daily-run.sh`], {detached: true, stdio: 'ignore',
    env: {...process.env, PATH: `${STUB}:${process.env.PATH}`, CAP: String(cap), EVERY: '1', SESSION_STOP: '90', SESSION_MAX: '97',
          NOTE: `${DIR}/night-run-dry.md`, QUEUE}});   // not a night run's own NOTE and QUEUE, when one started this test
  const p = proc;
  p.ended = new Promise((r) => p.on('exit', r));
  return p;
}
const killRun = async () => {
  if (!proc || proc.exitCode !== null || proc.signalCode) { proc = null; return; }
  try { process.kill(-proc.pid, 'SIGKILL'); } catch (e) {}
  await proc.ended; proc = null;
};
const reset = async () => {
  await killRun();
  rmSync(LOCK, {recursive: true, force: true}); rmSync(STATUS, {force: true});
  flag('go', false); flag('end-go', false);
};

async function check(mode, page, name, f) {
  const t = Date.now();
  try {
    const note = await f();
    results.push({mode, name, ok: true});
    log(`ok   ${mode} ${name} (${Date.now() - t} ms)${note ? ': ' + note : ''}`);
  } catch (e) {
    const shot = await page.screenshot(`${OUT}/FAIL-${mode}-${name.replace(/\W+/g, '-')}.png`).catch(() => '');
    results.push({mode, name, ok: false, why: e.message, shot});
    log(`FAIL ${mode} ${name}: ${e.message} (${shot})`);
  }
}

async function run(mode, port) {
  const page = await openPage(port), phone = mode === 'phone';
  const c = (name, f) => check(mode, page, name, f);
  const dash = () => page.eval(`(document.querySelector('#bl-dash') || {}).innerText || ''`);
  const dashHas = (s, opts) => page.waitFor(`(document.querySelector('#bl-dash') || {}).innerText.includes(${JSON.stringify(s)})`, {what: `the dashboard to say "${s}"`, ...opts});
  const api = () => fetch(`${URL_}/api/backlog/run`).then((r) => r.json());
  const until = async (f, what) => { for (let i = 0; i < 200; i++) { const st = await api(); if (st.dash && f(st.dash, st)) return st; await sleep(150); } throw new Error('timed out: ' + what + ': ' + JSON.stringify((await api()).dash)); };
  const load = () => page.goto(`${URL_}/backlog?f=queue`);
  try {
    if (phone) await page.phone(); else await page.desktop();
    await reset();
    items('#901', '#902');
    usage(10, 50);
    await load();

    await c('no status file: no panel', async () => {
      assert((await api()).dash === null, 'dash not null');
      assert(!(await dash()), 'panel shown: ' + await dash());
    });

    start(60);
    await c('running: item, caps, usage, age', async () => {
      await until((d) => d.state === 'running' && d.session === 10, 'running');
      await load();
      await dashHas('Running');
      const t = await dash();
      for (const s of ['#901', '50% of 60%', '10% of 90%', 'resets', ' ago']) assert(t.includes(s), `no "${s}" in: ${t}`);
      await page.screenshot(`${OUT}/${mode}-running.png`);
    });

    await c('the panel fits the phone and nothing overflows', async () => {
      const over = await page.eval(`(() => { const e = document.querySelector('#bl-dash'); return [...e.querySelectorAll('*'), e].filter((x) => x.getBoundingClientRect().right > innerWidth + 1).length + document.documentElement.scrollWidth - innerWidth; })()`);
      assert(over <= 0, 'overflow: ' + over);
    });

    await c('wrapping up shows in the why', async () => {
      usage(92, 50);
      await until((d) => d.state === 'running' && /wrapping up/.test(d.why), 'wrapping up');
    });

    await c('waiting for the session reset, refreshed without a reload', async () => {
      await page.eval('window.__same = 1');
      flag('go', true);
      await until((d) => d.state === 'waiting', 'waiting');
      await dashHas('Waiting', {timeout: 35000});
      assert(await page.eval('window.__same === 1'), 'the page reloaded');
      const t = await dash();
      assert(/session at 92%, waiting for the reset at \d\d:\d\d/.test(t), 'why: ' + t);
      assert(t.includes('92% of 90%') && t.includes('#902'), 'session and next item: ' + t);
      await page.screenshot(`${OUT}/${mode}-waiting.png`);
    });

    await c('the wait keeps writing the status', async () => {
      const t0 = JSON.parse(readFileSync(STATUS, 'utf8')).time;
      await until((d) => d.state === 'waiting' && d.time > t0, 'a newer status');
    });

    await c('usage showing the reset ends the wait early; finishing, then cap reached', async () => {
      flag('go', false);
      usage(5, 59);
      await until((d, st) => d.state === 'finishing' && st.held, 'finishing');
      await load();
      await dashHas('Finishing up');
      flag('end-go', true);
      await until((d, st) => d.state === 'cap' && !st.held, 'cap');
      await load();
      await dashHas('Not running: week cap reached');
      const t = await dash();
      assert(t.includes("week at 59%, the day's cap is 60%") && t.includes('59% of 60%'), 'cap: ' + t);
      await page.screenshot(`${OUT}/${mode}-cap.png`);
      await proc.ended; proc = null;
    });

    await c('the last item done: queue empty', async () => {
      flag('go', true);
      usage(5, 50);
      start(60);
      await until((d, st) => d.state === 'empty' && !st.held, 'empty');
      await load();
      await dashHas('Not running: queue empty');
      assert((await dash()).includes('–'), 'an item is still shown: ' + await dash());
      await proc.ended; proc = null;
    });

    await c('a killed run shows as stopped', async () => {
      flag('go', false);
      flag('end-go', false);
      items('#903');
      usage(10, 50);
      start(60);
      await until((d, st) => d.state === 'running' && d.item === '#903' && st.held, 'running');
      await killRun();
      await until((d) => d.state === 'stopped', 'stopped');
      await load();
      await dashHas('Not running: the run stopped without finishing');
      assert((await dash()).includes('its last status was running'), 'why: ' + await dash());
    });

    await c('no js errors', async () => { assert(!page.errors.length, page.errors.join('; ')); });
  } finally { await page.close(); await reset(); }
}

setup();
const chrome = await startChrome({port: PORT});
try {
  for (const mode of ['desktop', 'phone']) if (!ONLY || ONLY === mode) await run(mode, chrome.port);
} finally {
  await reset();
  await chrome.stop();
}
const bad = results.filter((r) => !r.ok);
for (const r of bad) console.log(`FAIL ${r.mode} ${r.name}: ${r.why}${r.shot ? ' (' + r.shot + ')' : ''}`);
console.log(bad.length ? `rundash: ${results.length - bad.length}/${results.length} passed, ${bad.length} failed` : `rundash: ${results.length}/${results.length} passed (${URL_})`);
process.exit(bad.length ? 1 : 0);
