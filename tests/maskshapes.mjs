#!/usr/bin/env node
// A mask's shapes one by one (W77) over CDP: with a mask selected its shapes
// show as outlines; click selects one, a drag moves it, handles resize a
// circle, turn a gradient, move a path point; smaller/bigger, feather, Delete,
// Escape, deselect. Scratch web app only (:8030), never :8010; the edit is
// discarded at the end (never saved).
//
//   node tests/maskshapes.mjs [--url http://127.0.0.1:8030] [--photo 409]
//                             [--only desktop|phone] [--out /tmp/w77] [--brief]

import {mkdirSync} from 'node:fs';
import {startChrome, openPage} from './cdp.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i < 0 ? dflt : args[i + 1]; };
const URL_ = opt('url', 'http://127.0.0.1:8030').replace(/\/$/, '');
const PORT = +opt('port', 9333);
const PHOTO = opt('photo', '409');
const OUT = opt('out', '/tmp/w77');
const ONLY = opt('only', null);
const BRIEF = args.includes('--brief');
if (/:8010\b/.test(URL_) && !args.includes('--force')) {
  console.error('maskshapes: refusing :8010 (the real library); use a scratch web app'); process.exit(2);
}
mkdirSync(OUT, {recursive: true});

const results = [];
const log = (s) => { if (!BRIEF) console.log(s); };
const assert = (c, m) => { if (!c) throw new Error(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const API = `${URL_}/api/photo/${PHOTO}`;
const getMasks = () => fetch(`${API}/masks`).then((r) => r.json());
const getShapes = (inst) => fetch(`${API}/mask/shapes?instance=${inst}`).then((r) => r.json());
const discard = () => fetch(`${API}/open?fresh=true`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'});
const rendered = `(() => { const i = document.querySelector('#pv'); return i && i.src.startsWith('blob:') && i.complete && i.naturalWidth > 0; })()`;
const near = (a, b, tol) => Math.abs(a - b) <= tol;

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
async function drag(page, pts, {settle = 400} = {}) {
  const r = await rectOf(page), px = pts.map(([x, y]) => ({x: r.x + x * r.w, y: r.y + y * r.h}));
  const mouse = (type, p, extra = {}) => page.send('Input.dispatchMouseEvent', {type, x: p.x, y: p.y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra});
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
const poly = (cx, cy, rx, ry, n = 16) => Array.from({length: n + 1}, (_, i) => [cx + rx * Math.cos(i * 2 * Math.PI / n), cy + ry * Math.sin(i * 2 * Math.PI / n)]);
const idle = (page) => page.waitFor(`!document.querySelector('#save').disabled && ${rendered} && !/drawing|finding|…$/.test(document.querySelector('#mask-status').textContent)`, {timeout: 60000, what: 'the edit drawn and rendered'});
const kind = (page, k) => page.click(`[data-maskkind=${k}]`);
const key = async (page, k, code, vk) => {
  await page.eval('document.activeElement && document.activeElement.blur()');
  await page.send('Input.dispatchKeyEvent', {type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk});
  await page.send('Input.dispatchKeyEvent', {type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk});
  await sleep(500);
};
const nMsh = (page) => page.eval("document.querySelectorAll('svg.photo-ov polygon.msh').length");
const nSel = (page) => page.eval("document.querySelectorAll('svg.photo-ov .msh.sel').length");
const nHandles = (page) => page.eval("document.querySelectorAll('svg.photo-ov circle.mark-handle').length");
const shown = (page) => page.eval("!document.querySelector('#mask-shape').hidden");
// the shape of a type, from the server
const shapeOf = async (inst, type) => (await getShapes(inst)).shapes.find((s) => s.type === type);
const dist = (a, b, asp) => Math.hypot((a[0] - b[0]) * asp, a[1] - b[1]);

async function run(mode, port) {
  const page = await openPage(port);
  const c = (n, f) => check(mode, page, n, f);
  const phone = mode === 'phone';
  try {
    if (phone) await page.phone(); else await page.desktop();
    await discard();
    if (!await c('photo opens, masks tool on', async () => {
      await page.goto(`${URL_}/photo/${PHOTO}`);
      await page.waitFor(rendered, {timeout: 60000, what: 'the first render'});
      await page.waitFor("document.querySelectorAll('.field input[type=range]').length", {what: 'module sliders'});
      assert(!await page.eval("document.querySelector('#tool-masks').disabled"), 'masks button disabled');
      await page.click('#tool-masks');
      await page.waitFor("!document.querySelector('#toolbar-masks').hidden", {what: 'the masks bar'});
      assert((await getMasks()).masks.length === 0, 'the photo starts with masks');
    })) return;
    const rect = await rectOf(page);
    const asp = rect.w / rect.h;
    let inst, circle;
    const drawCircle = async () => {
      await kind(page, 'circle');
      await drag(page, [[0.3, 0.4], [0.33, 0.4], [0.37, 0.41], [0.4, 0.4]]);
      await idle(page);
      const m = (await getMasks()).masks;
      assert(m.length === 1 && m[0].shapes === 1, 'masks: ' + JSON.stringify(m));
      inst = m[0].instance;
      await page.waitFor(`document.querySelectorAll('svg.photo-ov polygon.msh').length === 1`, {what: 'the circle outline in the overlay'});
      circle = await shapeOf(inst, 'circle');
      assert(circle, 'no circle in mask/shapes');
    };

    if (phone) {
      await c('tap selects the circle, a touch drag moves it, a tap on empty photo deselects', async () => {
        await drawCircle();
        const [cx, cy] = circle.center;
        await drag(page, [[cx, cy]]);
        await page.waitFor("document.querySelectorAll('svg.photo-ov .msh.sel').length === 1", {what: 'the circle selected by a tap'});
        assert(await shown(page), '#mask-shape hidden');
        await page.screenshot(`${OUT}/phone-shape.png`);
        await drag(page, line([cx, cy], [cx + 0.1, cy]));
        await sleep(1500);
        log('     phone after drag: ' + JSON.stringify((await shapeOf(inst, 'circle')).center) + ' from ' + JSON.stringify([cx, cy]) + ' sel ' + await nSel(page));
        await page.waitFor(`fetch('${API}/mask/shapes?instance=${inst}').then((r) => r.json()).then((d) => Math.abs(d.shapes[0].center[0] - ${cx + 0.1}) < 0.02)`, {timeout: 3000, what: 'the circle moved by touch'});
        const now = await shapeOf(inst, 'circle');
        assert(now.formid === circle.formid, 'formid changed');
        await drag(page, [[0.9, 0.9]]);
        await page.waitFor("document.querySelectorAll('svg.photo-ov .msh.sel').length === 0", {what: 'deselected by a tap on empty photo'});
        return `center x ${circle.center[0].toFixed(3)} -> ${now.center[0].toFixed(3)}`;
      });
      await c('no js errors', async () => { assert(!page.errors.length, page.errors.join('; ')); });
      await discard();
      return;
    }

    await c('1 circle then a path: 2 polygon.msh', async () => {
      await drawCircle();
      await kind(page, 'path');
      await drag(page, poly(0.75, 0.25, 0.08, 0.1));
      await idle(page);
      await page.waitFor(`document.querySelectorAll('svg.photo-ov polygon.msh').length === 2`, {what: '2 outlines'});
      const m = (await getMasks()).masks;
      assert(m.length === 1 && m[0].shapes === 2, 'masks: ' + JSON.stringify(m));
      assert((await getShapes(inst)).shapes.length === 2, 'mask/shapes count');
    });
    await c('2 click inside the circle selects it', async () => {
      await drag(page, [circle.center]);
      await page.waitFor("document.querySelectorAll('svg.photo-ov .msh.sel').length === 1", {what: 'the circle selected'});
      assert(await shown(page), '#mask-shape hidden');
      const what = await page.eval("document.querySelector('#mask-shape-what').textContent");
      assert(/circle/.test(what), 'what: ' + what);
      assert(await nHandles(page) === 1, 'handles: ' + await nHandles(page));
      await page.screenshot(`${OUT}/desktop-shape.png`);
    });
    await c('3 drag the body +0.1 moves the circle', async () => {
      const [cx, cy] = circle.center;
      await drag(page, line([cx, cy], [cx + 0.1, cy]));
      await page.waitFor(`fetch('${API}/mask/shapes?instance=${inst}').then((r) => r.json()).then((d) => d.shapes.some((s) => s.type === 'circle' && Math.abs(s.center[0] - ${cx + 0.1}) < 0.02))`, {what: 'the circle moved'});
      const now = await shapeOf(inst, 'circle');
      assert(now.formid === circle.formid, `formid ${circle.formid} -> ${now.formid}`);
      assert(near(now.center[1], cy, 0.02), `y moved: ${cy} -> ${now.center[1]}`);
      await idle(page);
      const dx = now.center[0] - cx;
      circle = now;
      return `dx ${dx.toFixed(3)}`;
    });
    await c('4 drag the size handle outward grows the radius >20%', async () => {
      await page.waitFor("document.querySelectorAll('svg.photo-ov .msh.sel').length === 1 && document.querySelectorAll('svg.photo-ov circle.mark-handle').length === 1");
      const h = circle.handles[0], r0 = dist(circle.center, [h.x, h.y], asp);
      const vx = h.x - circle.center[0], vy = h.y - circle.center[1], len = Math.hypot(vx * asp, vy);
      const to = [h.x + vx / len * r0 * 0.6 / asp * asp / asp, h.y + vy / len * r0 * 0.6];
      await drag(page, line([h.x, h.y], to));
      await page.waitFor(`fetch('${API}/mask/shapes?instance=${inst}').then((r) => r.json()).then((d) => d.shapes.some((s) => s.type === 'circle' && s.handles[0].x !== ${h.x}))`, {what: 'the circle resized'});
      await idle(page);
      const now = await shapeOf(inst, 'circle'), r1 = dist(now.center, [now.handles[0].x, now.handles[0].y], asp);
      assert(r1 > r0 * 1.2, `radius ${r0.toFixed(4)} -> ${r1.toFixed(4)}`);
      circle = now;
      return `radius ${r0.toFixed(4)} -> ${r1.toFixed(4)}`;
    });
    await c('5 bigger grows again; feather 0.1', async () => {
      const rad = (s) => dist(s.center, [s.handles[0].x, s.handles[0].y], asp);
      const r0 = rad(circle);
      await page.click('#mask-shape-bigger');
      await page.waitFor(`fetch('${API}/mask/shapes?instance=${inst}').then((r) => r.json()).then((d) => d.shapes.some((s) => s.type === 'circle' && Math.hypot((s.handles[0].x - s.center[0]) * ${asp}, s.handles[0].y - s.center[1]) > ${r0 * 1.1}))`, {what: 'bigger'});
      await idle(page);
      const now = await shapeOf(inst, 'circle'), r1 = rad(now);
      assert(r1 > r0 * 1.15, `radius ${r0.toFixed(4)} -> ${r1.toFixed(4)}`);
      await page.eval(`(() => { const s = document.querySelector('#mask-shape-feather'); s.value = 0.1; s.dispatchEvent(new Event('change', {bubbles: true})); })()`);
      await page.waitFor(`fetch('${API}/mask/shapes?instance=${inst}').then((r) => r.json()).then((d) => d.shapes.some((s) => s.type === 'circle' && Math.abs(s.feather - 0.1) < 0.01))`, {what: 'feather 0.1'});
      await idle(page);
      circle = await shapeOf(inst, 'circle');
      return `radius ${r0.toFixed(4)} -> ${r1.toFixed(4)}, feather ${circle.feather}`;
    });
    await c('6 drag the path point 0 to a new place', async () => {
      const p = await shapeOf(inst, 'path');
      await drag(page, [p.center]);
      await page.waitFor(`document.querySelectorAll('svg.photo-ov .msh.sel').length === 1 && /path/.test(document.querySelector('#mask-shape-what').textContent) && document.querySelectorAll('svg.photo-ov circle.mark-handle').length === ${p.handles.length}`, {what: 'the path selected with its handles'});
      const h = p.handles[0], to = [0.9, 0.12];
      await drag(page, line([h.x, h.y], to));
      await page.waitFor(`fetch('${API}/mask/shapes?instance=${inst}').then((r) => r.json()).then((d) => d.shapes.some((s) => s.type === 'path' && Math.hypot(s.handles[0].x - ${to[0]}, s.handles[0].y - ${to[1]}) < 0.02))`, {what: 'point 0 at the drop'});
      await idle(page);
      const now = await shapeOf(inst, 'path');
      assert(now.formid === p.formid, 'formid changed');
      return `handle 0 ${now.handles[0].x.toFixed(3)},${now.handles[0].y.toFixed(3)}`;
    });
    await c('7 Escape deselects the shape first; Delete removes the path; the last shape cannot go', async () => {
      await key(page, 'Escape', 'Escape', 27);
      assert(await nSel(page) === 0, 'still a selected shape after Escape');
      assert(!await page.eval("document.querySelector('#toolbar-masks').hidden"), 'the tool closed on the first Escape');
      assert(await page.eval("document.querySelectorAll('#mask-list .mark-chip.on, #mask-list .mark-chip[aria-pressed=true], #mask-list .mark-chip.sel').length") >= 1 || (await nMsh(page)) === 2, 'the mask is no longer selected');
      assert(await nMsh(page) === 2, 'outlines gone: ' + await nMsh(page));
      const p = await shapeOf(inst, 'path');
      await drag(page, [p.center]);
      await page.waitFor("document.querySelectorAll('svg.photo-ov .msh.sel').length === 1", {what: 'the path selected'});
      await key(page, 'Delete', 'Delete', 46);
      await page.waitFor(`fetch('${API}/mask/shapes?instance=${inst}').then((r) => r.json()).then((d) => d.shapes.length === 1)`, {what: '1 shape left'});
      await idle(page);
      assert(!(await shapeOf(inst, 'path')), 'the path is still there');
      circle = await shapeOf(inst, 'circle');
      await page.waitFor("document.querySelectorAll('svg.photo-ov polygon.msh').length === 1", {what: 'one outline'});
      await drag(page, [circle.center]);
      await page.waitFor("document.querySelectorAll('svg.photo-ov .msh.sel').length === 1", {what: 'the circle selected'});
      assert(await page.eval("document.querySelector('#mask-shape-del').disabled"), '#mask-shape-del enabled on the last shape');
      await key(page, 'Delete', 'Delete', 46);
      assert((await getShapes(inst)).shapes.length === 1, 'Delete removed the last shape');
    });
    await c('8 gradient: select by its line, drag the rot handle', async () => {
      await page.eval('document.activeElement && document.activeElement.blur()');
      await key(page, 'Escape', 'Escape', 27);          // deselect the circle
      await kind(page, 'gradient');
      await drag(page, [[0.5, 0.8], [0.5, 0.65], [0.5, 0.5]]);
      await idle(page);
      const sh = (await getShapes(inst)).shapes;
      assert(sh.length === 2, 'shapes: ' + sh.map((s) => s.type));
      const g = sh.find((s) => s.type === 'gradient');
      assert(g && g.handles.length === 1 && g.handles[0].kind === 'rot', 'gradient: ' + JSON.stringify(g));
      const ang = (s) => Math.atan2((s.handles[0].y - s.center[1]), (s.handles[0].x - s.center[0]) * asp) * 180 / Math.PI;
      const mid = [(g.center[0] + g.handles[0].x) / 2, (g.center[1] + g.handles[0].y) / 2];
      await drag(page, [mid]);
      await page.waitFor("document.querySelectorAll('svg.photo-ov .msh.sel').length === 1 && /gradient/.test(document.querySelector('#mask-shape-what').textContent)", {what: 'the gradient selected'});
      const h = g.handles[0], to = [g.center[0] + 0.25, g.center[1]];
      await drag(page, line([h.x, h.y], to));
      await page.waitFor(`fetch('${API}/mask/shapes?instance=${inst}').then((r) => r.json()).then((d) => d.shapes.some((s) => s.type === 'gradient' && (s.handles[0].x !== ${h.x} || s.handles[0].y !== ${h.y})))`, {what: 'the gradient turned'});
      await idle(page);
      const now = (await getShapes(inst)).shapes.find((s) => s.type === 'gradient');
      let d = Math.abs(ang(now) - ang(g)); if (d > 180) d = 360 - d;
      assert(d > 20, `angle ${ang(g).toFixed(1)} -> ${ang(now).toFixed(1)}`);
      return `angle ${ang(g).toFixed(1)} -> ${ang(now).toFixed(1)}`;
    });
    await c('click on empty photo deselects', async () => {
      assert(await nSel(page) === 1, 'no shape selected before');
      await drag(page, [[0.92, 0.92]]);
      await page.waitFor("document.querySelectorAll('svg.photo-ov .msh.sel').length === 0", {what: 'deselected'});
      assert(!await shown(page), '#mask-shape still shown');
    });
    await c('9 no js errors', async () => { assert(!page.errors.length, page.errors.join('; ')); });
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
console.log(bad.length ? `maskshapes: ${results.length - bad.length}/${results.length} passed, ${bad.length} failed` : `maskshapes: ${results.length}/${results.length} passed (${URL_}, photo ${PHOTO})`);
process.exit(bad.length ? 1 : 0);
