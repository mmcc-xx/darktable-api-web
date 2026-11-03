#!/usr/bin/env node
// The photo tab in front is "this photo" for Claude (W34) over CDP: two tabs
// on two photos, focus one then the other; the engine's "web" client's
// current photo (what MCP library_status gives as web_imgid, #121) and
// /api/tabs follow. A tab that goes hidden or closes doesn't change it; a
// tab refreshing after another client's change doesn't take it either.
// Scratch web app only (:8030), never :8010; DTAPI_SOCKET from the scratch's
// env file (scratch.sh up), for the engine check. Nothing is edited or saved.
//
//   node tests/tabfocus.mjs --a 409 --b 472 [--url http://127.0.0.1:8030] [--port 9333] [--brief]

import net from 'node:net';
import {startChrome, openPage} from './cdp.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i < 0 ? dflt : args[i + 1]; };
const URL_ = opt('url', 'http://127.0.0.1:8030').replace(/\/$/, '');
const PORT = +opt('port', 9333);
const A = +opt('a', 409), B = +opt('b', 472);
const BRIEF = args.includes('--brief');
const SOCK = process.env.DTAPI_SOCKET;
if (/:8010\b/.test(URL_) && !args.includes('--force')) {
  console.error('tabfocus: refusing :8010 (the real library); use a scratch web app'); process.exit(2);
}
if (!SOCK) { console.error('tabfocus: source the scratch engine\'s env file (DTAPI_SOCKET) first'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const log = (s) => { if (!BRIEF) console.log(s); };

// the engine's clients, on a connection of our own
function engineClients() {
  return new Promise((ok, bad) => {
    const s = net.createConnection(SOCK);
    let buf = '';
    s.on('connect', () => s.write(JSON.stringify({jsonrpc: '2.0', id: 1, method: 'clients', params: {}}) + '\n'));
    s.on('data', (d) => {
      buf += d;
      for (const line of buf.split('\n').slice(0, -1)) {
        const m = JSON.parse(line);
        if (m.id === 1) { s.end(); return m.error ? bad(new Error(m.error.message)) : ok(m.result.clients); }
      }
    });
    s.on('error', bad);
  });
}
const webImgid = async () => (await engineClients()).filter((c) => c.kind === 'web').map((c) => c.imgid).pop();
const tabs = () => fetch(`${URL_}/api/tabs`).then((r) => r.json());

async function until(f, want, ms = 10000) {
  let v;
  for (const t = Date.now(); Date.now() - t < ms; await sleep(200)) if ((v = await f()) === want) return v;
  return v;
}

function check(name, ok, detail = '') {
  results.push({name, ok, detail});
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ': ' + detail}`);
}

async function loadPhoto(page, id) {
  await page.send('Emulation.setFocusEmulationEnabled', {enabled: true});
  await page.goto(`${URL_}/photo/${id}`);
  for (let i = 0; i < 150; i++) {
    if (await page.eval(`/opened in/.test(document.querySelector('#status')?.textContent || '')`)) return;
    await sleep(200);
  }
  throw new Error(`photo ${id} didn't open`);
}
// what a tab says when the user comes back to it: blur, then focus
const focus = (page) => page.eval(`dispatchEvent(new Event('blur')); dispatchEvent(new Event('focus')); 1`);
const hide = (page) => page.eval(`Object.defineProperty(document, 'visibilityState', {value: 'hidden', configurable: true});
  document.dispatchEvent(new Event('visibilitychange')); 1`);

const chrome = await startChrome({port: PORT});
let pa, pb;
try {
  pa = await openPage(PORT);
  await loadPhoto(pa, A);
  check(`tab A open: this photo is ${A}`, await until(webImgid, A) === A, `engine says ${await webImgid()}`);
  pb = await openPage(PORT);
  await loadPhoto(pb, B);
  check(`tab B open: this photo is ${B}`, await until(webImgid, B) === B, `engine says ${await webImgid()}`);
  let t = await tabs();
  check('two photo tabs, B focused', t.tabs.length === 2 && t.focused.imgid === B, JSON.stringify(t));

  await focus(pa);
  check(`focus A: this photo is ${A}`, await until(webImgid, A) === A, `engine says ${await webImgid()}`);
  t = await tabs();
  check('/api/tabs: A focused, A first', t.focused.imgid === A && t.tabs[0].imgid === A, JSON.stringify(t));

  await focus(pb);
  check(`focus B: this photo is ${B}`, await until(webImgid, B) === B, `engine says ${await webImgid()}`);

  // another client's change to A: tab A refreshes (open?refresh=true) but B stays in front
  const r = await fetch(`${URL_}/api/photo/${A}/open?refresh=true`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'});
  check('A refreshing keeps B', r.ok && await webImgid() === B, `status ${r.status}, engine says ${await webImgid()}`);

  await hide(pb);
  await sleep(500);
  check('B hidden: still B', await webImgid() === B && (await tabs()).focused.imgid === B, `engine says ${await webImgid()}`);

  await pb.close(); pb = null;
  await until(async () => (await tabs()).tabs.length, 1, 5000);
  t = await tabs();
  check('B closed: one tab left, still B', t.tabs.length === 1 && t.tabs[0].imgid === A && await webImgid() === B,
        `${JSON.stringify(t)}, engine says ${await webImgid()}`);
  check('no page errors', !pa.errors.length, pa.errors.join('; '));
} catch (e) {
  check('run', false, e.stack || String(e));
} finally {
  for (const p of [pa, pb]) if (p) await p.close().catch(() => {});
  await chrome.stop();
}

const failed = results.filter((r) => !r.ok);
if (BRIEF) console.log(failed.length ? failed.map((r) => `FAIL ${r.name}: ${r.detail}`).join('\n')
                                     : `tabfocus: ${results.length}/${results.length} passed`);
else console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
