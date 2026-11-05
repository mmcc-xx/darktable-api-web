#!/usr/bin/env node
// The backlog queue tab's night-run bar (W66) over CDP, desktop and phone:
// today's cap field (save, Enter, back to the weekly reset's cap, a bad value),
// run queue now (confirm, cancel, the stubbed kickstart runs), disabled while a
// run holds the lock (a live pid) or the queue has no open item, and the
// status line. Needs a scratch web app whose DTWEB_BACKLOG_DIR is a scratch
// copy (--dir) and whose DTWEB_KICKSTART appends a line to --kick; never the
// real backlog folder or :8010.
//
//   node tests/backlogrun.mjs --dir /tmp/w66-backlog --kick /tmp/w66-kick.log
//     [--url http://127.0.0.1:8030] [--only desktop|phone] [--out /tmp/w66] [--brief]

import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {startChrome, openPage} from './cdp.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i < 0 ? dflt : args[i + 1]; };
const URL_ = opt('url', 'http://127.0.0.1:8030').replace(/\/$/, '');
const PORT = +opt('port', 9333);
const DIR = opt('dir', null), KICK = opt('kick', null);
const OUT = opt('out', '/tmp/w66');
const ONLY = opt('only', null);
const BRIEF = args.includes('--brief');
if (/:8010\b/.test(URL_)) { console.error('backlogrun: refusing :8010; use a scratch web app'); process.exit(2); }
if (!DIR || !KICK || /darktableluamcp\/darktable-api\/?$/.test(DIR)) {
  console.error('backlogrun: --dir (a scratch copy of the backlog folder) and --kick (the stub\'s log) are needed'); process.exit(2);
}
mkdirSync(OUT, {recursive: true});

const results = [];
const log = (s) => { if (!BRIEF) console.log(s); };
const assert = (c, m) => { if (!c) throw new Error(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const CAP = `${DIR}/launchd/.cap-${today}`, LOCK = `${DIR}/launchd/.daily-run.lock`, QUEUE = `${DIR}/QUEUE.md`;
const QUEUE0 = readFileSync(QUEUE, 'utf8');
const status = () => fetch(`${URL_}/api/backlog/run`).then((r) => r.json());
const kicks = () => existsSync(KICK) ? readFileSync(KICK, 'utf8').split('\n').filter(Boolean).length : 0;
const capFile = () => existsSync(CAP) ? readFileSync(CAP, 'utf8').trim() : null;
let sleeper = null;
const unlock = () => { rmSync(LOCK, {recursive: true, force: true}); if (sleeper) { sleeper.kill(); sleeper = null; } };
const lockLive = () => {
  sleeper = spawn('sleep', ['600'], {stdio: 'ignore'});
  mkdirSync(LOCK, {recursive: true}); writeFileSync(`${LOCK}/pid`, `${sleeper.pid}\n`);
  return sleeper.pid;
};
const reset = () => { unlock(); rmSync(CAP, {force: true}); rmSync(KICK, {force: true}); writeFileSync(QUEUE, QUEUE0); };

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
  const press = (sel) => phone ? page.tap(sel) : page.click(sel);
  const text = (sel) => page.eval(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent || ''`);
  const load = async () => {
    await page.goto(`${URL_}/backlog?f=queue`);
    await page.waitFor(`document.querySelector('#bl-run-status') && document.querySelector('#bl-run-status').textContent.length > 0`, {what: 'the run bar'});
  };
  // a click that reloads the page: wait for the new one
  const reloadBy = async (f) => {
    await page.eval('window.__old = 1');
    await f();
    await page.waitFor(`!window.__old && document.readyState === 'complete' && document.querySelector('#bl-run-status') && document.querySelector('#bl-run-status').textContent.length > 0`, {what: 'the page reloaded'});
  };
  const setCap = (v) => page.eval(`(() => { const i = document.querySelector('#bl-cap-in'); i.focus(); i.value = ${JSON.stringify(String(v))}; return i.value; })()`);
  try {
    if (phone) await page.phone(); else await page.desktop();
    reset();
    await load();

    await c('bar shows the cap from the weekly reset, the week and the next item', async () => {
      const st = await status();
      assert(st.override === null && st.cap === st.week_cap, 'override left over: ' + JSON.stringify(st));
      const v = await page.eval("document.querySelector('#bl-cap-in').value");
      assert(+v === st.cap, `field ${v}, cap ${st.cap}`);
      const info = await text('#bl-cap-info');
      assert(info.includes(`day ${st.day} of the week`) && (st.week == null || info.includes('week ')), 'info: ' + info);
      assert(await page.eval(`document.querySelector('[data-act="cap-reset"]').hidden`), 'reset shown without an override');
      const s = await text('#bl-run-status');
      assert(s.includes(`no run going; next: ${st.item}`) && s.includes(st.note), 'status: ' + s);
      assert(!(await page.eval(`document.querySelector('[data-act="run-now"]').disabled`)), 'run now disabled');
      return `cap ${st.cap}% (day ${st.day}), week ${st.week}%, next ${st.item}`;
    });

    await c('save writes .cap-<today>; the capacity line follows', async () => {
      await setCap(50);
      await reloadBy(() => press('[data-act="cap-save"]'));
      assert(capFile() === '50', 'cap file: ' + capFile());
      assert(+(await page.eval("document.querySelector('#bl-cap-in').value")) === 50, 'field not 50 after reload');
      const info = await text('#bl-cap-info');
      assert(info.includes(`set for ${today}`), 'info: ' + info);
      assert(!(await page.eval(`document.querySelector('[data-act="cap-reset"]').hidden`)), 'no back-to button');
      const capLine = await text('.bl-cap');
      assert(!capLine || capLine.includes('cap 50%'), 'capacity line: ' + capLine);
      assert((await text('#bl-toast')).includes('50%'), 'toast: ' + await text('#bl-toast'));
    });

    if (!phone) await c('Enter in the field saves', async () => {
      await setCap(61);
      await reloadBy(() => page.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r'})
        .then(() => page.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13})));
      assert(capFile() === '61', 'cap file: ' + capFile());
    });

    await c('a bad value is refused, nothing written', async () => {
      const before = capFile();
      await setCap(0);
      await press('[data-act="cap-save"]');
      await page.waitFor(`document.querySelector('.ask-dlg[open]')`, {what: 'the message'});
      const msg = await text('.ask-dlg[open] .ask-msg');
      assert(/1 to 100/.test(msg), 'message: ' + msg);
      await press('.ask-dlg[open] .ask-ok');
      await sleep(300);
      assert(capFile() === before, `cap file changed: ${before} -> ${capFile()}`);
      const r = await fetch(`${URL_}/api/backlog/cap`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{"cap": 101}'});
      assert(r.status === 400 && capFile() === before, 'server took 101: ' + r.status);
    });

    await c('back to the weekly cap removes the file', async () => {
      await reloadBy(() => press('[data-act="cap-reset"]'));
      assert(capFile() === null, 'cap file still there: ' + capFile());
      const st = await status();
      assert(+(await page.eval("document.querySelector('#bl-cap-in').value")) === st.week_cap, 'field not the weekly cap');
    });

    await c('run now asks first; cancel starts nothing', async () => {
      await press('[data-act="run-now"]');
      await page.waitFor(`document.querySelector('.ask-dlg[open]')`, {what: 'the confirm'});
      const msg = await text('.ask-dlg[open] .ask-msg'), st = await status();
      assert(msg.includes('Start the night run now?') && msg.includes(st.item) && msg.includes(`${st.cap}%`), 'confirm: ' + msg);
      await press('.ask-dlg[open] .ask-no');
      await sleep(500);
      assert(kicks() === 0, 'kicked on cancel');
    });

    await c('run now, confirmed: the kickstart runs once', async () => {
      await press('[data-act="run-now"]');
      await page.waitFor(`document.querySelector('.ask-dlg[open]')`, {what: 'the confirm'});
      await press('.ask-dlg[open] .ask-ok');
      await page.waitFor(`document.querySelector('#bl-toast').textContent.includes('night run started')`, {what: 'the toast'});
      assert(kicks() === 1, 'kicks: ' + kicks());
    });

    await c('while a run holds the lock: disabled, status names it; cap still saves', async () => {
      const pid = lockLive();
      await load();
      assert(await page.eval(`document.querySelector('[data-act="run-now"]').disabled`), 'run now enabled while running');
      const s = await text('#bl-run-status'), st = await status();
      assert(s.includes(`running ${st.item}`) && s.includes(`pid ${pid}`), 'status: ' + s);
      assert((await text('#bl-cap-info')).includes('applies to runs started after'), 'info: ' + await text('#bl-cap-info'));
      const r = await fetch(`${URL_}/api/backlog/run`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'});
      assert(r.status === 409 && kicks() === 1, `server: ${r.status}, kicks ${kicks()}`);
      await setCap(70);
      await reloadBy(() => press('[data-act="cap-save"]'));
      assert(capFile() === '70', 'cap file: ' + capFile());
      assert((await text('#bl-toast')).includes('applies to the runs started after'), 'toast: ' + await text('#bl-toast'));
      unlock();
      rmSync(CAP, {force: true});
    });

    await c('the poll picks up a run that ends', async () => {
      lockLive();
      await load();
      assert(await page.eval(`document.querySelector('[data-act="run-now"]').disabled`), 'not disabled');
      unlock();
      await page.waitFor(`!document.querySelector('[data-act="run-now"]').disabled`, {timeout: 40000, what: 'the poll re-enabled run now'});
    });

    await c('an empty queue: run now disabled', async () => {
      writeFileSync(QUEUE, QUEUE0.replace(/^- \[ \]/gm, '- [x]'));
      await load();
      assert(await page.eval(`document.querySelector('[data-act="run-now"]').disabled`), 'enabled with nothing open');
      assert((await text('#bl-run-status')).includes('the queue is empty'), 'status: ' + await text('#bl-run-status'));
      writeFileSync(QUEUE, QUEUE0);
    });

    await page.screenshot(`${OUT}/${mode}.png`);
    await c('no js errors', async () => { assert(!page.errors.length, page.errors.join('; ')); });
  } finally { await page.close(); reset(); }
}

const chrome = await startChrome({port: PORT});
try {
  for (const mode of ['desktop', 'phone']) if (!ONLY || ONLY === mode) await run(mode, chrome.port);
} finally {
  reset();
  await chrome.stop();
}
const bad = results.filter((r) => !r.ok);
for (const r of bad) console.log(`FAIL ${r.mode} ${r.name}: ${r.why}${r.shot ? ' (' + r.shot + ')' : ''}`);
console.log(bad.length ? `backlogrun: ${results.length - bad.length}/${results.length} passed, ${bad.length} failed` : `backlogrun: ${results.length}/${results.length} passed (${URL_})`);
process.exit(bad.length ? 1 : 0);
