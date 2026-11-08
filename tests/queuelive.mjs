#!/usr/bin/env node
// The backlog queue tab's items update live (W82) over CDP, desktop and phone:
// on each run poll the badges go open -> in progress -> done with no reload,
// and an open dialog, typing in the cap field or a text selection hold the
// swap back until they end. The poll's 30 s is shortened by the page's
// setTimeout. Needs a scratch web app whose DTWEB_BACKLOG_DIR is a scratch
// copy (--dir; its QUEUE.md is replaced for the test); never the real backlog
// folder or :8010.
//
//   node tests/queuelive.mjs --dir /tmp/w82-backlog
//     [--url http://127.0.0.1:8030] [--only desktop|phone] [--out /tmp/w82] [--brief]

import {mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {startChrome, openPage} from './cdp.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i < 0 ? dflt : args[i + 1]; };
const URL_ = opt('url', 'http://127.0.0.1:8030').replace(/\/$/, '');
const PORT = +opt('port', 9333);
const DIR = opt('dir', null), OUT = opt('out', '/tmp/w82'), ONLY = opt('only', null);
const BRIEF = args.includes('--brief');
if (/:8010\b/.test(URL_)) { console.error('queuelive: refusing :8010; use a scratch web app'); process.exit(2); }
if (!DIR || /darktableluamcp\/darktable-api\/?$/.test(DIR)) { console.error('queuelive: --dir (a scratch copy of the backlog folder) is needed'); process.exit(2); }
mkdirSync(OUT, {recursive: true});

const results = [];
const log = (s) => { if (!BRIEF) console.log(s); };
const assert = (c, m) => { if (!c) throw new Error(m); };
const LOCK = `${DIR}/launchd/.daily-run.lock`, QUEUE = `${DIR}/QUEUE.md`;
const QUEUE0 = readFileSync(QUEUE, 'utf8');
const filler = Array.from({length: 40}, (_, i) => `- [ ] **#${900 + i}** filler item ${i}, long enough to make the list scroll. est 0.1`).join('\n');
const START = `# Night queue\n\n## Queue\n- [x] **#1** done already. est 1.0\n- [ ] **#2** the first. est 1.0\n- [ ] **W4** the second. est 3.0\n${filler}\n\n## Deferred\n- [-] **#2** an older plan. est 1.0\n`;
const setQueue = (f) => writeFileSync(QUEUE, f(readFileSync(QUEUE, 'utf8')));
const tick = (label) => setQueue((q) => q.replace(`- [ ] **${label}**`, `- [x] **${label}**`));
let sleeper = null;
const unlock = () => { rmSync(LOCK, {recursive: true, force: true}); if (sleeper) { sleeper.kill(); sleeper = null; } };
const lockLive = () => {
  sleeper = spawn('sleep', ['600'], {stdio: 'ignore'});
  mkdirSync(LOCK, {recursive: true}); writeFileSync(`${LOCK}/pid`, `${sleeper.pid}\n`);
};
const reset = () => { unlock(); writeFileSync(QUEUE, START); };

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
  const ITEM = (label) => `[...document.querySelectorAll('#bl .bl-item')].find((e) => e.dataset.label === ${JSON.stringify(label)})`;
  const badge = (label) => page.eval(`${ITEM(label)}.querySelector('.badge').textContent`);
  const waitBadge = (label, text) => page.waitFor(`${ITEM(label)} && ${ITEM(label)}.querySelector('.badge').textContent === ${JSON.stringify(text)}`, {timeout: 8000, what: `${label} to show ${text}`});
  const load = async () => {
    await page.goto(`${URL_}/backlog?f=queue`);
    await page.waitFor(`document.querySelector('#bl-run-status') && document.querySelector('#bl-run-status').textContent.length > 0`, {what: 'the run bar'});
    await page.eval('window.__same = 1');
  };
  const notReloaded = async () => assert(await page.eval('window.__same === 1'), 'the page reloaded');
  // two polls have certainly passed (400 ms each)
  const polls = () => new Promise((r) => setTimeout(r, 1200));
  try {
    if (phone) await page.phone(); else await page.desktop();
    await page.send('Page.addScriptToEvaluateOnNewDocument', {source: 'const st = window.setTimeout; window.setTimeout = (f, ms, ...a) => st(f, ms === 30000 ? 400 : ms, ...a);'});
    reset();
    await load();

    await c('no run: items keep their status', async () => {
      assert(await badge('#1') === 'done' && await badge('#2') === 'open' && await badge('W4') === 'open', 'badges');
      assert(!(await page.eval(`document.querySelector('.badge.running')`)), 'something in progress');
    });

    await c('no change: the list is left alone', async () => {
      await page.eval(`document.querySelector('.bl-item').__keep = 1`);
      await polls();
      assert(await page.eval(`document.querySelector('.bl-item').__keep === 1`), 'the list was re-rendered');
    });

    await c('a run takes the lock: its item goes in progress, no reload', async () => {
      lockLive();
      await waitBadge('#2', 'in progress');
      assert(await page.eval(`document.querySelector('.bl-item .badge.running').closest('.bl-item').dataset.label`) === '#2', 'wrong item');
      assert(await page.eval(`document.querySelectorAll('.badge.running').length`) === 1, 'more than one in progress');
      const w = await page.eval(`[document.querySelector('.badge.running').offsetWidth, ${ITEM('W4')}.querySelector('.badge').offsetWidth]`);
      assert(w[0] === w[1], `the in progress badge is ${w[0]} px, open is ${w[1]} px`);
      await notReloaded();
    });

    await c('the deferred item of the same label stays deferred', async () => {
      const b = await page.eval(`[...document.querySelectorAll('#bl .bl-item')].filter((e) => e.dataset.label === '#2').map((e) => e.querySelector('.badge').textContent).join()`);
      assert(b === 'in progress,deferred', b);
    });

    await c('ticked: done, the next item in progress, the status line follows, no reload', async () => {
      const y = phone ? 200 : 120;
      await page.eval(`window.scrollTo(0, ${y})`);
      tick('#2');
      await waitBadge('#2', 'done');
      await waitBadge('W4', 'in progress');
      await page.waitFor(`document.querySelector('#bl-run-status').textContent.includes('running W4')`, {timeout: 8000, what: 'the status line'});
      await notReloaded();
      const at = await page.eval('window.scrollY');
      assert(Math.abs(at - y) < 2, `scroll moved: ${y} -> ${at}`);
      await page.eval('window.scrollTo(0, 0)');
    });

    await c('a Partial note: the item shows it and is taken first', async () => {
      setQueue((q) => q.replace(/(- \[ \] \*\*#939\*\*.*\n)/, '$1  - Partial (2026-11-08): night/x abc; left 0.2: tests\n'));
      await waitBadge('#939', 'in progress');
      await waitBadge('W4', 'open');
      await page.waitFor(`${ITEM('#939')}.textContent.includes('night/x abc')`, {timeout: 8000, what: 'the Partial note'});
      await notReloaded();
      setQueue((q) => q.replace(/ {2}- Partial.*\n/, ''));
      await waitBadge('W4', 'in progress');
    });

    await c('an open dialog holds the swap back, then it goes through', async () => {
      await press(`.bl-item[data-label="W4"] [data-act="unqueue"]`);
      await page.waitFor(`document.querySelector('.ask-dlg[open]')`, {what: 'the confirm'});
      await page.eval(`document.querySelector('.ask-dlg[open]').__keep = 1; document.querySelector('.bl-item').__keep = 1`);
      tick('W4');
      await polls();
      assert(await page.eval(`document.querySelector('.ask-dlg[open]').__keep === 1`), 'the dialog went away');
      assert(await page.eval(`document.querySelector('.bl-item').__keep === 1`), 'the list changed under the dialog');
      await press('.ask-dlg[open] .ask-no');
      await waitBadge('W4', 'done');
      await notReloaded();
    });

    await c('typing in the cap field holds the swap back; the value stays', async () => {
      await page.eval(`(() => { const i = document.querySelector('#bl-cap-in'); i.focus(); i.value = '55'; })()`);
      tick('#900');
      await polls();
      assert(await badge('#900') !== 'done', 'swapped while typing');
      assert(await page.eval(`document.querySelector('#bl-cap-in').value`) === '55', 'the value changed');
      assert(await page.eval(`document.activeElement.id`) === 'bl-cap-in', 'lost focus');
      await page.eval(`document.querySelector('#bl-cap-in').blur()`);
      await waitBadge('#900', 'done');
      await notReloaded();
    });

    await c('a text selection holds the swap back', async () => {
      await page.eval(`(() => { const r = document.createRange(); r.selectNodeContents(document.querySelector('.bl-item .body')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.querySelector('.bl-item').__keep = 1; })()`);
      tick('#901');
      await polls();
      assert(await page.eval(`document.querySelector('.bl-item').__keep === 1`), 'the list changed under the selection');
      await page.eval('getSelection().removeAllRanges()');
      await waitBadge('#901', 'done');
    });

    await c('the run ends: nothing in progress, the next item back to open', async () => {
      unlock();
      await waitBadge('#902', 'open');
      assert(!(await page.eval(`document.querySelector('.badge.running')`)), 'still in progress');
      await notReloaded();
    });

    await c('after a live swap the buttons work with the new hash', async () => {
      await page.eval('window.__old = 1');
      await press(`.bl-item[data-label="#902"] [data-act="move"][data-dir="down"]`);
      await page.waitFor(`!window.__old && document.readyState === 'complete' && document.querySelector('.bl-item')`, {what: 'the page reloaded'});
      const q = readFileSync(QUEUE, 'utf8');
      assert(q.indexOf('**#903**') < q.indexOf('**#902**'), 'not moved');
    });

    await c('no js errors', async () => { assert(!page.errors.length, page.errors.join('; ')); });
    lockLive();
    await load();
    await page.waitFor(`document.querySelector('.badge.running')`, {what: 'in progress'});
    await page.screenshot(`${OUT}/${mode}.png`);
  } finally { await page.close(); unlock(); }
}

const chrome = await startChrome({port: PORT});
try {
  for (const mode of ['desktop', 'phone']) if (!ONLY || ONLY === mode) await run(mode, chrome.port);
} finally {
  unlock();
  writeFileSync(QUEUE, QUEUE0);
  await chrome.stop();
}
const bad = results.filter((r) => !r.ok);
for (const r of bad) console.log(`FAIL ${r.mode} ${r.name}: ${r.why}${r.shot ? ' (' + r.shot + ')' : ''}`);
console.log(bad.length ? `queuelive: ${results.length - bad.length}/${results.length} passed, ${bad.length} failed` : `queuelive: ${results.length}/${results.length} passed (${URL_})`);
process.exit(bad.length ? 1 : 0);
