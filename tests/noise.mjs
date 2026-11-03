#!/usr/bin/env node
// The noise section of the darkroom (W59) over CDP: it opens, denoise (profiled)
// turns on, strength and mode change in the engine, the summary follows,
// "judge at 100%" zooms, and on a phone the section works in the sheet. With
// --ai, the AI denoise button makes a copy (a new photo in the library; slow,
// loads a model). Scratch web app only (:8030), never :8010; DTAPI_SOCKET from
// the scratch's env file (scratch.sh up), to read the engine. The edit is
// discarded at the end, nothing is saved.
//
//   node tests/noise.mjs --photo ID [--url http://127.0.0.1:8030] [--port 9333] [--brief] [--ai]

import net from 'node:net';
import {startChrome, openPage} from './cdp.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i < 0 ? dflt : args[i + 1]; };
const URL_ = opt('url', 'http://127.0.0.1:8030').replace(/\/$/, '');
const PORT = +opt('port', 9333);
const PHOTO = +opt('photo', 0);
const BRIEF = args.includes('--brief');
const AI = args.includes('--ai');
const SOCK = process.env.DTAPI_SOCKET;
if (/:8010\b/.test(URL_) && !args.includes('--force')) {
  console.error('noise: refusing :8010 (the real library); use a scratch web app'); process.exit(2);
}
if (!PHOTO) { console.error('noise: --photo ID (a raw, for --ai)'); process.exit(2); }
if (!SOCK) { console.error('noise: source the scratch engine\'s env file (DTAPI_SOCKET) first'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const log = (s) => { if (!BRIEF) console.log(s); };
function check(name, ok, detail = '') {
  results.push({name, ok, detail});
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ': ' + detail}`);
}

// one engine call on a connection of our own
function engine(method, params) {
  return new Promise((ok, bad) => {
    const s = net.createConnection(SOCK);
    let buf = '';
    s.on('connect', () => s.write(JSON.stringify({jsonrpc: '2.0', id: 1, method, params}) + '\n'));
    s.on('data', (d) => {
      buf += d;
      for (const line of buf.split('\n').slice(0, -1)) {
        const m = JSON.parse(line);
        if (m.id === 1) { s.end(); return m.error ? bad(new Error(m.error.message)) : ok(m.result); }
      }
    });
    s.on('error', bad);
  });
}
const dn = async () => {
  const g = await engine('module_get', {imgid: PHOTO, operation: 'denoiseprofile', instance: 0});
  return {enabled: g.enabled, ...Object.fromEntries(g.fields.map((f) => [f.name, f.value]))};
};
async function until(f, ms = 15000) {
  let v;
  for (const t = Date.now(); Date.now() - t < ms; await sleep(200)) if ((v = await f())) return v;
  return v;
}
const sum = (p) => p.eval(`document.querySelector('details[data-sec=noise] summary .sum')?.textContent`);
const rendered = `(() => { const i = document.querySelector('#pv');
  return i && i.src.startsWith('blob:') && i.complete && i.naturalWidth > 0; })()`;

async function loadPhoto(page) {
  await page.goto(`${URL_}/photo/${PHOTO}`);
  await page.waitFor(`/opened in/.test(document.querySelector('#status')?.textContent || '')`, {timeout: 60000, what: 'the photo opening'});
  await page.waitFor(rendered, {timeout: 60000, what: 'the first render'});
  if (await page.eval("!document.querySelector('#save').disabled")) throw new Error(`photo ${PHOTO} has unsaved changes; not touching it`);
}
async function discard(page) {
  if (await page.eval("!document.querySelector('#save').disabled")) {
    await page.eval("document.querySelector('#reload').click()");
    await page.waitFor("document.querySelector('dialog[open] .ask-ok')", {what: 'the discard question'});
    await page.click('dialog[open] .ask-ok');
  }
  await page.waitFor("document.querySelector('#save').disabled", {timeout: 30000, what: 'nothing to save'});
}
// the section's checkbox, and the engine following it
const toggle = (p) => p.eval(`document.querySelector('details[data-sec=noise] .head input[type=checkbox]').click(); 1`);
// open the section like a user (a tap on a phone also raises the sheet)
async function open(p) {
  if (p.touch && !await p.eval("document.body.classList.contains('sheet-up')")) await p.click('#sheet-handle');
  if (!await p.eval("document.querySelector('details[data-sec=noise]').open")) await p.click('details[data-sec=noise] summary');
  return p.eval("document.querySelector('details[data-sec=noise]').open");
}

const chrome = await startChrome({port: PORT});
let page;
try {
  page = await openPage(PORT);
  await page.desktop();
  await loadPhoto(page);
  const had = await page.eval("!!document.querySelector('details[data-sec=noise]')");
  check('noise section exists', had);
  if (had) {
    check('noise section opens', await open(page) && await page.eval("document.querySelector('details[data-sec=noise] .sec-body').getBoundingClientRect().height > 0"));
    check('not listed again under "also in this edit"', await page.eval(
      `![...document.querySelectorAll('details[data-sec=others] .other button.link')].some((b) => b.textContent === 'denoise (profiled)')`));
    const before = await dn();
    const s0 = await sum(page);
    // the module as it is: switch it to the opposite and the engine follows
    await toggle(page);
    const on = !before.enabled;
    check(`denoise ${on ? 'on' : 'off'} in the engine`, !!await until(async () => (await dn()).enabled === on), JSON.stringify(await dn()));
    if (!(await dn()).enabled) await toggle(page), await until(async () => (await dn()).enabled);
    check('denoise on in the engine', (await dn()).enabled);

    // strength: the slider
    const want = 0.7;
    await page.click('details[data-sec=noise] [data-field=strength] button.val');
    await page.waitFor("document.querySelector('dialog[open] .ask-val')", {what: 'the value question'});
    await page.eval(`(() => { const i = document.querySelector('dialog[open] .ask-val'); i.value = '${want}'; 1; })()`);
    await page.click('dialog[open] .ask-ok');
    check('strength in the engine', !!await until(async () => Math.abs((await dn()).strength - want) < 1e-3), `engine ${(await dn()).strength}`);
    check('summary shows the change', !!await until(async () => /strength 0\.70/.test(await sum(page) || '')), `was "${s0}", now "${await sum(page)}"`);

    // mode: the dropdown
    const m0 = (await dn()).mode;
    const m1 = await page.eval(`(() => { const s = document.querySelector('details[data-sec=noise] [data-field=mode] select');
      const o = [...s.options].map((x) => x.value).find((v) => v !== s.value && !/AUTO|VARIANCE/.test(v));
      s.value = o; s.dispatchEvent(new Event('change', {bubbles: true})); return o; })()`);
    check('mode in the engine', !!await until(async () => (await dn()).mode === m1), `was ${m0}, wanted ${m1}, engine ${(await dn()).mode}`);

    // judge at 100%
    await page.waitFor(rendered, {timeout: 60000, what: 'a render after the changes'});
    await page.eval(`[...document.querySelectorAll('details[data-sec=noise] button')].find((b) => /judge at 100%/.test(b.textContent)).click()`);
    check('100% zoom is on', !!await until(() => page.eval("document.querySelector('.zoom button[data-zoom=\"1\"]').classList.contains('on')"), 20000));
    check('the view renders at 100%', !!await until(() => page.eval(rendered), 60000));
    await page.eval(`document.querySelector('.zoom button[data-zoom="0"]').click()`);

    if (AI) {
      const t0 = Date.now();
      const has = await page.eval("!!document.querySelector('#ai-denoise-out')");
      check('AI denoise button shown (raw, engine has it)', has);
      if (has) {
        await page.eval(`[...document.querySelectorAll('details[data-sec=noise] button')].find((b) => /denoised copy/.test(b.textContent)).click()`);
        const href = await page.waitFor(`document.querySelector('#ai-denoise-out a')?.getAttribute('href')
          || (/not denoised/.test(document.querySelector('#status').textContent) && document.querySelector('#status').textContent)`,
          {timeout: 700000, every: 1000, what: 'the AI denoise result'}).catch((e) => String(e));
        const n = (/^\/photo\/(\d+)$/.exec(href) || [])[1];
        let exists = false;
        if (n) { try { exists = !!(await engine('image_info', {imgid: +n})).image; } catch {} }
        check(`AI denoise: link to the new photo (${href}, ${((Date.now() - t0) / 1000).toFixed(0)} s)`, !!n && exists, `got ${href}`);
        if (n) console.log(`ai: new photo ${n} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      }
    }

    await discard(page);
    check('discarded: engine back to the saved state', JSON.stringify(await dn()) === JSON.stringify(before), `${JSON.stringify(before)} vs ${JSON.stringify(await dn())}`);
  }
  check('desktop: no page errors', !page.errors.length, page.errors.slice(0, 3).join(' | '));
  await page.close();

  // phone: the section opens in the sheet, the toggle works
  page = await openPage(PORT);
  await page.phone();
  await loadPhoto(page);
  const before = await dn();
  check('phone: noise section opens', await open(page) && await page.eval("document.querySelector('details[data-sec=noise] .sec-body').getBoundingClientRect().height > 0"));
  const vis = await page.eval(`(() => { const r = document.querySelector('details[data-sec=noise] .head input').getBoundingClientRect();
    return r.width > 0 && r.right <= innerWidth + 1; })()`);
  check('phone: toggle is on screen', vis);
  await page.click('details[data-sec=noise] .head input[type=checkbox]').catch(() => toggle(page));
  check('phone: toggle changes the engine', !!await until(async () => (await dn()).enabled !== before.enabled), JSON.stringify(await dn()));
  await discard(page);
  check('phone: no page errors', !page.errors.length, page.errors.slice(0, 3).join(' | '));
} catch (e) {
  check('run', false, e.stack || String(e));
  if (page) await page.screenshot('/tmp/noise-fail.png').catch(() => {});
} finally {
  await page?.close().catch(() => {});
  await chrome.stop();
}

const failed = results.filter((r) => !r.ok);
if (BRIEF) console.log(failed.length ? failed.map((r) => `FAIL ${r.name}: ${r.detail}`).join('\n')
                                     : `noise: ${results.length}/${results.length} passed`);
else console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
