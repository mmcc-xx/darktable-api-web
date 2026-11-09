#!/usr/bin/env node
// The header's library controls, headless only (W84), over CDP, desktop and
// phone: no darkroom link or quit button; "release to darktable" lists the
// photos with unsaved edits and saves them all or cancels, and asks again if
// the list changed while the question was up; the released text; take back;
// the page following a take-back made elsewhere and the engine's own when a
// process holding the library's lock goes away (--config). Saves edits to the
// library: needs a scratch web app and its scratch engine, never :8010.
//
//   node tests/libctl.mjs --config /tmp/dts-N/config --photos 409,472
//     [--url http://127.0.0.1:8030] [--only desktop|phone] [--out /tmp/w84] [--brief]

import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {startChrome, openPage} from './cdp.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i < 0 ? dflt : args[i + 1]; };
const URL_ = opt('url', 'http://127.0.0.1:8030').replace(/\/$/, '');
const PORT = +opt('port', 9333);
const CONFIG = opt('config', null), OUT = opt('out', '/tmp/w84'), ONLY = opt('only', null);
const [A, B] = opt('photos', '409,472').split(',').map(Number);
const BRIEF = args.includes('--brief');
if (/:8010\b/.test(URL_)) { console.error('libctl: refusing :8010; use a scratch web app'); process.exit(2); }
if (!CONFIG || !CONFIG.startsWith('/tmp/')) { console.error('libctl: --config (the scratch engine\'s config folder, in /tmp) is needed'); process.exit(2); }
mkdirSync(OUT, {recursive: true});

const results = [];
const log = (s) => { if (!BRIEF) console.log(s); };
const assert = (c, m) => { if (!c) throw new Error(m); };
const json = async (r) => { const s = await r.json(); if (!r.ok) throw new Error(`${r.url}: ${JSON.stringify(s)}`); return s; };
const post = (path, body) => fetch(URL_ + path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body || {})}).then(json);
const lib = () => fetch(`${URL_}/api/library`).then(json);
const unsaved = async () => ((await lib()).sessions || []).filter((s) => s.unsaved).map((s) => s.imgid).sort((a, b) => a - b);
const setEv = (id, ev) => post(`/api/photo/${id}/set`, {operation: 'exposure', values: {exposure: ev}});
const getEv = async (id) => (await fetch(`${URL_}/api/photo/${id}/module?operation=exposure`).then(json)).fields.find((f) => f.name === 'exposure').value;
const near = (a, b) => Math.abs(a - b) < 1e-3;
const ensureOwned = async () => { if ((await lib()).state === 'released') await post('/api/library/acquire'); };

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
  const DLG = `document.querySelector('dialog.ask-dlg[open]')`;
  const msg = () => page.eval(`${DLG}.querySelector('.ask-msg').textContent`);
  const okLabel = () => page.eval(`${DLG}.querySelector('.ask-ok').textContent`);
  const asked = () => page.waitFor(`!!${DLG}`, {what: 'the question'});
  const askedWith = (text) => page.waitFor(`${DLG} && ${DLG}.querySelector('.ask-msg').textContent.includes(${JSON.stringify(text)})`, {what: `the question with ${text}`});
  const answer = async (yes) => { await press(`dialog.ask-dlg[open] .ask-${yes ? 'ok' : 'no'}`); };
  const closed = () => page.waitFor(`!${DLG}`, {what: 'the question closed'});
  const state = (s) => page.waitFor(`document.querySelector('#lib') && document.querySelector('#lib').dataset.state === ${JSON.stringify(s)}`, {timeout: 30000, what: `the header at ${s}`});
  const libText = () => page.eval(`document.querySelector('#lib-text').textContent.replace(/\\s+/g, ' ').trim()`);
  const buttons = () => page.eval(`[...document.querySelectorAll('#lib [data-lib]')].map((b) => b.dataset.lib).join()`);
  const load = async () => { await page.goto(`${URL_}/`); await state('owned'); await page.eval('window.__same = 1'); };
  const notReloaded = async () => assert(await page.eval('window.__same === 1'), 'the page reloaded');
  // the values saved here differ per mode, so a save from the desktop pass can't pass for the phone's
  const evA = phone ? 0.37 : 0.31, evB = phone ? 0.53 : 0.47;
  try {
    if (phone) await page.phone(); else await page.desktop();
    await ensureOwned();
    await post(`/api/photo/${A}/open?fresh=true`); await post(`/api/photo/${B}/open?fresh=true`);
    await load();

    await c('owned header: library text, release only, no darkroom link', async () => {
      assert(/^library: /.test(await libText()), await libText());
      assert(await buttons() === 'release', await buttons());
      assert(!(await page.eval(`!!document.querySelector('#darkroom')`)), '#darkroom on the library page');
    });

    await c('photo page: no darkroom link', async () => {
      await page.goto(`${URL_}/photo/${A}`);
      await page.waitFor(`!!document.querySelector('#lib')`, {what: 'the header'});
      assert(!(await page.eval(`!!document.querySelector('#darkroom')`)), '#darkroom on the photo page');
      await load();
    });

    await c('nothing unsaved: asks plainly, cancel keeps the library', async () => {
      assert(!(await unsaved()).length, 'unsaved at the start');
      await press('#lib [data-lib=release]');
      await asked();
      assert((await msg()).includes('stock master darktable') && !/Unsaved/.test(await msg()), await msg());
      assert(await okLabel() === 'release', await okLabel());
      await answer(false); await closed();
      assert((await lib()).state === 'owned', 'released after cancel');
      await notReloaded();
    });

    await setEv(A, evA);

    await c('an unsaved photo is listed; cancel leaves it unsaved', async () => {
      await press('#lib [data-lib=release]');
      await askedWith(`photo ${A}`);
      assert(await okLabel() === 'save all and release', await okLabel());
      await page.screenshot(`${OUT}/${mode}-ask.png`);
      await answer(false); await closed();
      const l = await lib();
      assert(l.state === 'owned', 'released after cancel');
      assert((await unsaved()).join() === String(A), JSON.stringify(l.sessions));
      await notReloaded();
    });

    await c('list changed while asked: asked again, nothing released', async () => {
      await press('#lib [data-lib=release]');
      await askedWith(`photo ${A}`);
      await setEv(B, evB);
      await answer(true);
      await askedWith(`photos ${Math.min(A, B)}, ${Math.max(A, B)}`);
      assert(await okLabel() === 'save all and release', await okLabel());
      assert((await lib()).state === 'owned', 'released without asking about the new photo');
      await answer(false); await closed();
      assert((await unsaved()).length === 2, 'unsaved after cancel');
    });

    await c('save all and release: released, text and buttons', async () => {
      await press('#lib [data-lib=release]');
      await askedWith(`photos ${Math.min(A, B)}, ${Math.max(A, B)}`);
      await answer(true);
      await state('released');
      const l = await lib();
      assert(l.state === 'released', JSON.stringify(l));
      const t = await libText();
      assert(t.includes('open it in stock master darktable') && t.includes('taken back when darktable quits'), t);
      assert(await buttons() === 'acquire', await buttons());
      assert(!(await page.eval(`document.body.textContent.includes('quit darktable and take back')`)), 'the quit button is there');
      await page.screenshot(`${OUT}/${mode}-released.png`);
    });

    await c('take back: owned, the edits saved', async () => {
      await press('#lib [data-lib=acquire]');
      await state('owned');
      assert(await buttons() === 'release', await buttons());
      assert(!(await unsaved()).length, 'unsaved after the take back');
      const a = await getEv(A), b = await getEv(B);
      assert(near(a, evA) && near(b, evB), `exposures ${a}, ${b}`);
      assert(!(await unsaved()).length, 'reading them made them unsaved');
    });

    await c('nothing unsaved: release, then a take-back elsewhere reloads the page', async () => {
      await load();
      await press('#lib [data-lib=release]');
      await asked();
      await answer(true);
      await state('released');
      await post('/api/library/acquire');
      await state('owned');
    });

    await c('darktable holding the lock: its process shown; quits: taken back by itself', async () => {
      await load();
      await press('#lib [data-lib=release]');
      await asked();
      await answer(true);
      await state('released');
      const holder = spawn('sleep', ['300'], {stdio: 'ignore'});
      const lock = `${CONFIG}/library.db.lock`;
      try {
        writeFileSync(lock, `${holder.pid}\n`);
        await page.waitFor(`document.querySelector('#lib-text').textContent.includes('process ${holder.pid}')`, {timeout: 40000, what: 'the holder in the text'});
        assert(await buttons() === 'acquire', await buttons());
      } finally { holder.kill(); }
      rmSync(lock, {force: true});
      await state('owned');
      assert((await lib()).state === 'owned', 'not taken back');
    });

    await c('no js errors', async () => { assert(!page.errors.length, page.errors.join('; ')); });
  } finally { await page.close(); }
}

const chrome = await startChrome({port: PORT});
try {
  for (const mode of ['desktop', 'phone']) if (!ONLY || ONLY === mode) await run(mode, chrome.port);
} finally {
  await chrome.stop();
}
await ensureOwned().catch(() => {});
const bad = results.filter((r) => !r.ok);
for (const r of bad) console.log(`FAIL ${r.mode} ${r.name}: ${r.why}${r.shot ? ' (' + r.shot + ')' : ''}`);
console.log(bad.length ? `libctl: ${results.length - bad.length}/${results.length} passed, ${bad.length} failed` : `libctl: ${results.length}/${results.length} passed`);
process.exit(bad.length ? 1 : 0);
