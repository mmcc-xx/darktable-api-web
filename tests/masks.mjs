#!/usr/bin/env node
// Masks tool (W48) over CDP: draw a circle, an ellipse, a gradient, a path and
// a brush stroke on the photo (mouse drags; a touch drag on the phone), rename
// and shape a mask, let color balance rgb use it through its mask row in the
// pipeline view, show it (preview mask=N), remove it. Which side of a
// gradient is full is read from a render with the mask shown. Scratch web app
// only (:8030), never :8010; the edit is discarded at the end (never saved).
//
//   node tests/masks.mjs [--url http://127.0.0.1:8030] [--photo 161]
//                        [--only desktop|phone] [--out /tmp/w48] [--brief]

import {mkdirSync} from 'node:fs';
import {startChrome, openPage} from './cdp.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i < 0 ? dflt : args[i + 1]; };
const URL_ = opt('url', 'http://127.0.0.1:8030').replace(/\/$/, '');
const PORT = +opt('port', 9333);
const PHOTO = opt('photo', '161');
const OUT = opt('out', '/tmp/w48');
const ONLY = opt('only', null);
const BRIEF = args.includes('--brief');
if (/:8010\b/.test(URL_) && !args.includes('--force')) {
  console.error('masks: refusing :8010 (the real library); use a scratch web app'); process.exit(2);
}
mkdirSync(OUT, {recursive: true});

const results = [];
const log = (s) => { if (!BRIEF) console.log(s); };
const assert = (c, m) => { if (!c) throw new Error(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const API = `${URL_}/api/photo/${PHOTO}`;
const getMasks = () => fetch(`${API}/masks`).then((r) => r.json());
const discard = () => fetch(`${API}/open?fresh=true`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'});
const rendered = `(() => { const i = document.querySelector('#pv'); return i && i.src.startsWith('blob:') && i.complete && i.naturalWidth > 0; })()`;

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

// photo fractions -> client pixels, from the overlay svg (laid exactly over the photo)
const rectOf = (page) => page.eval(`(() => { const r = document.querySelector('.view svg.photo-ov').getBoundingClientRect(); return {x: r.left, y: r.top, w: r.width, h: r.height}; })()`);
// drag along fractions [[x, y], ...] with the mouse, or one finger on the phone
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
const idle = (page) => page.waitFor(`!document.querySelector('#save').disabled && ${rendered} && !/drawing|finding/.test(document.querySelector('#mask-status').textContent)`, {timeout: 60000, what: 'the edit drawn and rendered'});
const kind = (page, k) => page.click(`[data-maskkind=${k}]`);
const poly = (cx, cy, rx, ry, n = 16) => Array.from({length: n + 1}, (_, i) => [cx + rx * Math.cos(i * 2 * Math.PI / n), cy + ry * Math.sin(i * 2 * Math.PI / n)]);

// the shown mask (preview mask=N) as yellow over gray: how yellow is each photo-fraction point?
const yellowAt = (page, id, pts) => page.eval(`(async () => {
  const r = await fetch('${API}/preview.jpg?w=600&h=600&mask=${id}'); if (!r.ok) throw new Error(r.status + ' ' + await r.text());
  const bmp = await createImageBitmap(await r.blob()), c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height; const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
  return ${JSON.stringify(pts)}.map(([x, y]) => { const d = g.getImageData(Math.round(x * (c.width - 1)), Math.round(y * (c.height - 1)), 1, 1).data; return d[0] + d[1] - 2 * d[2]; });
})()`);

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
      assert(await page.eval("document.querySelector('#tool-masks').getAttribute('aria-pressed')") === 'true', 'not pressed');
      assert((await getMasks()).masks.length === 0, 'the photo starts with masks');
    })) return;

    if (phone) {
      await c('touch-drag a circle makes a mask', async () => {
        await kind(page, 'circle');
        await drag(page, [[0.3, 0.4], [0.35, 0.4], [0.4, 0.4]]);
        await idle(page);
        const m = (await getMasks()).masks;
        assert(m.length === 1 && m[0].shapes === 1, 'masks: ' + JSON.stringify(m));
        await page.waitFor("document.querySelectorAll('#mask-list .mark-chip').length === 1", {what: 'the chip'});
        await page.screenshot(`${OUT}/phone-masks.png`);
        return m[0].name;
      });
      await c('no js errors', async () => { assert(!page.errors.length, page.errors.join('; ')); });
      await discard();
      return;
    }

    let tree;
    await c('circle makes a mask with 1 shape', async () => {
      await kind(page, 'circle');
      await drag(page, [[0.3, 0.4], [0.33, 0.4], [0.37, 0.41], [0.4, 0.4]]);
      await idle(page);
      const m = (await getMasks()).masks;
      assert(m.length === 1 && m[0].shapes === 1, 'masks: ' + JSON.stringify(m));
      tree = m[0].instance;
      assert(m[0].name === 'mask 1', 'name ' + m[0].name);
      await page.waitFor(`document.querySelector('#pv').src.length && document.querySelector('#mask-list').textContent.includes('mask 1')`);
    });
    await c('rename to "left tree"', async () => {
      await page.eval(`(() => { const i = document.querySelector('#mask-name'); i.value = 'left tree'; i.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true})); })()`);
      await page.waitFor(`document.querySelector('#mask-list').textContent.includes('left tree')`, {what: 'the new name'});
      const m = (await getMasks()).masks;
      assert(m.length === 1 && m[0].name === 'left tree', JSON.stringify(m));
    });
    await c('ellipse added to it (2 shapes)', async () => {
      await kind(page, 'ellipse');
      await drag(page, [[0.5, 0.3], [0.58, 0.36], [0.66, 0.45]]);
      await idle(page);
      const m = (await getMasks()).masks;
      assert(m.length === 1 && m[0].shapes === 2, 'masks: ' + JSON.stringify(m));
    });
    await c('subtract: a circle taken out (3 shapes)', async () => {
      await page.click('#mask-sub');
      await kind(page, 'circle');
      await drag(page, [[0.3, 0.4], [0.33, 0.4]]);
      await idle(page);
      const m = (await getMasks()).masks;
      assert(m.length === 1 && m[0].shapes === 3, 'masks: ' + JSON.stringify(m));
    });
    let grad;
    await c('gradient: a new mask, the drag start is the full side', async () => {
      await page.click('#mask-new');
      await kind(page, 'gradient');
      // from the bottom (full) up to the middle: a vertical drag, ends at 0.8 -> 0.5
      await drag(page, [[0.5, 0.8], [0.5, 0.65], [0.5, 0.5]]);
      await idle(page);
      const m = (await getMasks()).masks;
      assert(m.length === 2, 'masks: ' + JSON.stringify(m));
      grad = m.find((x) => x.instance !== tree).instance;
      const [atStart, atEnd] = await yellowAt(page, grad, [[0.5, 0.95], [0.5, 0.1]]);
      log(`     gradient: yellow at the start side ${atStart}, at the far side ${atEnd}`);
      assert(atStart > atEnd + 30, `the start of the drag isn't the full side (yellow ${atStart} at the start, ${atEnd} at the end)`);
      return `start side ${atStart}, far side ${atEnd}`;
    });
    await c('opacity 50 and soft edge', async () => {
      await page.eval(`(() => { const s = document.querySelector('#mask-opacity'); s.value = 50; s.dispatchEvent(new Event('input', {bubbles: true}));
        const b = document.querySelector('#mask-blur'); b.value = 20; b.dispatchEvent(new Event('input', {bubbles: true})); })()`);
      await page.waitFor(`fetch('${API}/masks').then((r) => r.json()).then((d) => d.masks.some((m) => m.instance === ${grad} && m.opacity === 50 && m.blur_radius === 20))`, {what: 'opacity 50, soft edge 20'});
    });
    await c('shown mask renders (mask=N is image/jpeg)', async () => {
      const r = await fetch(`${API}/preview.jpg?w=400&h=400&mask=${tree}`);
      assert(r.status === 200 && r.headers.get('content-type') === 'image/jpeg', r.status + ' ' + r.headers.get('content-type'));
      assert((await r.arrayBuffer()).byteLength > 2000, 'tiny image');
      const src = await page.eval("document.querySelector('#pv').src");
      assert(src.startsWith('blob:'), 'preview not shown');
    });
    await c('color balance rgb uses "left tree" (pipeline view mask row)', async () => {
      await page.click('[data-view=pipeline]');
      await page.waitFor(`!!document.querySelector('#pipeline .prow[data-key="colorbalancergb:0"]')`, {what: 'color balance rgb row'});
      await page.eval(`document.querySelector('#pipeline .prow[data-key="colorbalancergb:0"] .pname').click()`);
      await page.waitFor(`!!document.querySelector('#pipeline .prow[data-key="colorbalancergb:0"] .mask-row select')`, {what: 'its mask row'});
      const opts = await page.eval(`[...document.querySelectorAll('#pipeline .prow[data-key="colorbalancergb:0"] .mask-row select option')].map((o) => o.textContent + (o.disabled ? ' (disabled)' : ''))`);
      assert(opts.includes('left tree'), 'options ' + opts);
      await page.eval(`(() => { const s = document.querySelector('#pipeline .prow[data-key="colorbalancergb:0"] .mask-row select'); s.value = '${tree}'; s.dispatchEvent(new Event('change', {bubbles: true})); })()`);
      await page.waitFor(`fetch('${API}/masks').then((r) => r.json()).then((d) => d.masks.some((m) => m.instance === ${tree} && m.users.some((u) => u.operation === 'colorbalancergb')))`, {what: 'color balance rgb among the users'});
      const m = (await getMasks()).masks.find((x) => x.instance === tree);
      assert(m.users.length === 1 && m.users[0].operation === 'colorbalancergb', JSON.stringify(m.users));
      await page.waitFor(`document.querySelector('#pipeline .prow[data-key="colorbalancergb:0"] .mask-row select').value === '${tree}'`, {what: 'the row keeps its pick'});
      const gone = await page.eval(`!document.querySelector('#pipeline .prow[data-key="exposure:${tree}"] .mask-row')`);
      assert(gone, 'a mask holder has a mask row');
      const role = await page.eval(`document.querySelector('#pipeline .prow[data-key="exposure:${tree}"] .prole').textContent`);
      assert(role === 'mask', 'holder role: ' + role);
      await page.waitFor(rendered);
    });
    await c('a mask before the module can be used; the panel lists it', async () => {
      const t = (await getMasks()).targets.find((x) => x.operation === 'colorbalancergb');
      assert(t && t.mask === tree && t.inverted === false, JSON.stringify(t));
      await page.waitFor(`document.querySelector('details[data-sec=masks]') && /used by: .*color balance rgb/.test(document.querySelector('details[data-sec=masks]').textContent)`, {what: 'the masks section with the user'});
      await page.screenshot(`${OUT}/desktop-masks.png`);
    });
    await c('path and brush masks', async () => {
      await page.click('#tool-masks'); await page.click('#tool-masks');      // off, on: a new mask next
      await page.waitFor("!document.querySelector('#toolbar-masks').hidden");
      await kind(page, 'path');
      await drag(page, poly(0.75, 0.25, 0.08, 0.1));
      await idle(page);
      let m = (await getMasks()).masks;
      assert(m.length === 3, 'path: ' + JSON.stringify(m.map((x) => x.name)));
      await page.click('#mask-new');
      await kind(page, 'brush');
      await drag(page, [[0.2, 0.7], [0.25, 0.72], [0.3, 0.7], [0.35, 0.72], [0.4, 0.7]]);
      await idle(page);
      m = (await getMasks()).masks;
      assert(m.length === 4 && m.every((x) => x.shapes >= 1), 'brush: ' + JSON.stringify(m.map((x) => [x.name, x.shapes])));
    });
    await c('remove "left tree": its user goes back, the instance is gone', async () => {
      await page.click(`#mask-list .mark-x[aria-label="remove left tree"]`);
      await page.waitFor("document.querySelector('dialog.ask-dlg') && document.querySelector('dialog.ask-dlg').open", {what: 'the confirmation (it has a user)'});
      await page.click('dialog.ask-dlg .ask-ok');
      await page.waitFor(`fetch('${API}/masks').then((r) => r.json()).then((d) => !d.masks.some((m) => m.instance === ${tree}))`, {what: 'the mask gone'});
      const d = await getMasks();
      assert(d.targets.every((t) => t.mask !== tree), 'a module still uses it');
      const mods = await fetch(`${API}/module?operation=colorbalancergb&instance=0`).then((r) => r.json());
      assert(mods.blend && mods.blend.masks !== 'raster', 'color balance rgb still blends with a raster mask: ' + JSON.stringify(mods.blend));
      const ex = await fetch(`${API}/module?operation=exposure&instance=${tree}`);
      assert(!ex.ok, 'the exposure instance is still there');
    });
    await c('Esc leaves the tool; no js errors', async () => {
      // the first Esc deselects the mask (if one is selected), the next leaves the tool
      await page.eval('document.activeElement && document.activeElement.blur()');
      for (let i = 0; i < 2; i++) {
        await page.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27});
        await page.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27});
        await sleep(200);
      }
      await page.waitFor("document.querySelector('#toolbar-masks').hidden", {what: 'the masks bar closed'});
      assert(!page.errors.length, page.errors.join('; '));
    });
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
console.log(bad.length ? `masks: ${results.length - bad.length}/${results.length} passed, ${bad.length} failed` : `masks: ${results.length}/${results.length} passed (${URL_}, photo ${PHOTO})`);
process.exit(bad.length ? 1 : 0);
