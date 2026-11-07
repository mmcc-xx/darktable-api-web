#!/usr/bin/env node
// Tone equalizer bands on the photo (W71) over CDP: the panel's "on the photo" button, the
// tonemask route, hovering the photo to light the band's row, the wheel and a vertical drag
// moving that band, no refetch of the mask for a band move (but one for another module's
// change), a real brightening, the pipeline view and a second instance, 100% zoom (no pan),
// tool exclusivity, and on the phone the sheet that drops, the tonebar (+/-/done), tap,
// touch drag and a second finger. Scratch web app only (:8030), never :8010; the edit is
// discarded (never saved).
//
//   (source /tmp/dts-N/env; node tests/toneband.mjs [--url http://127.0.0.1:8030]
//     [--port 9333] [--photo 161] [--only desktop|phone] [--out /tmp/w71] [--brief])

import {mkdirSync} from 'node:fs';
import {startChrome, openPage} from './cdp.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i < 0 ? dflt : args[i + 1]; };
const URL_ = opt('url', 'http://127.0.0.1:8030').replace(/\/$/, '');
const PORT = +opt('port', 9333);
const PHOTO = opt('photo', '161');
const OUT = opt('out', '/tmp/w71');
const ONLY = opt('only', null);
const BRIEF = args.includes('--brief');
if (/:8010\b/.test(URL_) && !args.includes('--force')) {
  console.error('toneband: refusing :8010 (the real library); use a scratch web app'); process.exit(2);
}
if (!process.env.DTAPI_SOCKET) { console.error('toneband: source the scratch engine\'s env first (DTAPI_SOCKET)'); process.exit(2); }
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
const BANDS = ['noise', 'ultra_deep_blacks', 'deep_blacks', 'blacks', 'shadows', 'midtones', 'highlights', 'whites', 'speculars'];
const bandOf = (v) => BANDS[Math.max(-8, Math.min(0, Math.round(v))) + 8];
const TQ = (inst, scope = '#panels') => `${scope} .module[data-op="toneequal"][data-inst="${inst}"]`;
const histLen = `document.querySelectorAll('#history li').length`;
const row = (k) => `#pipeline .prow[data-key="${k}"]`;
const grid = async (inst = 0) => (await fetch(`${API}/tonemask?instance=${inst}`)).json();
// photo points whose 5x5 cells around all belong to one band (and sit near that band's EV), nearest the middle first
function stablePoints(g) {
  const {width: w, height: h, ev} = g, out = [];
  for (let cy = 2; cy < h - 2; cy++) for (let cx = 2; cx < w - 2; cx++) {
    const v = ev[cy * w + cx];
    if (v === null || Math.abs(v - Math.round(v)) > 0.3 || Math.round(v) < -7 || Math.round(v) > -1) continue;
    let ok = true;
    for (let dy = -2; dy <= 2 && ok; dy++) for (let dx = -2; dx <= 2; dx++) { const u = ev[(cy + dy) * w + cx + dx]; if (u === null || bandOf(u) !== bandOf(v)) { ok = false; break; } }
    if (ok) out.push({fx: (cx + 0.5) / w, fy: (cy + 0.5) / h, band: bandOf(v), ev: v});
  }
  return out.sort((a, b) => Math.hypot(a.fx - .5, a.fy - .5) - Math.hypot(b.fx - .5, b.fy - .5));
}

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
  const posts = () => page.eval('window.__posts');
  const masks = () => page.eval('window.__masks');
  const nSets = async () => (await posts()).length;
  const lastSet = async () => { const p = await posts(); return p[p.length - 1]; };
  const pv = () => page.eval(`(() => { const i = document.querySelector('#pv'), r = i.getBoundingClientRect(), k = Math.min(r.width / i.naturalWidth, r.height / i.naturalHeight);
    const w = i.naturalWidth * k, h = i.naturalHeight * k; return {l: r.left + (r.width - w) / 2, t: r.top + (r.height - h) / 2, w, h}; })()`);
  const at = async (fx, fy) => { const r = await pv(); return {x: r.l + fx * r.w, y: r.t + fy * r.h}; };
  const status = () => page.eval(`document.querySelector('#status').textContent`);
  const toning = () => page.eval(`document.querySelector('.view').classList.contains('toning')`);
  const hits = () => page.eval(`[...document.querySelectorAll('.field.tonehit')].map((f) => f.dataset.field)`);
  const mouse = (type, x, y, down) => page.send('Input.dispatchMouseEvent', {type, x, y, button: type === 'mouseMoved' && !down ? 'none' : 'left',
    buttons: type === 'mouseReleased' || (type === 'mouseMoved' && !down) ? 0 : 1, clickCount: type === 'mouseMoved' ? 0 : 1});
  const wheel = (x, y, dy) => page.send('Input.dispatchMouseEvent', {type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy});
  const touch = (type, pts) => page.send('Input.dispatchTouchEvent', {type, touchPoints: pts.map((p, i) => ({x: p.x, y: p.y, id: i}))});
  const key = async (k, code, vk) => { for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', {type, key: k, code, windowsVirtualKeyCode: vk, text: type === 'keyDown' && k.length === 1 ? k : undefined}); };
  const esc = () => key('Escape', 'Escape', 27);
  const drag = async (p, dy, steps = 6) => {
    if (phone) { await touch('touchStart', [p]); for (let i = 1; i <= steps; i++) await touch('touchMove', [{x: p.x, y: p.y + dy * i / steps}]); await touch('touchEnd', []); }
    else { await mouse('mouseMoved', p.x, p.y); await mouse('mousePressed', p.x, p.y); for (let i = 1; i <= steps; i++) await mouse('mouseMoved', p.x, p.y + dy * i / steps, true); await mouse('mouseReleased', p.x, p.y + dy); }
  };
  // hover until the mask is in and the row lights (the grid loads after arming)
  const hover = async (p) => { for (let i = 0; i < 40; i++) { await mouse('mouseMoved', p.x - 1, p.y); await mouse('mouseMoved', p.x, p.y); if ((await hits()).length) return; await sleep(250); } };
  const sl = (b, inst = 0, scope = '#panels') => `${TQ(inst, scope)} .field[data-field="${b}"] input[type=range]`;
  const slv = (b, inst = 0, scope = '#panels') => page.eval(`+document.querySelector('${sl(b, inst, scope)}').value`);
  const settle = async (op, inst, name, want, tol = 0.011) => { for (let i = 0; i < 60; i++) { const v = await field(op, inst, name); if (v !== undefined && Math.abs(v - want) <= tol) return v; await sleep(250); } return field(op, inst, name); };
  const arm = async (inst = 0, scope = '#panels') => {
    const b = `${TQ(inst, scope)} button[data-tone="${inst}"]`;
    await page.waitFor(`!!document.querySelector('${b}')`, {what: 'the tone button'});
    await page.eval(`(() => { const d = document.querySelector('${b}').closest('details'); if (d) d.open = true; })()`);
    const n = (await masks()).length;
    await page.click(b);
    await page.waitFor(`document.querySelector('.view').classList.contains('toning')`, {what: 'toning'});
    await page.waitFor(`window.__masks.length > ${n}`, {what: 'the tonemask GET'});
    return b;
  };
  const disarm = async () => { if (await toning()) { await esc(); await page.waitFor(`!document.querySelector('.view').classList.contains('toning')`, {what: 'left toning'}); } };
  const resetBand = async (b, inst = 0) => { await page.eval(`document.querySelector('${TQ(inst)} .field[data-field="${b}"] > span').ondblclick()`); await settle('toneequal', inst, b, 0); };
  const rawSrc = () => page.eval(`document.querySelector('#pv').src`);
  const newRender = async (src0) => { await page.waitFor(`document.querySelector('#pv').src !== ${JSON.stringify(src0)} && ${rendered}`, {timeout: 60000, what: 'a new render'}); await sleep(1500); };
  // mean luma of a box (photo fractions) of the picture as shown
  const luma = (fx, fy) => page.eval(`(() => { const i = document.querySelector('#pv'), c = document.createElement('canvas'); c.width = i.naturalWidth; c.height = i.naturalHeight;
    const x = c.getContext('2d'); x.drawImage(i, 0, 0); const bw = Math.round(c.width * .03), bh = Math.round(c.height * .03);
    const d = x.getImageData(Math.round(${fx} * c.width) - bw, Math.round(${fy} * c.height) - bh, bw * 2, bh * 2).data; let s = 0;
    for (let k = 0; k < d.length; k += 4) s += .2126 * d[k] + .7152 * d[k + 1] + .0722 * d[k + 2]; return s / (d.length / 4); })()`);
  const raise = async () => { if (!await page.eval(`document.body.classList.contains('sheet-up')`)) { await page.eval(`document.querySelector('#sheet-handle').click()`);
    await page.waitFor(`document.body.classList.contains('sheet-up')`, {what: 'sheet up'}); } };
  const showPipeline = async () => {
    await page.eval(`document.querySelector('[data-view=pipeline]').click()`);
    await page.waitFor("!!document.querySelector('#pipeline .prow') && !!document.querySelector('#pipeline .padd input')", {what: 'the pipeline rows'});
  };
  const openRow = async (k) => {
    await page.waitFor(`!!document.querySelector('${row(k)}')`, {what: `row ${k}`});
    if (!await page.eval(`document.querySelector('${row(k)}').classList.contains('open')`)) await page.eval(`document.querySelector('${row(k)} .pname').click()`);
    await page.waitFor(`!!document.querySelector('${row(k)} button[data-tone]')`, {what: `${k} body with the tone button`});
  };
  const hooks = () =>
      page.eval(`(() => { window.__posts = []; window.__masks = []; const f0 = window.fetch;
        window.fetch = async (u, o) => { u = String(u); let rec = null;
          if (/\\/tonemask/.test(u)) window.__masks.push(u);
          if (/\\/set$/.test(u) && o && o.method === 'POST') { rec = {body: JSON.parse(o.body)}; window.__posts.push(rec); }
          const r = await f0(u, o); if (rec) rec.status = r.status; return r; }; })()`);
  let P1 = null, P2 = null;
  try {
    if (phone) await page.phone(); else await page.desktop();
    if (!await c('page opens and renders, the tone panel has its button', async () => {
      await page.goto(`${URL_}/photo/${PHOTO}`);
      await page.waitFor(rendered, {timeout: 60000, what: 'the first render'});
      await hooks();
      await page.eval(`document.querySelector('[data-view=quick]').click()`);
      await page.waitFor(`!!document.querySelector('${TQ(0)} button[data-tone="0"]')`, {what: 'the tone button'});
      const g = await grid(); const pts = stablePoints(g);
      assert(pts.length, 'no stable point in the tone mask');
      P1 = pts[0]; P2 = pts.find((p) => p.band !== P1.band) || null;
      return `P1 ${P1.band} (${P1.fx.toFixed(2)},${P1.fy.toFixed(2)}), P2 ${P2 ? P2.band : 'none: flat photo'}`;
    })) return;

    if (!phone) {
      await c('route: width*height == ev.length, longest side 160; instance 7 fails with detail', async () => {
        const g = await grid(); assert(g.width * g.height === g.ev.length, `${g.width}x${g.height} vs ${g.ev.length}`);
        assert(Math.max(g.width, g.height) === 160, `${g.width}x${g.height}`);
        const r = await fetch(`${API}/tonemask?instance=7`); const j = await r.json().catch(() => ({}));
        assert(r.status >= 400 && j.detail, `status ${r.status} ${JSON.stringify(j).slice(0, 100)}`);
      });

      await c('button arms (one GET, .on, .toning); Esc leaves; the button twice leaves', async () => {
        const n0 = (await masks()).length, b = await arm();
        assert((await masks()).length === n0 + 1, 'GETs: ' + ((await masks()).length - n0));
        assert(await page.eval(`document.querySelector('${b}').classList.contains('on')`), 'button not .on');
        await hover(await at(P1.fx, P1.fy)); assert((await hits()).length === 1, 'no tonehit');
        await esc();
        await page.waitFor(`!document.querySelector('.view').classList.contains('toning')`, {what: 'Esc left'});
        assert(!(await hits()).length, 'tonehit after Esc');
        assert(!await page.eval(`document.querySelector('${b}').classList.contains('on')`), 'button still .on after Esc');
        await page.click(b); await page.waitFor(`document.querySelector('.view').classList.contains('toning')`, {what: 'armed again'});
        await page.click(b); await page.waitFor(`!document.querySelector('.view').classList.contains('toning')`, {what: 'second press left'});
      });

      await c('hover two places: the tonehit row is the grid\'s band, exactly one row, status has "EV"', async () => {
        await arm();
        const pts = [P1, P2].filter(Boolean);
        for (const p of pts) {
          await hover(await at(p.fx, p.fy));
          await page.waitFor(`document.querySelector('.field.tonehit') && document.querySelector('.field.tonehit').dataset.field === '${p.band}'`, {what: `row ${p.band}`});
          const h = await hits(); assert(h.length === 1 && h[0] === p.band, `hit ${JSON.stringify(h)}, want ${p.band}`);
          assert(/EV/.test(await status()), 'status: ' + await status());
        }
        await page.screenshot(`${OUT}/desktop-hover.png`);
        return pts.length < 2 ? 'photo is flat: one band only, second place skipped' : `${P1.band}, ${P2.band}`;
      });

      await c('wheel up 2 notches: +0.4 on the slider and the engine, module on, new render, other bands 0, history grew', async () => {
        const b = P1.band, p = await at(P1.fx, P1.fy), n0 = await page.eval(histLen), s0 = await rawSrc(), v0 = await slv(b), n = await nSets();
        await hover(p); await wheel(p.x, p.y, -100); await wheel(p.x, p.y, -100);
        near(await slv(b), v0 + 0.4, 0.01, 'slider');
        near(await settle('toneequal', 0, b, v0 + 0.4), v0 + 0.4, 0.011, 'engine');
        assert(await page.eval(`document.querySelector('${TQ(0)} .head input').checked`), 'module not switched on');
        assert((await nSets()) > n && (await lastSet()).body.operation === 'toneequal', 'no /set toneequal');
        await newRender(s0);
        for (const o of BANDS.filter((x) => x !== b)) assert(Math.abs(await field('toneequal', 0, o)) < 1e-6, `${o} = ${await field('toneequal', 0, o)}`);
        await page.waitFor(`${histLen} > ${n0}`, {what: 'history longer'});
        await page.screenshot(`${OUT}/desktop-moved.png`);
      });

      await c('wheel down returns; drag up 50 px +0.5, drag down lowers, past +-2 clamps', async () => {
        const b = P1.band, p = await at(P1.fx, P1.fy);
        await hover(p); await wheel(p.x, p.y, 100); await wheel(p.x, p.y, 100);
        near(await slv(b), 0, 0.01, 'back to 0');
        await drag(p, -50); near(await slv(b), 0.5, 0.06, 'drag up 50');
        const v1 = await slv(b); await drag(p, 30); near(await slv(b), v1 - 0.3, 0.06, 'drag down 30');
        await drag(p, -150); await drag(p, -150); await drag(p, -150);
        near(await slv(b), 2, 0.001, 'clamped slider');
        near(await settle('toneequal', 0, b, 2, 0.001), 2, 0.001, 'clamped engine');
        await drag(p, 300); near(await slv(b), -1, 0.06, 'down 300 from 2'); await drag(p, 300); await drag(p, 300);
        near(await slv(b), -2, 0.001, 'clamped at -2');
        await resetBand(b);
      });

      await c('a band move does not refetch the mask; an exposure change does (and the grid differs)', async () => {
        const b = P1.band, p = await at(P1.fx, P1.fy), g0 = JSON.stringify((await grid()).ev);
        await hover(p); const n0 = (await masks()).length, s = await nSets();
        await wheel(p.x, p.y, -100); await settle('toneequal', 0, b, 0.2);
        await sleep(1500); assert((await masks()).length === n0, `refetched ${(await masks()).length - n0} times after a band move`);
        const m1 = (await masks()).length;
        await page.eval(`(() => { const r = document.querySelector('${TQ(0).replace('toneequal', 'exposure')} input[type=range]'); r.value = +r.value + 0.7; r.oninput(); })()`);
        await page.waitFor(`window.__masks.length > ${m1}`, {timeout: 30000, what: 'a tonemask refetch after the exposure change'});
        assert(JSON.stringify((await grid()).ev) !== g0, 'the grid did not change with exposure');
        await resetBand(b);
        await page.eval(`(() => { const r = document.querySelector('${TQ(0).replace('toneequal', 'exposure')} input[type=range]'); r.value = +r.value - 0.7; r.oninput(); })()`);
        await sleep(2500);
        const g = stablePoints(await grid()); P1 = g[0]; P2 = g.find((x) => x.band !== P1.band) || null;
      });

      await c('+1 EV on a band brightens the picture near the point', async () => {
        const b = P1.band, p = await at(P1.fx, P1.fy), s0 = await rawSrc(), before = await luma(P1.fx, P1.fy);
        await hover(p); for (let i = 0; i < 5; i++) await wheel(p.x, p.y, -100);
        near(await settle('toneequal', 0, b, 1), 1, 0.011, 'engine +1 EV');
        await newRender(s0);
        const after = await luma(P1.fx, P1.fy);
        assert(after > before, `luma ${before.toFixed(2)} -> ${after.toFixed(2)}`);
        await resetBand(b);
        return `${before.toFixed(1)} -> ${after.toFixed(1)}`;
      });

      await c('100% zoom: hover reads a band, a drag moves the band and does not pan', async () => {
        await disarm();
        const s0 = await rawSrc();
        await page.click('button[data-zoom="1"]');
        await page.waitFor(`document.querySelector('.view').classList.contains('zoomed')`, {what: 'zoomed'});
        await newRender(s0);
        await arm();
        const r = await page.eval(`(() => { const v = document.querySelector('.view').getBoundingClientRect(); return {x: v.left + v.width / 2, y: v.top + v.height / 2}; })()`);
        await hover(r);
        assert((await hits()).length === 1, 'tonehit: ' + JSON.stringify(await hits()));
        const b = (await hits())[0], n = await nSets(), v0 = await slv(b), t0 = await page.eval(`document.querySelector('#pv').style.transform`);
        await drag(r, -40);
        near(await slv(b), v0 + 0.4, 0.06, 'drag in 100%');
        assert((await nSets()) > n, 'no /set');
        assert(await page.eval(`document.querySelector('#pv').style.transform`) === t0 && t0 === '', 'the picture moved: ' + await page.eval(`document.querySelector('#pv').style.transform`));
        assert(!await page.eval(`document.querySelector('.view').classList.contains('panning')`), 'panning');
        await resetBand(b); await disarm();
        const s1 = await rawSrc(); await page.click('button[data-zoom="0"]'); await newRender(s1);
      });

      await c('tool exclusivity: key d and a picker button leave toning', async () => {
        await arm(); await key('d', 'KeyD', 68);
        await page.waitFor(`!document.querySelector('.view').classList.contains('toning') && document.querySelector('.view').classList.contains('dusting')`, {what: 'dust on, toning off'});
        await key('d', 'KeyD', 68);
        await page.waitFor(`!document.querySelector('.view').classList.contains('dusting')`, {what: 'dust off'});
        await arm();
        await page.click('#panels .pickers button[data-op="exposure"]');
        await page.waitFor(`!document.querySelector('.view').classList.contains('toning') && document.querySelector('.view').classList.contains('picking')`, {what: 'picking on, toning off'});
        await esc(); await page.waitFor(`!document.querySelector('.view').classList.contains('picking')`, {what: 'Esc left picking'});
        assert(!(await hits()).length, 'tonehit left over');
      });

      // the pipeline list is built from the edit's history when the page opens: reload so it has toneequal
      page.on('Page.javascriptDialogOpening', () => page.send('Page.handleJavaScriptDialog', {accept: true}));   // unsaved edit: leave anyway
      await page.goto(`${URL_}/photo/${PHOTO}`); await page.waitFor(rendered, {timeout: 60000, what: 'the render after reload'}); await hooks();
      await showPipeline();
      await c('pipeline view: the row\'s panel has the button, hover lights its row, wheel moves its slider', async () => {
        await openRow('toneequal:0');
        await arm(0, row('toneequal:0'));
        const b = P1.band, p = await at(P1.fx, P1.fy);
        await hover(p);
        assert(await page.eval(`!!document.querySelector('${row('toneequal:0')} .field.tonehit[data-field="${b}"]')`), 'row not lit in #pipeline');
        const v0 = await slv(b, 0, row('toneequal:0'));
        await wheel(p.x, p.y, -100); await wheel(p.x, p.y, -100);
        near(await slv(b, 0, row('toneequal:0')), v0 + 0.4, 0.01, 'pipeline slider');
        near(await settle('toneequal', 0, b, v0 + 0.4), v0 + 0.4, 0.011, 'engine');
        await page.eval(`document.querySelector('${row('toneequal:0')}').scrollIntoView()`);
        await page.screenshot(`${OUT}/pipeline.png`);
        await resetBand(b, 0).catch(() => {});
        await disarm();
      });

      await c('second instance: button data-tone=1, GET instance=1, /set instance 1, instance 0 unchanged', async () => {
        await page.eval(`(() => { const q = document.querySelector('#pipeline .padd input'); q.value = 'tone equalizer'; q.dispatchEvent(new Event('input', {bubbles: true})); })()`);
        await page.waitFor(`!!document.querySelector('#pipeline .padd-list button[data-op=toneequal]')`, {what: 'the toneequal hit'});
        await page.eval(`document.querySelector('#pipeline .padd-list button[data-op=toneequal]').click()`);
        await openRow('toneequal:1');
        const sc = row('toneequal:1'), b = P1.band, a0 = await field('toneequal', 0, b);
        await arm(1, sc);
        assert((await masks()).pop().endsWith('instance=1'), 'GET: ' + (await masks()).pop());
        const p = await at(P1.fx, P1.fy); await hover(p);
        const n = await nSets(); await wheel(p.x, p.y, -100); await wheel(p.x, p.y, -100);
        await page.waitFor(`window.__posts.length > ${n}`, {what: 'a /set'});
        assert((await lastSet()).body.instance === 1 && (await lastSet()).body.operation === 'toneequal', JSON.stringify((await lastSet()).body));
        near(await settle('toneequal', 1, b, 0.4), 0.4, 0.011, 'instance 1');
        assert(await field('toneequal', 0, b) === a0, `instance 0 changed ${a0} -> ${await field('toneequal', 0, b)}`);
        await disarm();
      });
    }

    if (phone) {
      await c('phone: raise the sheet, open the panel, tap the button: sheet down, panel <= 50, photo > 400, tonebar shown', async () => {
        await raise();
        await page.eval(`document.querySelector('[data-view=quick]').click()`);
        await page.eval(`(() => { const d = document.querySelector('${TQ(0)}').closest('details'); if (d) d.open = true; })()`);
        await page.eval(`document.querySelector('${TQ(0)} button[data-tone="0"]').scrollIntoView({block: 'center'})`);
        await page.screenshot(`${OUT}/phone-panel.png`);
        await page.tap(`${TQ(0)} button[data-tone="0"]`);
        await page.waitFor(`document.querySelector('.view').classList.contains('toning') && !document.body.classList.contains('sheet-up')`, {what: 'toning, sheet down'});
        await sleep(600);
        const m = await page.eval(`({pv: document.querySelector('#pv').getBoundingClientRect().height, panel: document.querySelector('.panel').getBoundingClientRect().height, bar: document.querySelector('#tonebar').getBoundingClientRect().height, hidden: document.querySelector('#tonebar').hidden})`);
        assert(m.pv > 400, 'photo ' + m.pv); assert(m.panel <= 50, 'panel ' + m.panel); assert(!m.hidden && m.bar > 0, 'tonebar ' + JSON.stringify(m));
        await page.screenshot(`${OUT}/phone-toning.png`);
      });

      await c('phone: tap picks a band; + twice +0.2, - once +0.1; touch drag up 40 px +0.4; second finger stops it; no page swipe', async () => {
        const b = P1.band, p = await at(P1.fx, P1.fy), url0 = await page.eval('location.pathname');
        await page.waitFor(`window.__masks.length > 0`, {what: 'the mask'});
        for (let i = 0; i < 20 && !/EV/.test(await page.eval(`document.querySelector('#tone-band').textContent`)); i++) { await touch('touchStart', [p]); await touch('touchEnd', []); await sleep(250); }
        assert(/EV/.test(await page.eval(`document.querySelector('#tone-band').textContent`)), 'tone-band: ' + await page.eval(`document.querySelector('#tone-band').textContent`));
        const v0 = await slv(b);
        await page.tap('#tone-up'); await page.tap('#tone-up'); near(await slv(b), v0 + 0.2, 0.01, 'after + +');
        await page.tap('#tone-down'); near(await slv(b), v0 + 0.1, 0.01, 'after -');
        near(await settle('toneequal', 0, b, v0 + 0.1), v0 + 0.1, 0.011, 'engine');
        const v1 = await slv(b); await drag(p, -40); near(await slv(b), v1 + 0.4, 0.08, 'touch drag up 40');
        // second finger mid-drag: nothing more is sent
        const a = {x: p.x, y: p.y}, v2 = await slv(b);
        await touch('touchStart', [a]); await touch('touchMove', [{x: a.x, y: a.y - 20}]);
        const second = {x: a.x + 80, y: a.y};
        await touch('touchStart', [{x: a.x, y: a.y - 20}, second]); await sleep(1500);
        const n = await nSets();
        await touch('touchMove', [{x: a.x, y: a.y - 80}, second]); await touch('touchMove', [{x: a.x, y: a.y - 120}, second]);
        await sleep(1500); await touch('touchEnd', []);
        assert((await nSets()) === n, `${(await nSets()) - n} /set after the second finger`);
        assert(Math.abs(await slv(b) - v2) < 0.3, `moved past the second finger: ${v2} -> ${await slv(b)}`);
        assert(await page.eval('location.pathname') === url0, 'page swiped to ' + await page.eval('location.pathname'));
      });

      await c('phone: done hides the tonebar, the sheet comes back, .toning gone', async () => {
        await page.tap('#tone-done');
        await page.waitFor(`!document.querySelector('.view').classList.contains('toning') && document.body.classList.contains('sheet-up') && document.querySelector('#tonebar').hidden`, {what: 'toning left, sheet up, bar hidden'});
      });
    }

    await c('no js errors, no failed loads', async () => {
      assert(!page.errors.length, page.errors.join('; '));
      const bad = page.failedLoads.filter((l) => !/favicon\.ico/.test(l.url) && !/\/dust\/find/.test(l.url));   // key d starts the dust finder, which the scratch engine answers 502
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
console.log(bad.length ? `toneband: ${results.length - bad.length}/${results.length} passed, ${bad.length} failed` : `toneband: ${results.length}/${results.length} passed (${URL_}, photo ${PHOTO})`);
process.exit(bad.length ? 1 : 0);
