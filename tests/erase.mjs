#!/usr/bin/env node
// Erase fills only when asked (W80) over CDP: a drawn outline or a click's
// circle stays a draft that can be moved, reshaped, resized and cleared; no
// /fill request before fill or Enter, and the edited shape is what reaches
// /fill. Fill replies are stubbed in the page except one real LaMa fill
// (desktop). Scratch web app only (:8030), never :8010; the edit is discarded.
//
//   node tests/erase.mjs [--url http://127.0.0.1:8030] [--photo 409]
//                        [--only desktop|phone] [--out /tmp/w80] [--brief]

import {mkdirSync} from 'node:fs';
import {startChrome, openPage} from './cdp.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i < 0 ? dflt : args[i + 1]; };
const URL_ = opt('url', 'http://127.0.0.1:8030').replace(/\/$/, '');
const PORT = +opt('port', 9333);
const PHOTO = opt('photo', '409');
const OUT = opt('out', '/tmp/w80');
const ONLY = opt('only', null);
const BRIEF = args.includes('--brief');
if (/:8010\b/.test(URL_) && !args.includes('--force')) {
  console.error('erase: refusing :8010 (the real library); use a scratch web app'); process.exit(2);
}
mkdirSync(OUT, {recursive: true});

const results = [];
const log = (s) => { if (!BRIEF) console.log(s); };
const assert = (c, m) => { if (!c) throw new Error(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const API = `${URL_}/api/photo/${PHOTO}`;
const discard = () => fetch(`${API}/open?fresh=true`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'});
const rendered = `(() => { const i = document.querySelector('#pv'); return i && i.src.startsWith('blob:') && i.complete && i.naturalWidth > 0; })()`;
const near = (a, b, tol = 0.006) => Math.abs(a - b) <= tol;

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

const rectOf = (page) => page.eval(`(() => { const r = document.querySelector('.view svg.photo-ov').getBoundingClientRect(); return {x: r.left, y: r.top, w: r.width, h: r.height}; })()`);
// drag along fractions [[x, y], ...] with the mouse, or one finger on the phone; one point is a click or tap
async function drag(page, pts, {settle = 300} = {}) {
  const r = await rectOf(page), px = pts.map(([x, y]) => ({x: r.x + x * r.w, y: r.y + y * r.h}));
  const mouse = (type, p, extra = {}) => page.send('Input.dispatchMouseEvent', {type, x: p.x, y: p.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: 1, clickCount: 1, ...extra});
  const touch = (type, p) => page.send('Input.dispatchTouchEvent', {type, touchPoints: type === 'touchEnd' ? [] : [{x: p.x, y: p.y}]});
  if (page.touch) {
    await touch('touchStart', px[0]);
    for (const p of px.slice(1)) await touch('touchMove', p);
    await touch('touchEnd');
  } else {
    await mouse('mouseMoved', px[0], {buttons: 0}); await mouse('mousePressed', px[0]);
    for (const p of px.slice(1)) await mouse('mouseMoved', p);
    await mouse('mouseReleased', px[px.length - 1]);
  }
  await sleep(settle);
}
const line = (a, b, n = 6) => Array.from({length: n + 1}, (_, i) => [a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n]);
const poly = (cx, cy, rx, ry, n = 24) => Array.from({length: n + 1}, (_, i) => [cx + rx * Math.cos(i * 2 * Math.PI / n), cy + ry * Math.sin(i * 2 * Math.PI / n)]);
const key = async (page, k, code, vk) => {
  await page.eval('document.activeElement && document.activeElement.blur()');
  await page.send('Input.dispatchKeyEvent', {type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk});
  await page.send('Input.dispatchKeyEvent', {type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk});
  await sleep(300);
};
const hidden = (page, sel) => page.eval(`document.querySelector('${sel}').hidden`);
const status = (page) => page.eval("document.querySelector('#erase-status').textContent");
const fills = (page) => page.eval('window.__fills');
const stub = (page, reply) => page.eval(`void (window.__fillReply = ${JSON.stringify(reply)})`);
// the draft on the overlay, in photo fractions (no zoom in this test)
const draft = (page) => page.eval(`(() => {
  const s = document.querySelector('svg.photo-ov'), b = s.getBoundingClientRect();
  const g = s.querySelector('polygon.lasso.pending');
  const pts = g ? g.getAttribute('points').trim().split(/\\s+/).map((p) => { const [x, y] = p.split(',').map(Number); return [x / b.width, y / b.height]; }) : null;
  const c = s.querySelector('circle.lasso.pending');
  const circle = c ? [c.cx.baseVal.value / b.width, c.cy.baseVal.value / b.height, c.r.baseVal.value / b.width] : null;
  const handles = [...s.querySelectorAll('circle.mark-handle')].map((h) => [h.cx.baseVal.value / b.width, h.cy.baseVal.value / b.height]);
  return {pts, circle, handles};
})()`);
const INSTALL = `(() => {
  if (window.__fills) return;
  window.__fills = []; window.__fillReply = {status: 200, body: {process_ms: 1}};
  const f = window.fetch;
  window.fetch = async (u, o) => {
    if (/\\/fill$/.test(String(u)) && o && o.method === 'POST') {
      window.__fills.push(JSON.parse(o.body));
      if (window.__fillReply) return new Response(JSON.stringify(window.__fillReply.body), {status: window.__fillReply.status});
    }
    return f(u, o);
  };
})()`;

async function run(mode, port) {
  const page = await openPage(port);
  const c = (n, f) => check(mode, page, n, f);
  const phone = mode === 'phone';
  const noFills = async (n = 0) => { await sleep(600); const f = await fills(page); assert(f.length === n, `${f.length} /fill requests, expected ${n}`); };
  try {
    if (phone) await page.phone(); else await page.desktop();
    await discard();
    if (!await c('1 photo opens, erase on', async () => {
      await page.goto(`${URL_}/photo/${PHOTO}`);
      await page.waitFor(rendered, {timeout: 60000, what: 'the first render'});
      assert(!await page.eval("document.querySelector('#tool-erase').disabled"), 'erase button disabled (no ai_fill?)');
      await page.eval(INSTALL);
      await page.click('#tool-erase');
      await page.waitFor("!document.querySelector('#toolbar-erase').hidden && document.querySelector('#erase-model').options.length > 0", {what: 'the erase bar and models'});
      await page.eval("void (document.querySelector('#erase-model').value = 'local', document.querySelector('#erase-model').onchange())");
      assert(await hidden(page, '#erase-fill') && await hidden(page, '#erase-clear'), 'fill or clear shown with no draft');
    })) return;

    let p0;
    await c('2 a drawn outline stays a draft: no /fill', async () => {
      await drag(page, poly(0.5, 0.5, 0.14, 0.12, 72));
      await noFills();
      p0 = await draft(page);
      assert(p0.pts && p0.pts.length >= 3, 'no draft polygon: ' + JSON.stringify(p0));
      assert(p0.handles.length === p0.pts.length, `${p0.handles.length} handles for ${p0.pts.length} points`);
      assert(p0.pts.length < 40, `outline not simplified: ${p0.pts.length} points`);
      assert(!await hidden(page, '#erase-fill') && !await hidden(page, '#erase-clear'), 'fill or clear hidden');
      assert(await page.eval("document.querySelector('#erase-size').closest('.size').hidden"), 'size slider shown for an outline');
      await page.screenshot(`${OUT}/${mode}-outline.png`);
      return `${p0.pts.length} points`;
    });
    await c('3 drag a point reshapes it', async () => {
      const h = p0.handles[0], to = [h[0] + 0.05, h[1] - 0.03];
      await drag(page, line(h, to));
      const d = await draft(page);
      assert(near(d.pts[0][0], to[0]) && near(d.pts[0][1], to[1]), `point at ${d.pts[0]}, wanted ${to}`);
      assert(near(d.pts[2][0], p0.pts[2][0]), 'another point moved');
      await noFills();
      p0 = d;
    });
    await c('4 drag inside moves the whole shape', async () => {
      await drag(page, line([0.5, 0.5], [0.44, 0.56]));
      const d = await draft(page);
      d.pts.forEach((q, i) => assert(near(q[0], p0.pts[i][0] - 0.06) && near(q[1], p0.pts[i][1] + 0.06), `point ${i} at ${q} from ${p0.pts[i]}`));
      await noFills();
      p0 = d;
    });
    await c('5 a press outside leaves the outline', async () => {
      await drag(page, line([0.9, 0.1], [0.95, 0.2]));
      const d = await draft(page);
      assert(d.pts && d.pts.length === p0.pts.length && near(d.pts[1][0], p0.pts[1][0]), 'draft changed');
      assert(/clear/.test(await status(page)), 'status: ' + await status(page));
      await noFills();
    });
    await c('6 changing the model or prompt keeps the draft', async () => {
      await page.eval("void (document.querySelector('#erase-prompt').value = 'grass', document.querySelector('#erase-model').onchange())");
      const d = await draft(page);
      assert(d.pts && d.pts.length === p0.pts.length, 'draft gone');
      await noFills();
    });
    await c('7 a failed fill keeps the shape', async () => {
      await stub(page, {status: 500, body: {detail: 'nope'}});
      await page.click('#erase-fill');
      await page.waitFor("/fill failed/.test(document.querySelector('#erase-status').textContent)", {what: 'the failure'});
      await noFills(1);
      const d = await draft(page);
      assert(d.pts && d.pts.length === p0.pts.length && !await hidden(page, '#erase-fill'), 'draft gone');
    });
    await c('8 fill sends the edited shape', async () => {
      await stub(page, {status: 200, body: {process_ms: 1}});
      await page.click('#erase-fill');
      await page.waitFor("/^filled/.test(document.querySelector('#erase-status').textContent)", {timeout: 30000, what: 'the fill'});
      const f = await fills(page), b = f[f.length - 1];
      assert(f.length === 2 && b.shape === 'path' && b.model === 'local', JSON.stringify(b).slice(0, 200));
      b.points.forEach((q, i) => assert(near(q[0], p0.pts[i][0]) && near(q[1], p0.pts[i][1]), `sent ${q}, drew ${p0.pts[i]}`));
      const d = await draft(page);
      assert(!d.pts && !d.circle && !d.handles.length && await hidden(page, '#erase-fill'), 'draft left after the fill');
    });
    await c('9 clear starts over', async () => {
      const before = (await fills(page)).length;
      await drag(page, poly(0.3, 0.3, 0.08, 0.08));
      assert((await draft(page)).pts, 'no draft');
      if (phone) await page.click('#erase-clear'); else await key(page, 'Delete', 'Delete', 46);
      await sleep(200);
      const d = await draft(page);
      assert(!d.pts && await hidden(page, '#erase-clear'), 'draft left');
      await drag(page, poly(0.7, 0.3, 0.08, 0.08));
      const e = await draft(page);
      assert(e.pts && near(e.pts[0][0], 0.78, 0.02), 'no new draft at the new place');
      await page.click('#erase-clear');
      await sleep(200);
      assert(!(await draft(page)).pts, 'clear button left the draft');
      await noFills(before);
    });
    let c0;
    await c('10 a click places a circle: no /fill', async () => {
      const before = (await fills(page)).length;
      await page.eval("void (document.querySelector('#erase-size').value = 0.02, document.querySelector('#erase-size').oninput())");
      await drag(page, [[0.4, 0.6]]);
      await noFills(before);
      c0 = await draft(page);
      assert(c0.circle && near(c0.circle[0], 0.4) && c0.handles.length === 1, JSON.stringify(c0));
      assert(!await page.eval("document.querySelector('#erase-size').closest('.size').hidden"), 'size slider hidden for a circle');
    });
    await c('11 its handle resizes it, a drag moves it', async () => {
      const r0 = +await page.eval("document.querySelector('#erase-size').value");
      const h = c0.handles[0];
      await drag(page, line(h, [h[0] + 0.05, h[1]]));
      const r1 = +await page.eval("document.querySelector('#erase-size').value");
      assert(r1 > r0 * 1.3, `size ${r0} -> ${r1}`);
      await drag(page, line([c0.circle[0], c0.circle[1]], [0.5, 0.65]));
      const d = await draft(page);
      assert(near(d.circle[0], 0.5) && near(d.circle[1], 0.65), 'circle at ' + d.circle);
      await page.screenshot(`${OUT}/${mode}-circle.png`);
    });
    await c('12 fill (Enter on desktop) sends the circle', async () => {
      const before = (await fills(page)).length;
      if (phone) await page.click('#erase-fill'); else await key(page, 'Enter', 'Enter', 13);
      await page.waitFor("/^filled/.test(document.querySelector('#erase-status').textContent)", {timeout: 30000, what: 'the fill'});
      const f = await fills(page), b = f[f.length - 1];
      const size = +await page.eval("document.querySelector('#erase-size').value");
      assert(f.length === before + 1 && b.shape === 'circle' && near(b.x, 0.5) && near(b.y, 0.65) && near(b.radius, size, 0.0005), JSON.stringify(b));
    });
    if (!phone) await c('13 a real LaMa fill of a drawn outline', async () => {
      await page.eval('void (window.__fillReply = null)');
      await drag(page, poly(0.6, 0.4, 0.04, 0.05));
      await noFills((await fills(page)).length);
      assert((await draft(page)).pts, 'no draft');
      await page.click('#erase-fill');
      await page.waitFor("/^(filled|fill failed)/.test(document.querySelector('#erase-status').textContent)", {timeout: 120000, what: 'the fill'});
      const st = await status(page);
      assert(/^filled/.test(st), st);
      await page.waitFor(rendered, {timeout: 60000, what: 'the render after the fill'});
      await page.screenshot(`${OUT}/${mode}-filled.png`);
      return st;
    });
    await c('14 no js errors', async () => { assert(!page.errors.length, page.errors.join('; ')); });
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
console.log(bad.length ? `erase: ${results.length - bad.length}/${results.length} passed, ${bad.length} failed` : `erase: ${results.length}/${results.length} passed (${URL_}, photo ${PHOTO})`);
process.exit(bad.length ? 1 : 0);
