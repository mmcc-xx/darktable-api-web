#!/usr/bin/env node
// The page's send queue after a failed change (BUGS #170): one module change
// whose request fails (fetch rejects, as on a dropped connection) shows
// "not applied" in the status line, and the next change still reaches the
// engine. Before the fix the queue stayed busy: later slider moves and typed
// values changed the panel but were never sent. Scratch web app only (:8030),
// never :8010; the edit is discarded (never saved).
//
//   (source /tmp/dts-N/env; node tests/sendqueue.mjs [--url http://127.0.0.1:8030]
//     [--photo ID] [--out /tmp/dtweb-sendqueue] [--brief])

import {mkdirSync} from 'node:fs';
import {startChrome, openPage} from './cdp.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i < 0 ? dflt : args[i + 1]; };
const URL_ = opt('url', 'http://127.0.0.1:8030').replace(/\/$/, '');
const PORT = +opt('port', 9333);
const OUT = opt('out', '/tmp/dtweb-sendqueue');
const BRIEF = args.includes('--brief');
let PHOTO = opt('photo', null);
if (/:8010\b/.test(URL_)) { console.error('sendqueue: refusing :8010 (the real library); use a scratch web app'); process.exit(2); }
mkdirSync(OUT, {recursive: true});

const results = [];
const log = (s) => { if (!BRIEF) console.log(s); };
const rendered = `(() => { const i = document.querySelector('#pv'); return i && i.src.startsWith('blob:') && i.complete && i.naturalWidth > 0; })()`;
const slider = `document.querySelector('#panels .field[data-field="exposure"] input[type=range]')`;
const move = (v) => `(() => { const s = ${slider}; s.value = ${v}; s.dispatchEvent(new Event('input', {bubbles: true})); return +s.value; })()`;

async function check(page, name, f) {
  try {
    const note = await f();
    results.push({name, ok: true});
    log(`ok   ${name}${note ? ': ' + note : ''}`);
    return true;
  } catch (e) {
    const shot = await page.screenshot(`${OUT}/FAIL-${name.replace(/\W+/g, '-')}.png`).catch(() => '');
    results.push({name, ok: false, why: e.message});
    log(`FAIL ${name}: ${e.message} (${shot})`);
    return false;
  }
}

const chrome = await startChrome({port: PORT});
const page = await openPage(PORT);
const c = (name, f) => check(page, name, f);
const engineEv = async () => {
  const g = await (await fetch(`${URL_}/api/photo/${PHOTO}/module?operation=exposure&instance=0`)).json();
  return g.fields.find((f) => f.name === 'exposure').value;
};
try {
  await page.desktop();
  if (!PHOTO) {
    await page.goto(URL_ + '/');
    await page.waitFor("document.querySelectorAll('figure.tile[data-id]').length", {what: 'photo tiles'});
    PHOTO = await page.eval("document.querySelector('figure.tile[data-id]').dataset.id");
  }
  await fetch(`${URL_}/api/photo/${PHOTO}/open?fresh=true`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'});
  let ok = await c('photo opens', async () => {
    await page.goto(`${URL_}/photo/${PHOTO}`);
    await page.waitFor(rendered, {timeout: 60000, what: 'the first render'});
    await page.waitFor(`!!${slider}`, {what: 'the exposure slider'});
    return `photo ${PHOTO}`;
  });
  if (ok) ok = await c('a failed change says so', async () => {
    // the next /set request rejects, as fetch does when the connection drops
    await page.eval(`(() => { const f = window.fetch; window.fetch = (u, o) => {
      if (String(u).endsWith('/set')) { window.fetch = f; return Promise.reject(new TypeError('network down (test)')); }
      return f(u, o); }; })()`);
    await page.eval(move(0.5));
    const s = await page.waitFor(`(() => { const t = document.querySelector('#status').textContent; return /not applied/.test(t) && t; })()`,
      {what: '"not applied" in the status line'});
    return s;
  });
  if (ok) await c('the next change reaches the engine', async () => {
    const v = await page.eval(move(1.25));
    const t = Date.now();
    let ev;
    while (Date.now() - t < 20000) {
      ev = await engineEv();
      if (Math.abs(ev - v) < 1e-3) return `engine exposure ${ev.toFixed(3)}`;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`engine exposure ${ev} after moving the slider to ${v}: the change was never sent`);
  });
} finally {
  await fetch(`${URL_}/api/photo/${PHOTO}/open?fresh=true`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'}).catch(() => {});
  await page.close().catch(() => {});
  await chrome.stop();
}
const bad = results.filter((r) => !r.ok);
console.log(`sendqueue: ${results.length - bad.length}/${results.length}` + (bad.length ? ' — ' + bad.map((r) => `${r.name}: ${r.why}`).join('; ') : ''));
process.exit(bad.length || results.length < 3 ? 1 : 0);
