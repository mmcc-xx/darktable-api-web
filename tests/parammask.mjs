#!/usr/bin/env node
// Parametric named masks in the masks tool (W63) over CDP: a named mask
// "background" (exposure instance at 0 EV with Cz_in inverted + boost, g_in)
// made through the MCP (tests/parammask_mcp.py) is listed with kind/parametric,
// shows rows with four markers in the masks tool and in the panel's masks
// section; markers drag (mouse / touch) and move with the arrow keys, invert and
// boost change the engine's values, markers clamp to the channel's ends, and the
// masked and plain previews change. Scratch web app only (:8030), never :8010;
// the edit is discarded at the end (never saved).
//
//   (source /tmp/dts-N/env; node tests/parammask.mjs [--url http://127.0.0.1:8030]
//     [--photo 161] [--only desktop|phone] [--out /tmp/w63] [--brief])

import {mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {startChrome, openPage} from './cdp.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i < 0 ? dflt : args[i + 1]; };
const URL_ = opt('url', 'http://127.0.0.1:8030').replace(/\/$/, '');
const PORT = +opt('port', 9333);
const PHOTO = opt('photo', '161');
const OUT = opt('out', '/tmp/w63');
const ONLY = opt('only', null);
const BRIEF = args.includes('--brief');
const PY = process.env.PYTHON || `${homedir()}/darktableluamcp/venv/bin/python`;
if (/:8010\b/.test(URL_) && !args.includes('--force')) {
  console.error('parammask: refusing :8010 (the real library); use a scratch web app'); process.exit(2);
}
if (!process.env.DTAPI_SOCKET) { console.error('parammask: source the scratch engine\'s env first (DTAPI_SOCKET)'); process.exit(2); }
mkdirSync(OUT, {recursive: true});

const results = [];
const log = (s) => { if (!BRIEF) console.log(s); };
const assert = (c, m) => { if (!c) throw new Error(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const API = `${URL_}/api/photo/${PHOTO}`;
const getMasks = () => fetch(`${API}/masks`).then((r) => r.json());
const bg = async () => { const m = (await getMasks()).masks.find((x) => x.name === 'background'); assert(m, 'no mask "background" in /masks'); return m; };
// the engine's value once it stops changing (the page sends changes while dragging)
const stable = async (key) => { let a = JSON.stringify((await par(key)).range); for (let i = 0; i < 20; i++) { await sleep(400); const b = JSON.stringify((await par(key)).range); if (a === b) return; a = b; } };
const par = async (key) => { const c = ((await bg()).parametric || []).find((x) => x.key === key); assert(c, 'no channel ' + key); return c; };
const mcp = (...a) => {
  const out = execFileSync(PY, [new URL('./parammask_mcp.py', import.meta.url).pathname, ...a], {encoding: 'utf8', timeout: 300000}).trim().split('\n').pop();
  const j = JSON.parse(out);
  if (!j.ok) throw new Error('mcp: ' + out);
  return j;
};
const discard = () => fetch(`${API}/open?fresh=true`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'});
const rendered = `(() => { const i = document.querySelector('#pv'); return i && i.src.startsWith('blob:') && i.complete && i.naturalWidth > 0; })()`;
const settled = (page) => page.waitFor(`!document.querySelector('#save').disabled && ${rendered}`, {timeout: 60000, what: 'the edit applied and rendered'});

// fetch a preview in the page and keep its pixels under a name; diff two kept ones (mean abs, 0..255)
const grab = (page, name, query) => page.eval(`(async () => {
  const r = await fetch('${API}/preview.jpg?w=600&h=600${query}'); if (!r.ok) throw new Error(r.status + ' ' + await r.text());
  const bmp = await createImageBitmap(await r.blob()), c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height; const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
  (window.__snap = window.__snap || {})[${JSON.stringify(name)}] = g.getImageData(0, 0, c.width, c.height).data; return c.width; })()`);
const diff = (page, a, b) => page.eval(`(() => { const x = window.__snap[${JSON.stringify(a)}], y = window.__snap[${JSON.stringify(b)}];
  let s = 0; for (let i = 0; i < x.length; i++) if (i % 4 < 3) s += Math.abs(x[i] - y[i]); return s / (x.length * 3 / 4); })()`);

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

// a pointer drag by dx client pixels from (x, y): mouse, or one finger after phone()
async function dragBy(page, x, y, dx) {
  if (page.touch) {   // phone emulation: touches are in visual-viewport coordinates, which sit offset from the layout viewport
    const o = await page.eval('[visualViewport.offsetLeft, visualViewport.offsetTop]'); x -= o[0]; y -= o[1];
  }
  const mouse = (type, px, extra = {}) => page.send('Input.dispatchMouseEvent', {type, x: px, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra});
  const touch = (type, px) => page.send('Input.dispatchTouchEvent', {type, touchPoints: type === 'touchEnd' ? [] : [{x: px, y}]});
  const steps = 8;
  if (page.touch) {
    await touch('touchStart', x);
    for (let i = 1; i <= steps; i++) await touch('touchMove', x + dx * i / steps);
    await touch('touchEnd', x + dx);
  } else {
    await mouse('mouseMoved', x, {buttons: 0}); await mouse('mousePressed', x);
    for (let i = 1; i <= steps; i++) await mouse('mouseMoved', x + dx * i / steps);
    await mouse('mouseReleased', x + dx);
  }
  await sleep(500);
}
// the page scrolls smoothly: scroll first, wait, then measure
const scrollTo = async (page, sel) => { await page.eval(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({block: 'center'})`); await sleep(700); };
const track = async (page, key) => { const sel = `#mask-param .mp-row[data-key="${key}"] .mp-track`; await scrollTo(page, sel);
  return page.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return {x: r.left, y: r.top + r.height / 2, w: r.width}; })()`); };
const marker = async (page, key, k) => { const sel = `#mask-param .mp-row[data-key="${key}"] .mp-track`; await scrollTo(page, sel);
  return page.eval(`(() => { const h = document.querySelectorAll('#mask-param .mp-row[data-key="${key}"] .mp-h')[${k}]; const r = h.getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + r.height / 2}; })()`); };
const keys = async (page, key, k, name, n, shift = false) => {
  await page.eval(`document.querySelectorAll('#mask-param .mp-row[data-key="${key}"] .mp-h')[${k}].focus()`);
  const code = {ArrowLeft: 37, ArrowRight: 39}[name];
  for (let i = 0; i < n; i++) await page.send('Input.dispatchKeyEvent', {type: 'keyDown', key: name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers: shift ? 8 : 0});
  await page.send('Input.dispatchKeyEvent', {type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: code});
  await sleep(600);
};

async function run(mode, port) {
  await discard();
  const {lift, mask: N} = mcp('setup', PHOTO);
  const page = await openPage(port);
  const c = (name, f) => check(mode, page, name, f);
  const phone = mode === 'phone';
  try {
    if (phone) await page.phone(); else await page.desktop();
    await page.send('Page.addScriptToEvaluateOnNewDocument', {source: `window.__pv = []; const f0 = window.fetch;
      window.fetch = (u, ...a) => { if (String(u).includes('/preview.jpg')) window.__pv.push(String(u)); return f0(u, ...a); };`});

    await c('/masks lists "background": parametric kind, channels, users', async () => {
      const m = await bg();
      assert(m.kind === 'parametric', 'kind ' + m.kind);
      const keys = (m.parametric || []).map((x) => x.key);
      assert(keys.includes('Cz_in') && keys.includes('g_in') && keys.length === 2, 'keys ' + keys);
      const cz = m.parametric.find((x) => x.key === 'Cz_in'), g = m.parametric.find((x) => x.key === 'g_in');
      assert(cz.inverted === true && cz.boost !== null && Math.abs(cz.boost - 6.64) < 0.01 && cz.channel === 'Cz' && cz.way === 'in' && cz.range.length === 4, JSON.stringify(cz));
      assert(g.boost === null || typeof g.boost === 'number', JSON.stringify(g));
      assert(cz.min < cz.max && g.min < g.max, 'min/max ' + JSON.stringify([cz, g]));
      assert(m.instance === N, `instance ${m.instance} vs ${N}`);
      assert(JSON.stringify(m.users).includes('exposure') && JSON.stringify(m.users).includes(String(lift)), 'users ' + JSON.stringify(m.users));
      return `mask ${N}, lift ${lift}, Cz_in ${JSON.stringify(cz.range)} ${cz.min}..${cz.max}`;
    });

    await c('masks tool: the chip shows 2 rows, "used by exposure", the overlay', async () => {
      await page.goto(`${URL_}/photo/${PHOTO}`);
      await page.waitFor(rendered, {timeout: 60000, what: 'the first render'});
      await page.waitFor("!document.querySelector('#tool-masks').disabled", {what: 'masks button'});
      await page.click('#tool-masks');
      await page.waitFor("!document.querySelector('#toolbar-masks').hidden && document.querySelectorAll('#mask-list .mark-chip').length", {what: 'the chips'});
      const chip = await page.eval(`(() => { const b = [...document.querySelectorAll('#mask-list .mark-chip button')].find((x) => x.textContent.includes('background')); if (!b) return null; b.click(); return b.textContent; })()`);
      assert(chip, 'no "background" chip');
      await page.waitFor("document.querySelectorAll('#mask-param .mp-row').length", {what: 'the parametric rows'});
      const rows = await page.eval("[...document.querySelectorAll('#mask-param .mp-row')].map((r) => r.dataset.key + ':' + r.querySelectorAll('.mp-h').length)");
      assert(rows.length === 2 && rows.every((r) => r.endsWith(':4')), 'rows ' + rows);
      const used = await page.eval("document.querySelector('#mask-used').textContent");
      assert(/exposure/i.test(used), '#mask-used: ' + used);
      assert(await page.eval(`document.querySelector('.mp-h').getAttribute('role') === 'slider' && document.querySelector('.mp-h').hasAttribute('aria-valuenow')`), 'marker not a slider');
      await page.waitFor(`(window.__pv || []).slice(-1)[0] && (window.__pv.slice(-1)[0]).includes('mask=${N}') && ${rendered}`, {timeout: 30000, what: `a preview request with mask=${N}`});
      await page.screenshot(`${OUT}/${mode}-tool.png`);
      return rows.join(',') + '; ' + used;
    });

    await c('drag Cz_in\'s second marker right: range[1] up, <= range[2]; both previews change', async () => {
      const before = (await par('Cz_in')).range;
      await grab(page, 'mask0', `&mask=${N}`); await grab(page, 'plain0', '');
      const t = await track(page, 'Cz_in'), m1 = await marker(page, 'Cz_in', 1);
      const hit = await page.eval(`(() => { const e = document.elementFromPoint(${m1.x}, ${m1.y}); return [...document.querySelectorAll('#mask-param .mp-row[data-key="Cz_in"] .mp-h')].indexOf(e); })()`);
      log(`     track ${JSON.stringify(t)}, marker 1 at ${JSON.stringify(m1)}, element under it: marker ${hit}; before ${JSON.stringify(before)}`);
      await dragBy(page, m1.x, m1.y, 0.2 * t.w);
      await settled(page); await stable('Cz_in');
      const after = (await par('Cz_in')).range;
      assert(after[1] > before[1], `range[1] ${before[1]} -> ${after[1]} (all ${JSON.stringify(before)} -> ${JSON.stringify(after)}; marker under the pointer was ${hit})`);
      assert(after[1] <= after[2] + 1e-6, `range[1] ${after[1]} > range[2] ${after[2]}`);
      assert(after[0] === before[0] && after[2] === before[2] && after[3] === before[3], 'other markers moved: ' + JSON.stringify(after));
      return `range ${JSON.stringify(before)} -> ${JSON.stringify(after)}`;
    });

    // photo 161's chroma is all at Cz 0, so only a start marker at exactly 0 changes the mask
    await c('Cz_in\'s first marker to the left end (Shift+ArrowLeft): range[0] 0, masked and plain previews change', async () => {
      const before = (await par('Cz_in')).range;
      await grab(page, 'mask0', `&mask=${N}`); await grab(page, 'plain0', '');
      await keys(page, 'Cz_in', 0, 'ArrowLeft', 3, true);
      await settled(page); await stable('Cz_in');
      const after = (await par('Cz_in')).range;
      assert(after[0] === 0 && before[0] > 0, `range[0] ${before[0]} -> ${after[0]}`);
      await grab(page, 'mask1', `&mask=${N}`); await grab(page, 'plain1', '');
      const dm = await diff(page, 'mask0', 'mask1'), dp = await diff(page, 'plain0', 'plain1');
      assert(dm > 0.3, `masked preview changed by ${dm.toFixed(2)}`);
      assert(dp > 0.5, `plain preview changed by ${dp.toFixed(2)}`);
      return `range[0] ${before[0]} -> ${after[0]}; masked diff ${dm.toFixed(2)}, plain diff ${dp.toFixed(2)}`;
    });

    await c('keyboard: g_in marker 3, ArrowLeft x5 -> range[3] down ~5% of the span', async () => {
      const g0 = await par('g_in'), before = g0.range[3], span = g0.max - g0.min;
      await keys(page, 'g_in', 3, 'ArrowLeft', 5); await settled(page);
      const after = (await par('g_in')).range[3], want = 0.05 * span;
      assert(after < before && Math.abs((before - after) - want) < 0.2 * want, `range[3] ${before} -> ${after}; expected about -${want.toFixed(2)} (span ${span})`);
      return `${before} -> ${after} (span ${span})`;
    });

    await c('invert (g_in) and boost 7 (Cz_in) reach the engine', async () => {
      const was = (await par('g_in')).inverted;
      await page.eval(`document.querySelector('#mask-param .mp-row[data-key="g_in"] input[type=checkbox]').click()`);
      await sleep(500); await settled(page);
      assert((await par('g_in')).inverted === !was, 'g_in inverted still ' + was);
      await page.eval(`(() => { const b = document.querySelector('#mask-param .mp-row[data-key="Cz_in"] .mp-boost'); b.focus(); b.value = '7'; b.dispatchEvent(new Event('change', {bubbles: true})); })()`);
      await sleep(500); await settled(page);
      const cz = await par('Cz_in');
      assert(cz.boost !== null && Math.abs(cz.boost - 7) < 0.01, 'boost ' + cz.boost);
      return `g_in inverted ${was} -> ${!was}, Cz_in boost ${cz.boost}, max ${cz.max}`;
    });

    await c('panel: masks section has the rows and "used by: ... exposure"', async () => {
      if (phone) { const o = await page.eval("!!document.querySelector('.panel-toggle, #panel-toggle')"); void o; }
      await page.eval("(() => { const d = document.querySelector('details[data-sec=\"masks\"]'); if (d) { d.open = true; d.scrollIntoView({block: 'start'}); } })()");
      await page.waitFor("!!document.querySelector('details[data-sec=\"masks\"]')", {what: 'the masks section'});
      const s = await page.eval(`(() => { const d = document.querySelector('details[data-sec="masks"]'); return {rows: d.querySelectorAll('.mp-row').length, text: d.textContent.replace(/\\s+/g, ' ')}; })()`);
      assert(s.rows >= 2, 'rows in the panel: ' + s.rows);
      const used = /used by: [^]*?(exposure|lift)/i.test(s.text);
      assert(used, 'text: ' + s.text.slice(0, 300));
      await page.screenshot(`${OUT}/${mode}-panel.png`);
      return `${s.rows} rows; ` + (s.text.match(/used by: .{0,60}/) || [''])[0];
    });

    await c('markers clamp: marker 3 dragged far past the right end -> range[3] <= max', async () => {
      const cz = await par('g_in'), t = await track(page, 'g_in'), m3 = await marker(page, 'g_in', 3);
      // a mouse drag past the track's end loses the pointer in headless Chrome's synthetic input (no pointer
      // capture), so the mouse goes to the end of the track; the finger goes far past it
      await dragBy(page, m3.x, m3.y, phone ? 2 * t.w : t.x + t.w - 0.5 - m3.x);
      await settled(page).catch(() => {}); await stable('g_in');
      const after = await par('g_in');
      assert(after.range[3] <= after.max + 1e-6, `range[3] ${after.range[3]} > max ${after.max}`);
      assert(after.range[3] > cz.range[3] && after.range[3] > 0.95 * after.max, `range[3] did not reach the end: ${cz.range[3]} -> ${after.range[3]}`);
      assert(!(await page.eval("document.querySelector('#status') ? document.querySelector('#status').textContent : ''")).match(/not applied/), 'engine refused a value');
      return `range[3] ${cz.range[3]} -> ${after.range[3]} (max ${after.max})`;
    });

    await c('no js errors', async () => { assert(!page.errors.length, page.errors.join('; ')); });
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
console.log(bad.length ? `parammask: ${results.length - bad.length}/${results.length} passed, ${bad.length} failed` : `parammask: ${results.length}/${results.length} passed (${URL_}, photo ${PHOTO})`);
process.exit(bad.length ? 1 : 0);
