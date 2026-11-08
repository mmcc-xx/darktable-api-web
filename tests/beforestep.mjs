#!/usr/bin/env node
// The "before" step of before/after (W81) over CDP: the picker in the comparison's bar, the
// choice kept per photo over close and reload, step 0 as the default, a gone step falling
// back to the original (truncated history, a step now holding another module), an AI's
// comparison not changing the choice, a late render losing to a newer pick or to closing.
// Scratch web app only (:8030), never :8010; the edit is discarded (never saved).
//
//   (source /tmp/dts-N/env; node tests/beforestep.mjs [--url http://127.0.0.1:8030]
//     [--port 9333] [--photo 161] [--other 166] [--only desktop|phone] [--out /tmp/w81] [--brief])

import {mkdirSync} from 'node:fs';
import {startChrome, openPage} from './cdp.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i < 0 ? dflt : args[i + 1]; };
const URL_ = opt('url', 'http://127.0.0.1:8030').replace(/\/$/, '');
const PORT = +opt('port', 9333);
const PHOTO = opt('photo', '161');
const OTHER = opt('other', '166');
const OUT = opt('out', '/tmp/w81');
const ONLY = opt('only', null);
const BRIEF = args.includes('--brief');
if (/:8010\b/.test(URL_) && !args.includes('--force')) {
  console.error('beforestep: refusing :8010 (the real library); use a scratch web app'); process.exit(2);
}
if (!process.env.DTAPI_SOCKET) { console.error('beforestep: source the scratch engine\'s env first (DTAPI_SOCKET)'); process.exit(2); }
mkdirSync(OUT, {recursive: true});

const results = [];
const log = (s) => { if (!BRIEF) console.log(s); };
const assert = (c, m) => { if (!c) throw new Error(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const API = `${URL_}/api/photo/${PHOTO}`;
const JSONH = {'Content-Type': 'application/json'};
const discard = (id = PHOTO) => fetch(`${URL_}/api/photo/${id}/open?fresh=true`, {method: 'POST', headers: JSONH, body: '{}'});
const KEY = `dr:beforestep:${PHOTO}`;
const rendered = `(() => { const i = document.querySelector('#pv'); return i && i.src.startsWith('blob:') && i.complete && i.naturalWidth > 0; })()`;

async function check(mode, page, name, f) {
  try {
    await f();
    results.push({mode, name, ok: true}); log(`ok   ${mode} ${name}`);
    return true;
  } catch (e) {
    const shot = `${OUT}/${mode}-${name.split(' ')[0]}.png`;
    await page.screenshot(shot).catch(() => {});
    results.push({mode, name, ok: false, why: e.message, shot}); log(`FAIL ${mode} ${name}: ${e.message}`);
    return false;
  }
}

// records the before.jpg steps asked for; __beforeDelay[step] holds that reply back (ms)
const SPY = `(() => {
  if (window.__before) return;
  window.__before = []; window.__beforeDelay = {};
  const f = window.fetch;
  window.fetch = async (u, o) => {
    const m = String(u).match(/before\\.jpg\\?step=(\\d+)/);
    if (!m) return f(u, o);
    window.__before.push(+m[1]);
    const r = await f(u, o);
    const d = window.__beforeDelay[m[1]];
    if (d) await new Promise((ok) => setTimeout(ok, d));
    return r;
  };
})()`;

const cmpOpen = `!document.querySelector('#cmp-bar').hidden && document.querySelector('#cmp-step').options.length > 1`;
const value = (page) => page.eval(`+document.querySelector('#cmp-step').value`);
const asked = (page) => page.eval(`window.__before.slice()`);
const stored = (page, key = KEY) => page.eval(`localStorage.getItem(${JSON.stringify(key)})`);
const pick = (page, n) => page.eval(`void (document.querySelector('#cmp-step').value = ${n}, document.querySelector('#cmp-step').dispatchEvent(new Event('change')))`);

async function run(mode, port) {
  const page = await openPage(port);
  const c = (n, f) => check(mode, page, n, f);
  const phone = mode === 'phone';
  const press = (sel) => phone ? page.tap(sel) : page.click(sel);
  const load = async (id = PHOTO) => {
    await page.goto(`${URL_}/photo/${id}`);
    await page.waitFor(rendered, {timeout: 60000, what: 'the first render'});
    await page.eval(SPY);
  };
  // the ⇆ button, and the comparison open on the step expected
  const openIt = async (step) => {
    const n = (await asked(page)).length;
    await press('#compare');
    await page.waitFor(`window.__before.length > ${n} && ${cmpOpen}`, {what: 'the comparison'});
    await page.waitFor(`+document.querySelector('#cmp-step').value === ${step}`, {what: `step ${step} selected`});
    const a = await asked(page);
    assert(a[a.length - 1] === step, `asked for step ${a[a.length - 1]}, expected ${step}`);
  };
  const closeIt = async () => { await press('#cmp-close'); await page.waitFor(`document.querySelector('#cmp-bar').hidden`, {what: 'the bar closed'}); };
  try {
    if (phone) await page.phone(); else await page.desktop();
    await discard();
    await page.goto(`${URL_}/photo/${PHOTO}`);
    await page.eval(`void localStorage.removeItem(${JSON.stringify(KEY)})`);
    if (!await c('1 opens on the original, the picker lists the history', async () => {
      await load();
      await openIt(0);
      const n = await page.eval(`document.querySelector('#cmp-step').options.length`);
      assert(n === await page.eval(`document.querySelectorAll('#history li').length`), `${n} options against the history panel's rows`);
      assert(await page.eval(`document.querySelector('#cmp-step').options[0].text`) === 'the original', 'first option is not the original');
      assert(!await stored(page), 'step 0 got stored');
    })) return;

    await c('2 picking a step shows it and stores it', async () => {
      const src = await page.eval(`document.querySelector('#cmp-before').src`);
      await pick(page, 10);
      await page.waitFor(`document.querySelector('#cmp-before').src !== ${JSON.stringify(src)}`, {what: 'a new before image'});
      const a = await asked(page);
      assert(a[a.length - 1] === 10, `asked for ${a[a.length - 1]}`);
      assert(await value(page) === 10, 'picker moved');
      assert(JSON.parse(await stored(page)).step === 10, 'not stored');
    });
    await c('3 the bar fits the screen', async () => {
      const r = await page.eval(`(() => { const b = document.querySelector('#cmp-bar').getBoundingClientRect(), s = document.querySelector('#cmp-step').getBoundingClientRect(); return {l: b.left, r: b.right, sl: s.left, sr: s.right, w: innerWidth, sw: document.documentElement.scrollWidth}; })()`);
      assert(r.sr <= r.w && r.sl >= 0 && r.r <= r.w + 1, `bar or picker off screen: ${JSON.stringify(r)}`);
      assert(r.sw <= r.w, `page scrolls sideways: ${r.sw} > ${r.w}`);
      await page.screenshot(`${OUT}/${mode}-bar.png`);
    });
    await c('4 close, reopen: still that step', async () => { await closeIt(); await openIt(10); });
    await c('5 kept over a reload', async () => { await closeIt(); await load(); await openIt(10); });
    await c('6 another photo has its own: the original', async () => {
      await closeIt();
      await load(OTHER);
      await openIt(0);
      assert(!await stored(page, `dr:beforestep:${OTHER}`), 'the other photo got a choice');
      await closeIt();
      await discard(OTHER);
      await load();
    });
    await c('7 an AI\'s comparison (#compare=N) leaves the choice alone', async () => {
      await page.goto('about:blank');
      await page.goto(`${URL_}/photo/${PHOTO}#compare=5`);
      await page.waitFor(rendered, {timeout: 60000, what: 'the render'});
      await page.waitFor(cmpOpen, {what: 'the comparison'});
      await page.waitFor(`+document.querySelector('#cmp-step').value === 5`, {what: 'step 5 selected'});
      assert(JSON.parse(await stored(page)).step === 10, 'the choice changed');
      await page.eval(SPY);
      await closeIt();
      await openIt(10);
      await closeIt();
      await page.goto(`${URL_}/photo/${PHOTO}`);
      await load();
    });
    await c('8 a step holding another module now: back to the original', async () => {
      const good = await stored(page);
      await page.eval(`void localStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(JSON.stringify({step: 10, key: 'nosuch:0'}))})`);
      await openIt(0);
      assert(!await stored(page), 'stale choice kept');
      await closeIt();
      await page.eval(`void localStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(good)})`);
    });
    await c('9 a step past the end: back to the original', async () => {
      const good = await stored(page);
      await page.eval(`void localStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(JSON.stringify({step: 9999, key: 'exposure:0'}))})`);
      await openIt(0);
      assert(!await stored(page), 'stale choice kept');
      await closeIt();
      await page.eval(`void localStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(good)})`);
    });
    await c('10 a late render loses to a newer pick', async () => {
      await openIt(10);
      await page.eval(`window.__beforeDelay[3] = 1500`);
      const old = await page.eval(`document.querySelector('#cmp-before').src`);
      await pick(page, 3);
      await sleep(200);
      await pick(page, 4);
      await page.waitFor(`document.querySelector('#cmp-before').src !== ${JSON.stringify(old)}`, {what: 'step 4 shown'});
      const src = await page.eval(`document.querySelector('#cmp-before').src`);
      await sleep(2000);
      assert(await page.eval(`document.querySelector('#cmp-before').src`) === src, 'the late step 3 replaced step 4');
      assert(await value(page) === 4, 'picker moved back');
      assert(JSON.parse(await stored(page)).step === 4, 'last pick not stored');
    });
    await c('11 closing beats a render on its way', async () => {
      await page.eval(`window.__beforeDelay[6] = 1500`);
      await pick(page, 6);
      await sleep(200);
      await closeIt();
      await sleep(2000);
      assert(await page.eval(`document.querySelector('#cmp-bar').hidden`), 'the comparison came back');
    });
    await c('12 a step cut off by undo + a new edit, while open: the original', async () => {
      await openIt(6);
      const hist = await (await fetch(`${API}/open?refresh=true`, {method: 'POST', headers: JSONH, body: '{}'})).json();
      const len = hist.history.items.length;
      assert(len >= 20, `only ${len} steps on photo ${PHOTO}`);
      await pick(page, len);
      await page.waitFor(`window.__before[window.__before.length - 1] === ${len}`, {what: 'the last step asked'});
      await page.waitFor(`+document.querySelector('#cmp-step').value === ${len}`, {what: 'last step selected'});
      // through the page's own controls: its own requests come back with no event
      await page.eval(`[...document.querySelectorAll('#history button.link')].find((b) => b.textContent.startsWith('${len - 3} ')).click()`);
      await page.waitFor(`document.querySelector('#hist-text').textContent.startsWith('step ${len - 3} of')`, {timeout: 20000, what: 'the undo'});
      await page.eval(`document.querySelector('.module[data-op="exposure"][data-inst="0"] input[type=checkbox]').click()`);
      await page.waitFor(`+document.querySelector('#cmp-step').value === 0`, {timeout: 20000, what: 'fall back to the original'});
      await page.waitFor(`window.__before[window.__before.length - 1] === 0`, {what: 'step 0 asked'});
      await closeIt();
      await openIt(0);
      assert(!await stored(page), 'the gone step is still stored');
      await closeIt();
    });
    await c('13 no js errors', async () => { assert(!page.errors.length, page.errors.join('; ')); });
    await page.eval(`void localStorage.removeItem(${JSON.stringify(KEY)})`);
    await discard();
  } finally { await page.close(); }
}

const chrome = await startChrome({port: PORT});
try {
  for (const mode of ['desktop', 'phone']) if (!ONLY || ONLY === mode) await run(mode, chrome.port);
} finally {
  await discard().catch(() => {});
  await chrome.stop();
}
const bad = results.filter((r) => !r.ok);
for (const r of bad) console.log(`FAIL ${r.mode} ${r.name}: ${r.why}${r.shot ? ' (' + r.shot + ')' : ''}`);
console.log(bad.length ? `beforestep: ${results.length - bad.length}/${results.length} passed, ${bad.length} failed` : `beforestep: ${results.length}/${results.length} passed (${URL_}, photo ${PHOTO})`);
process.exit(bad.length ? 1 : 0);
