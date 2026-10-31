#!/usr/bin/env node
// Web app smoke test over CDP (W53): the library loads, a photo opens and
// renders, a slider change renders again, crop opens and cancels, and the
// edit is discarded. Desktop, then a phone (touch). Run it on a scratch web
// app (night prompt: scratch.sh up, uvicorn on :8030), never on :8010.
//
//   node tests/smoke.mjs [--url http://127.0.0.1:8030] [--photo ID]
//                        [--only desktop|phone] [--out DIR] [--brief]
//
// Starts the Mac's headless Chrome (outside the Bash sandbox) unless one
// listens on --port (9333). Screenshots go to --out (default
// /tmp/dtweb-smoke): one per step on a failure, the last page on a pass.
// Exit 0 when every check passes.

import {mkdirSync} from 'node:fs';
import {startChrome, openPage} from './cdp.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i < 0 ? dflt : args[i + 1]; };
const URL_ = (opt('url', 'http://127.0.0.1:8030')).replace(/\/$/, '');
const PORT = +opt('port', 9333);
const OUT = opt('out', '/tmp/dtweb-smoke');
const ONLY = opt('only', null);
const BRIEF = args.includes('--brief');
let PHOTO = opt('photo', null);

if (/:8010\b/.test(URL_) && !args.includes('--force')) {
  console.error('smoke: refusing :8010 (the real library); use a scratch web app, or --force');
  process.exit(2);
}
mkdirSync(OUT, {recursive: true});

const results = [];
const log = (s) => { if (!BRIEF) console.log(s); };

async function check(mode, page, name, f) {
  const t = Date.now();
  try {
    const note = await f();
    results.push({mode, name, ok: true});
    log(`ok   ${mode} ${name} (${Date.now() - t} ms)${note ? ': ' + note : ''}`);
    return true;
  } catch (e) {
    const shot = await page.screenshot(`${OUT}/${mode}-${name.replace(/\W+/g, '-')}.png`).catch(() => '');
    results.push({mode, name, ok: false, why: e.message, shot});
    log(`FAIL ${mode} ${name}: ${e.message}${shot ? ' (' + shot + ')' : ''}`);
    return false;
  }
}

// #pv shows a finished render (a blob: URL from preview(), decoded) other than `not`
const rendered = (not = '') => `(() => { const i = document.querySelector('#pv');
  return i && i.src.startsWith('blob:') && i.src !== ${JSON.stringify(not)} && i.complete && i.naturalWidth > 0 && i.src; })()`;

async function run(mode, port) {
  const page = await openPage(port);
  try {
    if (mode === 'phone') await page.phone(); else await page.desktop();
    const c = (name, f) => check(mode, page, name, f);

    if (!await c('library loads', async () => {
      await page.goto(URL_ + '/');
      const n = await page.waitFor("document.querySelectorAll('figure.tile[data-id]').length", {what: 'photo tiles'});
      if (!PHOTO) PHOTO = await page.eval("document.querySelector('figure.tile[data-id]').dataset.id");
      return `${n} tiles`;
    })) return;

    if (!await c('photo opens and renders', async () => {
      await page.goto(`${URL_}/photo/${PHOTO}`);
      await page.waitFor(rendered(), {timeout: 60000, what: 'the first render'});
      // don't touch an edit someone has open with unsaved changes
      if (await page.eval("!document.querySelector('#save').disabled"))
        throw new Error(`photo ${PHOTO} has unsaved changes in the engine; not touching it`);
      const n = await page.waitFor("document.querySelectorAll('.field input[type=range]').length", {what: 'module sliders'});
      return `photo ${PHOTO}, ${n} sliders`;
    })) return;

    let edited = false;
    await c('slider change renders', async () => {
      const before = await page.eval(rendered());
      // the first module slider, moved a tenth of its range (back if that leaves it)
      const field = await page.eval(`(() => {
        const s = document.querySelector('.field input[type=range]');
        const lo = +s.min, hi = +s.max, v = +s.value, d = (hi - lo) / 10;
        s.value = v + d <= hi ? v + d : v - d;
        s.dispatchEvent(new Event('input', {bubbles: true}));
        return s.closest('.field').dataset.field + ' ' + v + ' -> ' + s.value; })()`);
      edited = true;
      await page.waitFor(rendered(before), {timeout: 60000, what: 'a new render after the slider'});
      await page.waitFor("!document.querySelector('#save').disabled", {what: 'save enabled (unsaved changes)'});
      return field;
    });

    await c('crop opens and cancels', async () => {
      await page.click('#tool-crop');
      await page.waitFor("!document.querySelector('#toolbar-crop').hidden && !document.querySelector('#cropframe').hidden",
        {what: 'crop toolbar and frame'});
      await page.waitFor("document.querySelector('#cropbox').getBoundingClientRect().width > 20", {what: 'the crop box drawn'});
      await page.click('#crop-cancel');
      await page.waitFor("document.querySelector('#toolbar-crop').hidden && document.querySelector('#cropframe').hidden",
        {what: 'crop closed'});
    });

    if (edited) await c('discard', async () => {
      if (await page.eval("!document.querySelector('#save').disabled")) {
        await page.eval("document.querySelector('#reload').click()");
        await page.waitFor("document.querySelector('dialog[open] .ask-ok')", {what: 'the discard question'});
        await page.click('dialog[open] .ask-ok');
      }
      await page.waitFor("document.querySelector('#save').disabled", {timeout: 30000, what: 'nothing to save'});
    });

    await c('no JS errors', async () => {
      if (page.errors.length) throw new Error(page.errors.slice(0, 5).join(' | '));
    });
    await c('no failed loads', async () => {
      // a thumbnail 404s when the library copy lacks the photo's raw: not the page's fault
      const thumbs = page.failedLoads.filter((f) => new URL(f.url, URL_).pathname.startsWith('/thumb/'));
      // the browser asks for /favicon.ico itself; the app has none
      const other = page.failedLoads.filter((f) => !thumbs.includes(f) && !f.url.endsWith('/favicon.ico'));
      if (other.length) throw new Error(other.slice(0, 5).map((f) => `${f.url}: ${f.text}`).join(' | '));
      return thumbs.length ? `${thumbs.length} thumbnails missing (raws not in this library)` : '';
    });
    await page.screenshot(`${OUT}/${mode}.png`);
  } finally {
    await page.close();
  }
}

const chrome = await startChrome({port: PORT});
try {
  for (const mode of ['desktop', 'phone']) if (!ONLY || ONLY === mode) await run(mode, chrome.port);
} finally {
  await chrome.stop();
}

const bad = results.filter((r) => !r.ok);
if (bad.length) {
  if (BRIEF) for (const r of bad) console.log(`FAIL ${r.mode} ${r.name}: ${r.why}${r.shot ? ' (' + r.shot + ')' : ''}`);
  console.log(`smoke: ${results.length - bad.length}/${results.length} passed, ${bad.length} failed`);
  process.exit(1);
}
console.log(`smoke: ${results.length}/${results.length} passed (${URL_}, photo ${PHOTO})`);
