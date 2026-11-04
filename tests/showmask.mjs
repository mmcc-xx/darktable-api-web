#!/usr/bin/env node
// Show the mask of any module instance (W62) over CDP: an exposure instance at
// +0.9 EV with a parametric chroma mask and color balance rgb with a drawn
// circle (both made through the MCP server, tests/showmask_mcp.py) get a "show
// mask" toggle in the pipeline view and in the history; the preview then asks
// for mask_op + mask_instance and shows the mask in yellow, as MCP
// render_preview(show_mask=...) does; the overlay stays on after another
// client (the MCP) changes the edit, and turns off from the chip on the photo.
// Scratch web app only (:8030), never :8010; the edit is discarded (never saved).
//
//   (source /tmp/dts-N/env; node tests/showmask.mjs [--url http://127.0.0.1:8030]
//     [--photo 161] [--only desktop|phone] [--out /tmp/w62] [--brief])

import {mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {startChrome, openPage} from './cdp.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i < 0 ? dflt : args[i + 1]; };
const URL_ = opt('url', 'http://127.0.0.1:8030').replace(/\/$/, '');
const PORT = +opt('port', 9333);
const PHOTO = opt('photo', '161');
const OUT = opt('out', '/tmp/w62');
const ONLY = opt('only', null);
const BRIEF = args.includes('--brief');
const PY = process.env.PYTHON || `${homedir()}/darktableluamcp/venv/bin/python`;
if (/:8010\b/.test(URL_) && !args.includes('--force')) {
  console.error('showmask: refusing :8010 (the real library); use a scratch web app'); process.exit(2);
}
if (!process.env.DTAPI_SOCKET) { console.error('showmask: source the scratch engine\'s env first (DTAPI_SOCKET)'); process.exit(2); }
mkdirSync(OUT, {recursive: true});

const results = [];
const log = (s) => { if (!BRIEF) console.log(s); };
const assert = (c, m) => { if (!c) throw new Error(m); };
const API = `${URL_}/api/photo/${PHOTO}`;
const mcp = (...a) => {
  const out = execFileSync(PY, [new URL('./showmask_mcp.py', import.meta.url).pathname, ...a], {encoding: 'utf8', timeout: 300000}).trim().split('\n').pop();
  const j = JSON.parse(out);
  if (!j.ok) throw new Error('mcp: ' + out);
  return j;
};
const discard = () => fetch(`${API}/open?fresh=true`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'});
const rendered = `(() => { const i = document.querySelector('#pv'); return i && i.src.startsWith('blob:') && i.complete && i.naturalWidth > 0; })()`;
// the shown preview's yellow fraction (the mask overlay)
const yellowShown = `(async () => { const i = document.querySelector('#pv'); const bmp = await createImageBitmap(await (await fetch(i.src)).blob());
  const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0;
  for (let k = 0; k < d.length; k += 4) if (d[k] > 120 && d[k + 1] > 100 && d[k + 2] < 0.6 * d[k + 1]) n++;
  return n / (d.length / 4); })()`;
const lastPv = `(window.__pv || []).slice(-1)[0] || ''`;

async function check(mode, page, name, f) {
  const t = Date.now();
  try {
    const note = await f();
    results.push({mode, name, ok: true});
    log(`ok   ${mode} ${name} (${Date.now() - t} ms)${note ? ': ' + note : ''}`);
    return true;
  } catch (e) {
    const shot = await page.screenshot(`${OUT}/FAIL-${mode}-${name.replace(/\W+/g, '-')}.png`).catch(() => '');
    results.push({mode, name, ok: false, why: e.message, shot});
    log(`FAIL ${mode} ${name}: ${e.message} (${shot})`);
    return false;
  }
}

async function run(mode, port) {
  await discard();
  const {exposure: ei} = mcp('setup', PHOTO);
  const page = await openPage(port);
  const c = (name, f) => check(mode, page, name, f);
  try {
    if (mode === 'phone') await page.phone(); else await page.desktop();
    // every preview request the page makes, newest last
    await page.send('Page.addScriptToEvaluateOnNewDocument', {source: `window.__pv = []; const f0 = window.fetch;
      window.fetch = (u, ...a) => { if (String(u).includes('/preview.jpg')) window.__pv.push(String(u)); return f0(u, ...a); };`});
    await c('the page opens on the MCP\'s edit', async () => {
      await page.goto(`${URL_}/photo/${PHOTO}`);
      await page.waitFor(rendered, {timeout: 60000, what: 'the first render'});
      assert(await page.eval("document.querySelector('#maskshow').hidden"), 'the mask chip shows before anything is asked');
    });
    await c('pipeline view: toggles on the masked instances only', async () => {
      await page.click('[data-view=pipeline]');
      await page.waitFor(`!!document.querySelector('#pipeline .prow[data-key="exposure:${ei}"] [data-maskshow]')`, {what: `exposure ${ei}'s toggle`});
      const keys = await page.eval(`[...document.querySelectorAll('#pipeline [data-maskshow]')].map((b) => b.dataset.maskshow + '=' + b.textContent)`);
      assert(keys.includes(`exposure:${ei}=parametric`) && keys.some((k) => k.startsWith('colorbalancergb:0=') && /drawn/.test(k)), 'toggles: ' + keys);
      assert(!keys.some((k) => k.startsWith('exposure:0=')), 'a toggle on the unmasked exposure: ' + keys);
      return keys.join(', ');
    });
    let yOff = 0, yExp = 0;
    await c(`show exposure ${ei}'s parametric mask: mask_op in the preview, yellow`, async () => {
      yOff = await page.eval(yellowShown);
      const src = await page.eval("document.querySelector('#pv').src");
      await page.eval(`document.querySelector('#pipeline .prow[data-key="exposure:${ei}"] [data-maskshow]').click()`);
      await page.waitFor(`document.querySelector('#pv').src !== ${JSON.stringify(src)} && ${rendered}`, {what: 'a new render'});
      const u = await page.eval(lastPv);
      assert(u.includes(`mask_op=exposure&mask_instance=${ei}`), 'preview url: ' + u);
      assert(await page.eval(`document.querySelector('#pipeline .prow[data-key="exposure:${ei}"] [data-maskshow]').getAttribute('aria-pressed')`) === 'true', 'toggle not pressed');
      assert(!await page.eval("document.querySelector('#maskshow').hidden"), 'no chip on the photo');
      const y = await page.eval(yellowShown);
      assert(y > yOff + 0.02, `yellow ${y.toFixed(3)} vs ${yOff.toFixed(3)} without the mask`);
      yExp = y;
      return `yellow ${y.toFixed(3)} (without ${yOff.toFixed(3)})`;
    });
    if (mode === 'desktop') await c('the web preview matches MCP render_preview(show_mask=...)', async () => {
      for (const [op, inst] of [['exposure', ei], ['colorbalancergb', 0]]) {
        const r = mcp('compare', PHOTO, URL_, op, String(inst));
        assert(!r.x_mask && r.diff < 3 && Math.abs(r.yellow_web - r.yellow_mcp) < 0.01 && r.yellow_web > 0.01, `${op} ${inst}: ` + JSON.stringify(r));
      }
    });
    await c('another client\'s change: re-rendered, the mask still shown', async () => {
      const src0 = await page.eval("document.querySelector('#pv').src");
      mcp('change', PHOTO, 'exposure', String(ei));
      await page.waitFor(`document.querySelector('#pv').src !== ${JSON.stringify(src0)} && ${rendered}`, {timeout: 60000, what: 'the re-render after the MCP change'});
      const u = await page.eval(lastPv);
      assert(u.includes(`mask_op=exposure&mask_instance=${ei}`), 'preview url: ' + u);
      assert(await page.eval(`document.querySelector('#pipeline .prow[data-key="exposure:${ei}"] [data-maskshow]').getAttribute('aria-pressed')`) === 'true', 'toggle lost after the re-render');
    });
    await c('history: the color balance rgb step\'s toggle shows its drawn mask', async () => {
      await page.click('#hist-line');
      await page.waitFor(`!document.querySelector('#hist-pop').hidden && !!document.querySelector('#history [data-maskshow="colorbalancergb:0"]')`, {what: 'the toggle in the history'});
      const src0 = await page.eval("document.querySelector('#pv').src");
      await page.eval(`document.querySelector('#history [data-maskshow="colorbalancergb:0"]').click()`);
      await page.waitFor(`document.querySelector('#pv').src !== ${JSON.stringify(src0)} && ${rendered}`, {what: 'a new render'});
      const u = await page.eval(lastPv);
      assert(u.includes('mask_op=colorbalancergb&mask_instance=0'), 'preview url: ' + u);
      const on = await page.eval(`[...document.querySelectorAll('[data-maskshow][aria-pressed=true]')].map((b) => b.dataset.maskshow)`);
      assert(on.length && on.every((k) => k === 'colorbalancergb:0'), 'pressed: ' + on);
      assert(/color balance rgb/.test(await page.eval("document.querySelector('#maskshow').textContent")), 'chip: ' + await page.eval("document.querySelector('#maskshow').textContent"));
      const y = await page.eval(yellowShown);
      assert(y > yOff + 0.02 && Math.abs(y - yExp) > 0.02, `color balance rgb's yellow ${y.toFixed(3)}: like none (${yOff.toFixed(3)}) or exposure's (${yExp.toFixed(3)})`);
      await page.click('#hist-line');
      await page.screenshot(`${OUT}/${mode}-cbrgb-mask.png`);
    });
    await c('the chip on the photo hides the mask', async () => {
      const src0 = await page.eval("document.querySelector('#pv').src");
      await page.click('#maskshow');
      await page.waitFor(`document.querySelector('#pv').src !== ${JSON.stringify(src0)} && ${rendered} && document.querySelector('#maskshow').hidden`, {what: 'a render without the mask'});
      const u = await page.eval(lastPv);
      assert(!u.includes('mask_op'), 'preview url: ' + u);
      assert(!await page.eval(`document.querySelector('[data-maskshow][aria-pressed=true]')`), 'a toggle still pressed');
    });
    await c('a module without a mask: plain render, reason in X-Mask', async () => {
      const r = await fetch(`${API}/preview.jpg?w=300&h=300&mask_op=exposure&mask_instance=0`);
      assert(r.ok && r.headers.get('content-type') === 'image/jpeg' && /mask/.test(r.headers.get('X-Mask') || ''), r.status + ' X-Mask: ' + r.headers.get('X-Mask'));
      const old = await fetch(`${API}/preview.jpg?w=300&h=300&mask=${ei}`);
      assert(old.ok, 'old mask=N: ' + old.status);
      assert(!page.errors.length, page.errors.join('; '));
    });
  } finally { await page.close(); await discard(); }
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
console.log(bad.length ? `showmask: ${results.length - bad.length}/${results.length} passed, ${bad.length} failed` : `showmask: ${results.length}/${results.length} passed (${URL_}, photo ${PHOTO})`);
process.exit(bad.length ? 1 : 0);
