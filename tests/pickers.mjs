#!/usr/bin/env node
// Module pickers on the photo (W70) over CDP: every module panel's "pick" row (hidden
// when the engine has none), arm / Esc / press again, a click on the photo (a box of ~1.5%
// each side), a drag (a box, clamped to the photo, .pickbox while dragging), the pipeline
// view's generic panels and second instances, an engine refusal, and on the phone the
// sheet that drops while a picker is armed, touch taps and drags, a second finger.
// Scratch web app only (:8030), never :8010; the edit is discarded (never saved).
//
//   (source /tmp/dts-N/env; node tests/pickers.mjs [--url http://127.0.0.1:8030]
//     [--port 9333] [--photo 161] [--only desktop|phone] [--out /tmp/w70] [--brief])

import {mkdirSync} from 'node:fs';
import {startChrome, openPage} from './cdp.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i < 0 ? dflt : args[i + 1]; };
const URL_ = opt('url', 'http://127.0.0.1:8030').replace(/\/$/, '');
const PORT = +opt('port', 9333);
const PHOTO = opt('photo', '161');
const OUT = opt('out', '/tmp/w70');
const ONLY = opt('only', null);
const BRIEF = args.includes('--brief');
if (/:8010\b/.test(URL_) && !args.includes('--force')) {
  console.error('pickers: refusing :8010 (the real library); use a scratch web app'); process.exit(2);
}
if (!process.env.DTAPI_SOCKET) { console.error('pickers: source the scratch engine\'s env first (DTAPI_SOCKET)'); process.exit(2); }
mkdirSync(OUT, {recursive: true});

const results = [];
const log = (s) => { if (!BRIEF) console.log(s); };
const assert = (c, m) => { if (!c) throw new Error(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, tol, what) => assert(Math.abs(a - b) <= tol, `${what}: ${a.toFixed(4)} vs ${b.toFixed(4)} (tolerance ${tol})`);
const API = `${URL_}/api/photo/${PHOTO}`;
const JSONH = {'Content-Type': 'application/json'};
const discard = () => fetch(`${API}/open?fresh=true`, {method: 'POST', headers: JSONH, body: '{}'});
const field = async (op, inst, name) => ((await (await fetch(`${API}/module?operation=${op}&instance=${inst}`)).json()).fields.find((f) => f.name === name) || {}).value;
const rendered = `(() => { const i = document.querySelector('#pv'); return i && i.src.startsWith('blob:') && i.complete && i.naturalWidth > 0; })()`;
const row = (k) => `#pipeline .prow[data-key="${k}"]`;
const btn = (scope, op, inst, ctl) => `${scope} .pickers button[data-op="${op}"][data-inst="${inst}"]${ctl ? `[data-pick="${ctl}"]` : ''}`;
const QUICK = '#panels .module';
const histLen = `document.querySelectorAll('#history li').length`;

async function check(mode, page, name, f) {
  const t = Date.now();
  try {
    const note = await f();
    results.push({mode, name, ok: true});
    log(`ok   ${mode} ${name} (${Date.now() - t} ms)${note ? ': ' + note : ''}`);
    return true;
  } catch (e) {
    const shot = await page.screenshot(`${OUT}/FAIL-${mode}-${name.replace(/\W+/g, '-').slice(0, 50)}.png`).catch(() => '');
    results.push({mode, name, ok: false, why: e.message, shot});
    log(`FAIL ${mode} ${name}: ${e.message} (${shot})`);
    return false;
  }
}

async function run(mode, port) {
  await discard();
  const page = await openPage(port);
  const phone = mode === 'phone';
  const c = (name, f) => check(mode, page, name, f);
  // --- helpers on the page
  const posts = () => page.eval('window.__posts');
  const reset = () => page.eval('window.__posts = []');
  // the photo as drawn in #pv (object-fit: contain), in page pixels
  const pv = () => page.eval(`(() => { const i = document.querySelector('#pv'), r = i.getBoundingClientRect(), k = Math.min(r.width / i.naturalWidth, r.height / i.naturalHeight);
    const w = i.naturalWidth * k, h = i.naturalHeight * k; return {l: r.left + (r.width - w) / 2, t: r.top + (r.height - h) / 2, w, h}; })()`);
  const at = async (fx, fy) => { const r = await pv(); return {x: r.l + fx * r.w, y: r.t + fy * r.h}; };
  const status = () => page.eval(`document.querySelector('#status').textContent`);
  const armed = () => page.eval(`document.querySelector('.view').classList.contains('picking')`);
  const lastPost = async () => { const p = await posts(); return p[p.length - 1]; };
  const mouse = (type, x, y, down) => page.send('Input.dispatchMouseEvent', {type, x, y, button: type === 'mouseMoved' && !down ? 'none' : 'left',
    buttons: type === 'mouseReleased' || (type === 'mouseMoved' && !down) ? 0 : 1, clickCount: type === 'mouseMoved' ? 0 : 1});
  const touch = (type, pts) => page.send('Input.dispatchTouchEvent', {type, touchPoints: pts.map((p, i) => ({x: p.x, y: p.y, id: i}))});
  // a click / tap and a drag on the photo, by mouse or touch
  const clickAt = async (x, y) => {
    if (phone) { await touch('touchStart', [{x, y}]); await touch('touchEnd', []); }
    else { await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); }
  };
  const dragStart = async (a, b, steps = 6) => {
    if (phone) { await touch('touchStart', [a]); for (let i = 1; i <= steps; i++) await touch('touchMove', [{x: a.x + (b.x - a.x) * i / steps, y: a.y + (b.y - a.y) * i / steps}]); }
    else { await mouse('mouseMoved', a.x, a.y); await mouse('mousePressed', a.x, a.y); for (let i = 1; i <= steps; i++) await mouse('mouseMoved', a.x + (b.x - a.x) * i / steps, a.y + (b.y - a.y) * i / steps, true); }
  };
  const dragEnd = async (b) => { if (phone) await touch('touchEnd', []); else await mouse('mouseReleased', b.x, b.y); };
  const pickbox = () => page.eval(`(() => { const e = document.querySelector('.pickbox'); if (!e) return null; const r = e.getBoundingClientRect(); return {hidden: e.hidden, w: r.width, h: r.height, l: r.left, t: r.top}; })()`);
  const esc = async () => {
    await page.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27});
    await page.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27});
  };
  const disarm = async () => { if (await armed()) { if (phone) await page.eval(`document.querySelector('.pickers button.on') && document.querySelector('.pickers button.on').click()`); else await esc(); await page.waitFor(`!document.querySelector('.view').classList.contains('picking')`, {what: 'disarmed'}); } };
  const waitPosted = (n) => page.waitFor(`window.__posts.length >= ${n} && window.__posts[${n - 1}].status`, {timeout: 60000, what: `pick POST ${n} answered`});
  const idle = () => sleep(600);
  const raise = async () => { if (!await page.eval(`document.body.classList.contains('sheet-up')`)) { await page.eval(`document.querySelector('#sheet-handle').click()`);
    await page.waitFor(`document.body.classList.contains('sheet-up')`, {what: 'sheet up'}); } };
  const quickVals = () => page.eval(`[...document.querySelector('${QUICK} .pickers button[data-op=exposure]').closest('.module').querySelectorAll('button.val')].map((b) => b.textContent).join('|')`);
  const showPipeline = async () => {
    if (phone) await page.eval(`document.querySelector('#sheet-handle').click()`);
    await page.eval(`document.querySelector('[data-view=pipeline]').click()`);
    await page.waitFor("!!document.querySelector('#pipeline .prow') && !!document.querySelector('#pipeline .padd input')", {what: 'the pipeline rows'});
  };
  const openRow = async (k) => {
    await page.waitFor(`!!document.querySelector('${row(k)}')`, {what: `row ${k}`});
    if (!await page.eval(`document.querySelector('${row(k)}').classList.contains('open')`)) await page.eval(`document.querySelector('${row(k)} .pname').click()`);
    await page.waitFor(`!!document.querySelector('${row(k)} .pbody .pickers button') || !!document.querySelector('${row(k)} .pbody .sec, ${row(k)} .pbody .module')`, {what: `${k} body`});
  };
  const addModule = async (text, op) => {
    await page.eval(`(() => { const q = document.querySelector('#pipeline .padd input'); q.value = ${JSON.stringify(text)}; q.dispatchEvent(new Event('input', {bubbles: true})); })()`);
    await page.waitFor(`!!document.querySelector('#pipeline .padd-list button[data-op=${op}]')`, {what: `the ${op} hit`});
    await page.eval(`document.querySelector('#pipeline .padd-list button[data-op=${op}]').click()`);
  };
  try {
    if (phone) await page.phone(); else await page.desktop();
    if (!await c('page opens and renders', async () => {
      await page.goto(`${URL_}/photo/${PHOTO}`);
      await page.waitFor(rendered, {timeout: 60000, what: 'the first render'});
      await page.eval(`(() => { window.__posts = []; const f0 = window.fetch;
        window.fetch = async (u, o) => { let rec = null;
          if (/\\/pick$/.test(String(u)) && o && o.method === 'POST') { rec = {body: JSON.parse(o.body)}; window.__posts.push(rec); }
          const r = await f0(u, o); if (rec) { try { rec.levels = (await r.clone().json()).levels; } catch (e) {} rec.status = r.status; } return r; }; })()`);
      await page.eval(`document.querySelector('[data-view=quick]').click()`);   // the tab is remembered
      await page.waitFor(`!!document.querySelector('${QUICK} .pickers button')`, {what: 'a picker button'});
    })) return;

    if (!phone) {
      await c('routes: exposure, agx, rgblevels list names; sharpen has none', async () => {
        const g = async (op) => (await (await fetch(`${API}/pickers?operation=${op}`)).json()).pickers;
        const [e, a, l, s] = [await g('exposure'), await g('agx'), await g('rgblevels'), await g('sharpen')];
        assert(e.length && a.length && l.length, JSON.stringify({e, a, l}));
        assert(Array.isArray(s) && s.length === 0, 'sharpen: ' + JSON.stringify(s));
        return `exposure ${e.length}, agx ${a.length}, rgblevels ${l.length}`;
      });

      await c('arm: .view.picking, button .on, status; Esc disarms with no POST; pressing twice disarms', async () => {
        const b = btn(QUICK, 'exposure', 0);
        await page.click(b);
        await page.waitFor(`document.querySelector('.view').classList.contains('picking')`, {what: 'armed'});
        assert(await page.eval(`document.querySelector('${b}').classList.contains('on')`), 'button not .on');
        assert(/click the photo, or drag a box/.test(await status()), 'status: ' + await status());
        await page.screenshot(`${OUT}/desktop-panel.png`);
        await esc();
        await page.waitFor(`!document.querySelector('.view').classList.contains('picking')`, {what: 'Esc disarmed'});
        assert(!await page.eval(`document.querySelector('${b}').classList.contains('on')`), 'button still .on after Esc');
        await page.click(b); await page.waitFor(`document.querySelector('.view').classList.contains('picking')`, {what: 'armed again'});
        await page.click(b); await page.waitFor(`!document.querySelector('.view').classList.contains('picking')`, {what: 'second press disarmed'});
        assert(!await page.eval(`document.querySelector('${b}').classList.contains('on')`), 'button still .on');
        await idle();
        assert((await posts()).length === 0, 'a POST: ' + JSON.stringify(await posts()));
      });

      await c('click on the photo: POST exposure/0 box ~0.03 wide, value changes, one history step, status "picker"', async () => {
        const v0 = await field('exposure', 0, 'exposure'), n0 = await page.eval(histLen), t0 = await quickVals();
        await reset();
        await page.click(btn(QUICK, 'exposure', 0));
        await page.waitFor(`document.querySelector('.view').classList.contains('picking')`, {what: 'armed'});
        const p = await at(0.3, 0.3);
        await clickAt(p.x, p.y);
        await waitPosted(1);
        const post = await lastPost(), r = await pv();
        assert(post.status === 200, 'POST status ' + post.status);
        assert(post.body.operation === 'exposure' && post.body.instance === 0, JSON.stringify(post.body));
        const bx = post.body.box;
        near(bx.right - bx.left, 0.03, 0.004, 'box width'); near(bx.bottom - bx.top, 0.03, 0.004, 'box height');
        near((bx.left + bx.right) / 2, 0.3, 0.005, 'box center x'); near((bx.top + bx.bottom) / 2, 0.3, 0.005, 'box center y');
        assert(!await armed(), 'still armed after the pick');
        await page.waitFor(`/picker/.test(document.querySelector('#status').textContent)`, {what: 'status "picker"'});
        const v1 = await field('exposure', 0, 'exposure');
        assert(v1 !== v0, `exposure unchanged on the engine (${v0})`);
        await page.waitFor(`${histLen} > ${n0}`, {what: 'history longer'});
        await idle();
        assert(await page.eval(histLen) === n0 + 1, `history ${n0} -> ${await page.eval(histLen)}`);
        assert(await quickVals() !== t0, 'the panel still shows ' + t0);
        return `exposure ${v0.toFixed(2)} -> ${v1.toFixed(2)}`;
      });

      await c('drag a box: .pickbox mid-drag, gone after; POST box = the dragged rectangle (+-0.01)', async () => {
        await reset();
        await page.click(btn(QUICK, 'exposure', 0));
        await page.waitFor(`document.querySelector('.view').classList.contains('picking')`, {what: 'armed'});
        const a = await at(0.2, 0.25), b = await at(0.55, 0.6);
        await dragStart(a, b);
        const pb = await pickbox();
        assert(pb && !pb.hidden && pb.w > 100 && pb.h > 100, 'no .pickbox mid-drag: ' + JSON.stringify(pb));
        await page.screenshot(`${OUT}/desktop-drag.png`);
        await dragEnd(b);
        await waitPosted(1);
        assert(await pickbox() === null, '.pickbox still there');
        const bx = (await lastPost()).body.box;
        near(bx.left, 0.2, 0.01, 'left'); near(bx.top, 0.25, 0.01, 'top'); near(bx.right, 0.55, 0.01, 'right'); near(bx.bottom, 0.6, 0.01, 'bottom');
        await idle();
      });

      await c('drag past the photo\'s edge clamps to 0..1', async () => {
        await reset();
        await page.click(btn(QUICK, 'exposure', 0));
        await page.waitFor(`document.querySelector('.view').classList.contains('picking')`, {what: 'armed'});
        const r = await pv(), a = await at(0.7, 0.7);
        const b = {x: r.l + r.w + 60, y: r.t + r.h + 30};
        await dragStart(a, b); await dragEnd(b);
        await waitPosted(1);
        const bx = (await lastPost()).body.box;
        near(bx.left, 0.7, 0.01, 'left'); near(bx.top, 0.7, 0.01, 'top');
        assert(bx.right === 1 && bx.bottom === 1, 'right/bottom: ' + JSON.stringify(bx));
        await idle();
      });
    }

    if (!phone) {
      await showPipeline();
      await c('pipeline, generic panel: rgblevels row shows black/gray/white, a pick changes its levels', async () => {
        await addModule('rgb levels', 'rgblevels');
        await openRow('rgblevels:0');
        const sel = row('rgblevels:0');
        await page.waitFor(`document.querySelectorAll('${sel} .pickers button').length === 3 && !document.querySelector('${sel} .pickers').hidden`, {what: 'three picker buttons'});
        const names = await page.eval(`[...document.querySelectorAll('${sel} .pickers button')].map((b) => b.textContent).join(',')`);
        assert(names === 'black,gray,white', names);
        const l0 = '[0,0.5,1]';   // the module's default (first channel)
        await reset();
        await page.click(`${sel} .pickers button[data-pick="pickers/white"]`);
        await page.waitFor(`document.querySelector('.view').classList.contains('picking')`, {what: 'armed'});
        await page.eval(`document.querySelector('#pipeline').scrollIntoView()`);
        await page.screenshot(`${OUT}/pipeline-rgblevels.png`);
        const p = await at(0.4, 0.4);
        await clickAt(p.x, p.y);
        await waitPosted(1);
        const post = await lastPost();
        assert(post.body.operation === 'rgblevels' && post.body.control === 'pickers/white', JSON.stringify(post.body));
        assert(post.status === 200, 'POST status ' + post.status);
        await idle();
        const l1 = JSON.stringify((post.levels && post.levels.levels && post.levels.levels[0] || []).map((v) => +v.toFixed(3)));
        assert(post.levels && l1 !== l0, 'levels unchanged: ' + l1);
        return `${l0} -> ${l1}`;
      });

      await c('second exposure instance: its row picks with data-inst=1, POST instance 1, only instance 1 changes', async () => {
        await addModule('exposure', 'exposure');
        await openRow('exposure:1');
        const sel = row('exposure:1');
        await page.waitFor(`!!document.querySelector('${btn(sel, 'exposure', 1)}')`, {what: 'instance 1 picker button'});
        const a0 = await field('exposure', 0, 'exposure'), b0 = await field('exposure', 1, 'exposure');
        await reset();
        await page.click(btn(sel, 'exposure', 1));
        await page.waitFor(`document.querySelector('.view').classList.contains('picking')`, {what: 'armed'});
        const p = await at(0.6, 0.35);
        await clickAt(p.x, p.y);
        await waitPosted(1);
        assert((await lastPost()).body.instance === 1, JSON.stringify((await lastPost()).body));
        await idle();
        const a1 = await field('exposure', 0, 'exposure'), b1 = await field('exposure', 1, 'exposure');
        assert(b1 !== b0, `instance 1 unchanged (${b0})`);
        assert(a1 === a0, `instance 0 changed ${a0} -> ${a1}`);
      });

      await c('engine refusal: filmic "middle gray luminance" says "not applied", nothing armed, page still works', async () => {
        await addModule('filmic', 'filmicrgb');
        await openRow('filmicrgb:0');
        const b = `${row('filmicrgb:0')} .pickers button[data-pick="middle gray luminance"]`;
        await page.waitFor(`!!document.querySelector('${b}')`, {what: 'the middle gray button'});
        await reset();
        await page.click(b);
        await page.waitFor(`document.querySelector('.view').classList.contains('picking')`, {what: 'armed'});
        const p = await at(0.5, 0.5);
        await clickAt(p.x, p.y);
        await waitPosted(1);
        await page.waitFor(`/not applied/.test(document.querySelector('#status').textContent)`, {what: 'status "not applied"'});
        assert(!await armed(), 'still armed after the refusal');
        assert(!await page.eval(`!!document.querySelector('[data-pick].on')`), 'a button still .on');
        // a slider change still reaches the engine
        const v0 = await field('exposure', 0, 'exposure');
        await page.eval(`(() => { const r = [...document.querySelectorAll('${QUICK} input[type=range]')][0]; const m = r.closest('.module');
          const s = m.querySelector('.pickers button[data-op=exposure]') ? r : r; s.value = ${v0 + 0.4}; s.dispatchEvent(new Event('input', {bubbles: true})); })()`);
        for (let i = 0; i < 50 && Math.abs((await field('exposure', 0, 'exposure')) - v0) < 0.01; i++) await sleep(200);
        assert(Math.abs((await field('exposure', 0, 'exposure')) - v0) >= 0.01, 'a slider change did not reach the engine');
      });

      await c('sharpen has no picker row (hidden or none)', async () => {
        await page.waitFor(`!!document.querySelector('${row('sharpen:0')}') || true`, {});
        const r = await page.eval(`(() => { const rows = [...document.querySelectorAll('#panels .module, #pipeline .prow[data-key^="sharpen:"]')]
          .filter((m) => /sharpen/i.test(m.textContent.slice(0, 60))); return rows.map((m) => [...m.querySelectorAll('.pickers')].every((p) => p.hidden || !p.querySelector('button'))); })()`);
        assert(r.every(Boolean), JSON.stringify(r));
        return `${r.length} sharpen panel(s)`;
      });
    }

    if (phone) {
      await c('phone: raise the sheet, tap a picker: sheet down, photo > 400 px, panel <= ~44 px, tap on the photo picks, sheet back up', async () => {
        await page.eval(`document.querySelector('#sheet-handle').click()`);
        await page.waitFor(`document.body.classList.contains('sheet-up')`, {what: 'sheet up'});
        await page.screenshot(`${OUT}/phone-panel.png`);
        const b = btn(QUICK, 'exposure', 0);
        await page.waitFor(`!!document.querySelector('${b}')`, {what: 'picker button'});
        await reset();
        await page.tap(b);
        await page.waitFor(`document.querySelector('.view').classList.contains('picking') && !document.body.classList.contains('sheet-up')`, {what: 'armed, sheet down'});
        await idle();
        const m = await page.eval(`({pv: document.querySelector('#pv').getBoundingClientRect().height, panel: document.querySelector('.panel').getBoundingClientRect().height})`);
        assert(m.pv > 400, 'photo ' + m.pv);
        assert(m.panel <= 50, 'panel ' + m.panel);
        await page.screenshot(`${OUT}/phone-armed.png`);
        const v0 = await field('exposure', 0, 'exposure');
        const p = await at(0.4, 0.5);
        await clickAt(p.x, p.y);
        await waitPosted(1);
        const post = await lastPost(), bx = post.body.box;
        assert(post.body.operation === 'exposure' && post.status === 200, JSON.stringify(post));
        near(bx.right - bx.left, 0.03, 0.004, 'box width');
        await idle();
        assert(await field('exposure', 0, 'exposure') !== v0, 'exposure unchanged');
      });

      // the tap's own click lands on the sheet handle the pick just raised (the sheet toggles down again)
      await c('phone: after a tap pick the sheet stays up', async () => {
        await sleep(600);
        const up = await page.eval(`document.body.classList.contains('sheet-up')`);
        await raise();    // so the checks after this one still run
        assert(up, 'the sheet is down after the pick (the tap\'s click hit #sheet-handle)');
      });

      await c('phone: touch drag draws a box and POSTs that rectangle; a second finger mid-drag cancels it', async () => {
        const b = btn(QUICK, 'exposure', 0);
        await reset();
        await page.tap(b);
        await page.waitFor(`document.querySelector('.view').classList.contains('picking') && !document.body.classList.contains('sheet-up')`, {what: 'armed, sheet down'});
        const a = await at(0.25, 0.3), e = await at(0.7, 0.6);
        await dragStart(a, e);
        const pb = await pickbox();
        assert(pb && !pb.hidden && pb.w > 50, 'no .pickbox mid-drag: ' + JSON.stringify(pb));
        await dragEnd(e);
        await waitPosted(1);
        const bx = (await lastPost()).body.box;
        near(bx.left, 0.25, 0.01, 'left'); near(bx.top, 0.3, 0.01, 'top'); near(bx.right, 0.7, 0.01, 'right'); near(bx.bottom, 0.6, 0.01, 'bottom');
        await page.waitFor(`document.body.classList.contains('sheet-up')`, {what: 'sheet back up'});
        await idle();
        // second finger
        await reset();
        await page.tap(b);
        await page.waitFor(`document.querySelector('.view').classList.contains('picking') && !document.body.classList.contains('sheet-up')`, {what: 'armed again'});
        await dragStart(a, e, 3);
        const second = await at(0.8, 0.8);
        await touch('touchStart', [e, second]);
        assert(await pickbox() === null, '.pickbox survived a second finger');
        await touch('touchEnd', []);
        await idle();
        assert((await posts()).length === 0, 'a POST after a second finger: ' + JSON.stringify(await posts()));
        await disarm();
      });

      await c('phone: raising the sheet by the handle while armed, pressing the button again cancels (no POST)', async () => {
        await reset();
        await page.tap(btn(QUICK, 'exposure', 0));
        await page.waitFor(`document.querySelector('.view').classList.contains('picking') && !document.body.classList.contains('sheet-up')`, {what: 'armed, sheet down'});
        await page.tap('#sheet-handle');
        await page.waitFor(`document.body.classList.contains('sheet-up')`, {what: 'sheet raised by the handle'});
        const b = btn(QUICK, 'exposure', 0);
        assert(await armed(), 'disarmed by raising the sheet');
        assert(await page.eval(`document.querySelector('${b}').classList.contains('on')`), 'button not .on with the sheet up');
        await page.tap(b);
        await page.waitFor(`!document.querySelector('.view').classList.contains('picking')`, {what: 'disarmed'});
        assert(!await page.eval(`document.querySelector('${b}').classList.contains('on')`), 'button still .on');
        await idle();
        assert((await posts()).length === 0, 'a POST: ' + JSON.stringify(await posts()));
        assert(await page.eval(`document.body.classList.contains('sheet-up')`), 'sheet down after cancel');
      });
    }

    await c('no js errors, no failed loads', async () => {
      assert(!page.errors.length, page.errors.join('; '));
      // the favicon, and the refused pick's 400 (desktop)
      const bad = page.failedLoads.filter((l) => !/favicon\.ico/.test(l.url) && !(!phone && /\/pick$/.test(l.url) && /400/.test(l.text)));
      assert(!bad.length, JSON.stringify(bad));
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
console.log(bad.length ? `pickers: ${results.length - bad.length}/${results.length} passed, ${bad.length} failed` : `pickers: ${results.length}/${results.length} passed (${URL_}, photo ${PHOTO})`);
process.exit(bad.length ? 1 : 0);
