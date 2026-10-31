#!/usr/bin/env node
// Import dialog's review grid (#156) over CDP: choose 4 files, previews
// appear (two raws, a jpg, a file with none), reject one, the big view, the
// import sends only the kept ones, and the rejected one comes up rejected the
// next time. Desktop, then a phone. Scratch web app only (:8030), never :8010.
//
//   node tests/import_cull.mjs [--url http://127.0.0.1:8030] [--only desktop|phone]
//                              [--out /tmp/n156/shots] [--dir /tmp/n156/files] [--brief]
//
// Test files are made in --dir from two RW2 raws under /Volumes/PhotoDrive.

import {mkdirSync, copyFileSync, readFileSync, writeFileSync, statSync, existsSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {startChrome, openPage} from './cdp.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i < 0 ? dflt : args[i + 1]; };
const URL_ = opt('url', 'http://127.0.0.1:8030').replace(/\/$/, '');
const PORT = +opt('port', 9333);
const OUT = opt('out', '/tmp/n156/shots');
const DIR = opt('dir', '/tmp/n156/files');
const ONLY = opt('only', null);
const BRIEF = args.includes('--brief');
const SRC = '/Volumes/PhotoDrive/Darktable/20260316';
if (/:8010\b/.test(URL_) && !args.includes('--force')) {
  console.error('import_cull: refusing :8010 (the real library); use a scratch web app'); process.exit(2);
}
mkdirSync(OUT, {recursive: true}); mkdirSync(DIR, {recursive: true});

// ── test files
const names = ['cull_a.RW2', 'cull_b.RW2', 'cull_c.jpg', 'cull_d.ORF'];
if (!existsSync(`${DIR}/cull_a.RW2`)) copyFileSync(`${SRC}/20260316_0065.RW2`, `${DIR}/cull_a.RW2`);
if (!existsSync(`${DIR}/cull_b.RW2`)) copyFileSync(`${SRC}/20260316_0135.RW2`, `${DIR}/cull_b.RW2`);
if (!existsSync(`${DIR}/cull_c.jpg`)) {      // the biggest JPEG in the raw's first 8 MB
  const b = readFileSync(`${DIR}/cull_a.RW2`).subarray(0, 8 << 20);
  let best = null;
  for (let i = 0; i + 3 < b.length; i++) {
    if (b[i] !== 0xFF || b[i + 1] !== 0xD8 || b[i + 2] !== 0xFF) continue;
    let e = b.indexOf(Buffer.from([0xFF, 0xD9]), i);      // crude: last EOI before the next SOI of a big one
    while (e >= 0) { const n = b.indexOf(Buffer.from([0xFF, 0xD9]), e + 2); if (n < 0 || n - i > 6 << 20) break; e = n; }
    if (e > 0 && (!best || e - i > best[1] - best[0])) best = [i, e + 2];
  }
  if (!best) throw new Error('no JPEG in cull_a.RW2');
  writeFileSync(`${DIR}/cull_c.jpg`, b.subarray(best[0], best[1]));
}
if (!existsSync(`${DIR}/cull_d.ORF`)) writeFileSync(`${DIR}/cull_d.ORF`, randomBytes(64 << 10));
const info = names.map((n) => { const s = statSync(`${DIR}/${n}`); return {name: n, size: s.size, mtime: Math.floor(s.mtimeMs / 1000)}; });

const results = [];
const log = (s) => { if (!BRIEF) console.log(s); };
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
const assert = (c, m) => { if (!c) throw new Error(m); };
const post = (path, body) => fetch(URL_ + path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)}).then((r) => r.json());
const key = (page, k, code = k, text) => ['keyDown', 'keyUp'].reduce((p, type) => p.then(() =>
  page.send('Input.dispatchKeyEvent', {type, key: k, code, text: type === 'keyDown' ? text : undefined,
    windowsVirtualKeyCode: {ArrowLeft: 37, ArrowRight: 39, Escape: 27}[k] || k.toUpperCase().charCodeAt(0)})), Promise.resolve());
const tile = (i) => `#imp-cull .cull-t:nth-child(${i})`;
const counts = (page) => page.eval("document.querySelector('#imp-counts').textContent");

async function openDialog(page) {
  await page.goto(URL_ + '/');
  await page.waitFor("!!document.querySelector('#import-btn')");
  await page.click('#import-btn');
  await page.waitFor("document.querySelector('#imp-here').textContent", {what: 'folder list'});
  await page.click('[data-tab=upload]');
  await page.waitFor("!document.querySelector('[data-pane=upload]').hidden");
}
async function choose(page) {
  const {root} = await page.send('DOM.getDocument');
  const {nodeId} = await page.send('DOM.querySelector', {nodeId: root.nodeId, selector: '#imp-files'});
  await page.send('DOM.setFileInputFiles', {nodeId, files: names.map((n) => `${DIR}/${n}`)});
}

async function run(mode, port) {
  const page = await openPage(port);
  const c = (n, f) => check(mode, page, n, f);
  try {
    if (mode === 'phone') await page.phone(); else await page.desktop();
    await post('/api/import/rejects', {reject: [], keep: info});      // start clean
    await openDialog(page);
    await choose(page);
    await c('previews', async () => {
      await page.waitFor("[1, 2, 3].every((i) => { const m = document.querySelector('#imp-cull .cull-t:nth-child(' + i + ') img'); return m && m.complete && m.naturalWidth > 0; })", {what: 'a, b, c previews'});
      await page.waitFor(`/no preview/.test(document.querySelector('${tile(4)}').textContent)`, {what: 'd: no preview'});
      assert(await counts(page) === '4 to send · 0 rejected', 'counts ' + await counts(page));
      const cols = await page.eval("getComputedStyle(document.querySelector('#imp-cull')).gridTemplateColumns.split(' ').length");
      return `${cols} columns`;
    });
    await c('reject b', async () => {
      await page.click(tile(2));
      assert(await page.eval(`document.querySelector('${tile(2)}').getAttribute('aria-pressed')`) === 'true', 'b not pressed');
      assert(await counts(page) === '3 to send · 1 rejected', 'counts ' + await counts(page));
      await page.screenshot(`${OUT}/${mode}-grid.png`);
    });
    await c('big view', async () => {
      await page.click(tile(1) + ' .cull-view');
      await page.waitFor("!document.querySelector('#imp-big').hidden");
      await page.waitFor("document.querySelector('#cb-img').naturalWidth > 0", {what: 'a big preview'});
      assert(await page.eval("document.querySelector('#cb-name').textContent") === 'cull_a.RW2', 'not on a');
      assert(await page.eval("document.querySelector('#cb-n').textContent") === '1 of 4', 'n of N');
      if (mode === 'phone') {      // swipe left = next
        const t = (type, x) => page.send('Input.dispatchTouchEvent', {type, touchPoints: type === 'touchEnd' ? [] : [{x, y: 400}]});
        await t('touchStart', 300); await t('touchMove', 200); await t('touchMove', 100); await t('touchEnd');
      } else await key(page, 'ArrowRight');
      await page.waitFor("document.querySelector('#cb-name').textContent === 'cull_b.RW2'", {what: 'b after next'});
      assert(await page.eval("document.querySelector('#cb-toggle').textContent") === 'keep', 'b should offer keep');
      await page.waitFor("document.querySelector('#cb-img').naturalWidth > 0 && !document.querySelector('#cb-img').hidden");
      await page.screenshot(`${OUT}/${mode}-big.png`);
      await key(page, 'k', 'KeyK', 'k');
      assert(await counts(page) === '4 to send · 0 rejected', 'after k: ' + await counts(page));
      await key(page, 'x', 'KeyX', 'x');
      assert(await counts(page) === '3 to send · 1 rejected', 'after x: ' + await counts(page));
      await key(page, 'Escape');
      assert(await page.eval("document.querySelector('#imp-big').hidden && document.querySelector('#import').open"), 'Escape: big closed, dialog open');
    });
    let text = '';
    const importNow = async () => {
      await page.click('#imp-go');
      await page.waitFor("!document.querySelector('#imp-go').disabled && /imported|failed|nothing/.test(document.querySelector('#imp-result').textContent)", {timeout: 120000, what: 'import result'});
      return text = await page.eval("document.querySelector('#imp-result').textContent");
    };
    await c('import without b', async () => {
      await importNow();
      assert(!/cull_b/.test(text), 'b was sent: ' + text);
      const n = +(/(\d+) imported/.exec(text) || [0, 0])[1];
      const skipped = ['cull_a', 'cull_c'].filter((x) => text.includes(x)).length;
      assert(n + skipped >= 2, 'a and c neither imported nor skipped: ' + text);
      return `${n} imported (a, c${n === 3 ? ', d' : ''}); ${text.replace(/\s+/g, ' ')}`;
    });
    await c('remembered', async () => {
      const r = await post('/api/import/rejects/check', {files: info});
      assert(JSON.stringify(r.rejected) === '[false,true,false,false]', JSON.stringify(r));
      await openDialog(page);
      await choose(page);
      await page.waitFor(`document.querySelector('${tile(2)}').classList.contains('earlier')`, {what: 'b rejected earlier'});
      assert(await counts(page) === '3 to send · 1 rejected (1 of them earlier)', await counts(page));
      assert(await page.eval(`getComputedStyle(document.querySelector('${tile(2)} em')).display`) !== 'none', 'badge hidden');
      await page.screenshot(`${OUT}/${mode}-earlier.png`);
    });
    await c('keep b, import', async () => {
      await page.click(tile(2));
      assert(await counts(page) === '4 to send · 0 rejected', await counts(page));
      await importNow();
      assert(/cull_b|[1-9]\d* imported/.test(text), 'b not sent: ' + text);
      const r = await post('/api/import/rejects/check', {files: info});
      assert(!r.rejected[1], 'b still remembered');
    });
    await c('no js errors', async () => {
      assert(!page.errors.length, page.errors.join('; '));
    });
  } finally { await page.close(); }
}

const chrome = await startChrome({port: PORT});
try {
  for (const mode of ['desktop', 'phone']) if (!ONLY || ONLY === mode) await run(mode, chrome.port);
} finally {
  await post('/api/import/rejects', {reject: [], keep: info}).catch(() => {});
  await chrome.stop();
}
const bad = results.filter((r) => !r.ok);
for (const r of bad) console.log(`FAIL ${r.mode} ${r.name}: ${r.why}${r.shot ? ' (' + r.shot + ')' : ''}`);
console.log(bad.length ? `${bad.length} of ${results.length} failed` : `ok: ${results.length} checks passed`);
process.exit(bad.length ? 1 : 0);
