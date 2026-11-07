#!/usr/bin/env node
// Perspective from drawn lines in the crop tool (W72) over CDP: the route's refusals, the
// "lines" button and key l, drawing, moving an end and a whole line, deleting, the count text,
// a vertical fit (one POST, ashift changes, lines come back closer to vertical and redrawn),
// shear refused with fit=vertical, leaving and reopening keeps the lines, the crop box inert in
// line mode (done after a fit sends no geometry POST), rectangle mode, and on the phone touch
// drawing, moving an end (22 px tolerance), a fit and the bar inside the screen. Scratch web
// app only (:8030), never :8010; the edit is discarded (never saved).
//
//   (source /tmp/dts-N/env; node tests/persp.mjs [--url http://127.0.0.1:8030]
//     [--port 9333] [--photo 161] [--only desktop|phone] [--out /tmp/w72] [--brief])

import {mkdirSync} from 'node:fs';
import {startChrome, openPage} from './cdp.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i < 0 ? dflt : args[i + 1]; };
const URL_ = opt('url', 'http://127.0.0.1:8030').replace(/\/$/, '');
const PORT = +opt('port', 9333);
const PHOTO = opt('photo', '161');
const OUT = opt('out', '/tmp/w72');
const ONLY = opt('only', null);
const BRIEF = args.includes('--brief');
if (/:8010\b/.test(URL_) && !args.includes('--force')) {
  console.error('persp: refusing :8010 (the real library); use a scratch web app'); process.exit(2);
}
if (!process.env.DTAPI_SOCKET) { console.error('persp: source the scratch engine\'s env first (DTAPI_SOCKET)'); process.exit(2); }
mkdirSync(OUT, {recursive: true});

const results = [];
const log = (s) => { if (!BRIEF) console.log(s); };
const assert = (c, m) => { if (!c) throw new Error(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, tol, what) => assert(Math.abs(a - b) <= tol, `${what}: ${a.toFixed(2)} vs ${b.toFixed(2)} (tolerance ${tol})`);
const API = `${URL_}/api/photo/${PHOTO}`;
const JSONH = {'Content-Type': 'application/json'};
const discard = () => fetch(`${API}/open?fresh=true`, {method: 'POST', headers: JSONH, body: '{}'});
const post = async (body) => { const r = await fetch(`${API}/perspective`, {method: 'POST', headers: JSONH, body: JSON.stringify(body)}); return {status: r.status, json: await r.json().catch(() => ({}))}; };
const ashift = async () => { const j = await (await fetch(`${API}/module?operation=ashift`)).json(); const f = (n) => (j.fields.find((x) => x.name === n) || {}).value; return {enabled: j.enabled, rotation: f('rotation'), v: f('lensshift_v'), h: f('lensshift_h')}; };
const histLen = `document.querySelectorAll('#history li').length`;
const rendered = `(() => { const i = document.querySelector('#pv'); return i && i.src.startsWith('blob:') && i.complete && i.naturalWidth > 0; })()`;
const frameShown = `!document.querySelector('#cropframe').hidden && document.querySelector('#cropframe').getBoundingClientRect().width > 50`;

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
  const fr = () => page.eval(`(() => { const r = document.querySelector('#cropframe').getBoundingClientRect(); return {l: r.left, t: r.top, w: r.width, h: r.height}; })()`);
  const at = async (fx, fy) => { const r = await fr(); return {x: r.l + fx * r.w, y: r.t + fy * r.h}; };
  const said = (re) => page.eval(`window.__stat.some((s) => ${re})`);
  const status = () => page.eval(`document.querySelector('#status').textContent`);
  const count = () => page.eval(`document.querySelector('#persp-n').textContent`);
  // the svg's lines in frame pixels
  const lines = () => page.eval(`[...document.querySelectorAll('#persp-svg line.pl')].map((l) => ({cls: l.getAttribute('class'), x1: +l.getAttribute('x1'), y1: +l.getAttribute('y1'), x2: +l.getAttribute('x2'), y2: +l.getAttribute('y2')}))`);
  const dis = (sel) => page.eval(`document.querySelector('${sel}').disabled`);
  const posts = () => page.eval('window.__posts');
  const mouse = (type, x, y, down) => page.send('Input.dispatchMouseEvent', {type, x, y, button: type === 'mouseMoved' && !down ? 'none' : 'left',
    buttons: type === 'mouseReleased' || (type === 'mouseMoved' && !down) ? 0 : 1, clickCount: type === 'mouseMoved' ? 0 : 1});
  const touch = (type, pts) => page.send('Input.dispatchTouchEvent', {type, touchPoints: pts.map((p, i) => ({x: p.x, y: p.y, id: i}))});
  const key = async (k, code, vk) => { for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', {type, key: k, code, windowsVirtualKeyCode: vk, text: type === 'keyDown' && k.length === 1 ? k : undefined}); };
  // a drag from a to b (mouse or touch), a tap when they are the same point
  const drag = async (a, b, steps = 8) => {
    const P = (i) => ({x: a.x + (b.x - a.x) * i / steps, y: a.y + (b.y - a.y) * i / steps});
    if (phone) { await touch('touchStart', [a]); for (let i = 1; i <= steps; i++) await touch('touchMove', [P(i)]); await touch('touchEnd', []); }
    else { await mouse('mouseMoved', a.x, a.y); await mouse('mousePressed', a.x, a.y); for (let i = 1; i <= steps; i++) await mouse('mouseMoved', P(i).x, P(i).y, true); await mouse('mouseReleased', b.x, b.y); }
  };
  const drawLine = async (f1, f2) => { if (phone) await sleep(700); return drag(await at(...f1), await at(...f2)); };
  const lastPost = async () => { const p = await posts(); return p[p.length - 1]; };
  const openCrop = async () => {
    await page.click('#tool-crop');
    await page.waitFor(frameShown, {timeout: 60000, what: 'the uncropped preview (frame)'});
  };
  const fit = async (what) => {
    const n = (await posts()).length;
    await page.click('#persp-go');
    await page.waitFor(`window.__posts.length > ${n} && window.__posts[${n}].status !== undefined`, {timeout: 60000, what: `the ${what} reply`});
    await page.waitFor(`window.__stat.some((s) => /perspective fit|not applied/.test(s)) || ${n} < 0`, {timeout: 15000, what: 'a status'}).catch(() => {});
    await sleep(300);
    return (await posts())[n];
  };
  const hooks = () => page.eval(`(() => { window.__posts = []; window.__stat = []; new MutationObserver(() => window.__stat.push(document.querySelector('#status').textContent)).observe(document.querySelector('#status'), {childList: true, characterData: true, subtree: true}); const f0 = window.fetch;
    window.fetch = async (u, o) => { u = String(u); let rec = null;
      if (/\\/(perspective|geometry)$/.test(u) && o && o.method === 'POST') { rec = {path: u.split('/').pop(), body: JSON.parse(o.body)}; window.__posts.push(rec); }
      const r = await f0(u, o); if (rec) { rec.status = r.status; rec.reply = await r.clone().json().catch(() => null); } return r; }; })()`);
  let frameStale = null;
  try {
    if (phone) await page.phone(); else await page.desktop();
    page.on('Page.javascriptDialogOpening', () => page.send('Page.handleJavaScriptDialog', {accept: true}));
    if (!await c('page opens and renders', async () => {
      await page.goto(`${URL_}/photo/${PHOTO}`);
      await page.waitFor(rendered, {timeout: 60000, what: 'the first render'});
      await hooks();
    })) return;

    if (!phone) {
      await c('1 route: {} 400, 3-number line 400, one line 4xx with "lines"', async () => {
        assert((await post({})).status === 400, '{} not 400');
        assert((await post({lines: [[0.1, 0.1, 0.2]]})).status === 400, '3-number line not 400');
        const r = await post({lines: [[0.3, 0.2, 0.3, 0.8]]});
        assert(r.status >= 400 && r.status < 500 && /lines/.test(r.json.detail || ''), `${r.status} ${JSON.stringify(r.json)}`);
      });

      await c('2 lines button and key l toggle the bar, the svg, #cropframe.lines', async () => {
        await openCrop();
        assert(!await dis('#persp'), '#persp disabled');
        const st = () => page.eval(`({bar: !document.querySelector('#persp-bar').hidden, svg: getComputedStyle(document.querySelector('#persp-svg')).display !== 'none', cls: document.querySelector('#cropframe').classList.contains('lines')})`);
        await page.click('#persp');
        let s = await st(); assert(s.bar && s.svg && s.cls, 'click: ' + JSON.stringify(s));
        await key('l', 'KeyL', 76); s = await st(); assert(!s.bar && !s.svg && !s.cls, 'l off: ' + JSON.stringify(s));
        await key('l', 'KeyL', 76); s = await st(); assert(s.bar && s.svg && s.cls, 'l on: ' + JSON.stringify(s));
      });

      await c('3 draw, tap, move an end and a line, delete (key and button)', async () => {
        await drawLine([0.3, 0.2], [0.33, 0.8]); await drawLine([0.7, 0.2], [0.67, 0.8]);
        assert(await count() === '2 vertical, 0 horizontal', await count());
        assert(await page.eval(`[...document.querySelectorAll('#persp-svg line.pl')].every((l) => { const r = l.getBoundingClientRect(); return r.width + r.height > 20; })`), 'drawn lines not on screen');
        assert(!await dis('#persp-go'), 'fit disabled with 2 lines');
        const t = await at(0.5, 0.5); await drag(t, t);
        assert((await lines()).length === 2, 'a tap added a line');
        await page.screenshot(`${OUT}/desktop-lines.png`);
        const a = await lines(), e = await at(0.33, 0.8); await drag(e, {x: e.x + 30, y: e.y});
        let b = await lines();
        near(b[0].x2 - a[0].x2, 30, 3, 'dragged end dx'); near(b[0].y2 - a[0].y2, 0, 3, 'dragged end dy');
        near(b[0].x1, a[0].x1, 0.6, 'other end x'); near(b[0].y1, a[0].y1, 0.6, 'other end y');
        const m = await at(0.685, 0.5); await drag(m, {x: m.x + 20, y: m.y});
        const d = await lines();
        for (const k of ['x1', 'x2']) near(d[1][k] - b[1][k], 20, 3, `moved line ${k}`);
        for (const k of ['y1', 'y2']) near(d[1][k], b[1][k], 0.6, `moved line ${k}`);
        await drawLine([0.5, 0.3], [0.5, 0.7]);
        let l = await lines(); assert(l.length === 3 && /sel/.test(l[2].cls), 'third line not selected: ' + JSON.stringify(l.map((x) => x.cls)));
        await key('Delete', 'Delete', 46);
        assert((await lines()).length === 2, 'Delete left ' + (await lines()).length);
        await drawLine([0.1, 0.9], [0.45, 0.91]);
        assert(await count() === '2 vertical, 1 horizontal', await count());
        await drag(t, t); const hm = await at(0.275, 0.905); await drag(hm, hm);
        assert(/sel/.test((await lines())[2].cls) && !await dis('#persp-del'), 'click on the middle did not select');
        await page.click('#persp-del');
        assert(await count() === '2 vertical, 0 horizontal', 'after delete: ' + await count());
      });

      let drawn = null, n0 = 0, statusOk = null;
      await c('4 vertical fit: one POST, "perspective fit", ashift changed, lines closer to vertical and redrawn', async () => {
        drawn = await lines(); n0 = await page.eval(histLen);
        await page.eval(`document.querySelector('#persp-fit').value = 'vertical'`);
        const p = await fit('fit'), np = (await posts()).filter((x) => x.path === 'perspective').length;
        assert(np === 1, `${np} perspective POSTs`);
        assert(p.status === 200, `status ${p.status} ${JSON.stringify(p.reply)}`);
        statusOk = await said('/perspective fit/.test(s)');
        const a = await ashift();
        assert(a.enabled && (Math.abs(a.rotation) > 1e-3 || Math.abs(a.v) > 1e-3), 'ashift ' + JSON.stringify(a));
        const f = await fr(), slope = (x1, y1, x2, y2) => Math.abs((x2 - x1) / (y2 - y1));
        const after = p.reply.lines.map(([x1, y1, x2, y2]) => slope(x1 * f.w, y1 * f.h, x2 * f.w, y2 * f.h));
        const before = drawn.map((l) => slope(l.x1, l.y1, l.x2, l.y2));
        after.forEach((s, i) => assert(s < before[i] && s < 0.01, `line ${i}: |dx/dy| ${before[i].toFixed(4)} -> ${s.toFixed(4)}`));
        const now = await lines(); assert(now.length === 2, 'svg lines ' + now.length);
        now.forEach((l, i) => { const r = p.reply.lines[i]; near(l.x1, r[0] * f.w, 1.5, `svg line ${i} x1`); near(l.y2, r[3] * f.h, 1.5, `svg line ${i} y2`); });
        await page.screenshot(`${OUT}/desktop-fitted.png`);
        return `slopes ${before.map((s) => s.toFixed(3))} -> ${after.map((s) => s.toFixed(4))}`;
      });

      await c('4b the status line says "perspective fit" after the fit', async () => {
        assert(statusOk, 'status never said it; last: ' + JSON.stringify(await page.eval('window.__stat.slice(-4)')));
      });

      await c('5 shear with fit=vertical: "not applied" and "shear", no new history entry', async () => {
        const h0 = await page.eval(histLen);
        await page.eval(`document.querySelector('#persp-shear').click()`);
        await fit('shear');
        assert(await said('/not applied.*shear/.test(s)'), 'status: ' + await status());
        assert(await page.eval(histLen) === h0, `history ${h0} -> ${await page.eval(histLen)}`);
        await page.eval(`document.querySelector('#persp-shear').click()`);
      });

      await c('7 Esc leaves the crop tool and hides the bar and svg; reopening keeps the lines', async () => {
        const k = await lines();
        await key('Escape', 'Escape', 27);
        await page.waitFor(`document.querySelector('#toolbar-crop').hidden`, {what: 'crop tool left'}).catch(() => { throw new Error('Esc did not leave the crop tool'); });
        assert(await page.eval(`document.querySelector('#persp-bar').hidden && getComputedStyle(document.querySelector('#persp-svg')).display === 'none'`), 'bar or svg still shown');
        await openCrop(); await page.click('#persp');
        const l = await lines(); assert(l.length === k.length, `lines ${k.length} -> ${l.length}`);
        l.forEach((x, i) => near(x.x1, k[i].x1, 1.5, `line ${i} x1`));
      });

      await c('8 line mode: #cropbox pointer-events none; done after a fit sends no geometry POST', async () => {
        assert(await page.eval(`getComputedStyle(document.querySelector('#cropbox')).pointerEvents`) === 'none', 'pointer-events');
        await page.click('#crop-apply');
        await page.waitFor(`document.querySelector('#toolbar-crop').hidden`, {what: 'done left the crop tool'});
        await sleep(500);
        const g = (await posts()).filter((x) => x.path === 'geometry');
        assert(!g.length, `${g.length} geometry POSTs: ${JSON.stringify(g[0] && g[0].body)}`);
      });

      await c('6 rectangle: .on, no svg lines, 4 corners, moved corner, fit=both gives a quad; clear', async () => {
        await openCrop(); await page.click('#persp'); await page.click('#persp-quad');
        assert(await page.eval(`document.querySelector('#persp-quad').classList.contains('on')`), 'rectangle button not .on');
        assert((await lines()).length === 0, 'svg lines shown in rectangle mode');
        await drawLine([0.25, 0.25], [0.75, 0.75]);
        const q = () => page.eval(`({poly: document.querySelectorAll('#persp-svg polygon.pq').length, dots: document.querySelectorAll('#persp-svg circle').length, pts: (document.querySelector('#persp-svg polygon.pq') || {getAttribute: () => ''}).getAttribute('points')})`);
        let s = await q(); assert(s.poly === 1 && s.dots === 4 && await count() === 'rectangle', JSON.stringify(s) + await count());
        const corner = await at(0.25, 0.25); await drag(corner, {x: corner.x + 25, y: corner.y});
        const p1 = (await q()).pts.split(' ')[0].split(',').map(Number), f = await fr();
        near(p1[0], 0.25 * f.w + 25, 3, 'moved corner x'); near(p1[1], 0.25 * f.h, 3, 'moved corner y');
        await page.screenshot(`${OUT}/desktop-quad.png`);
        await page.eval(`document.querySelector('#persp-fit').value = 'both'`);
        const p = await fit('quad fit');
        assert(p.status === 200 && await said('/perspective fit/.test(s)'), `${p.status} ${await status()}`);
        assert(p.reply.quad && p.reply.quad.length === 4, 'reply quad: ' + JSON.stringify(p.reply.quad));
        await page.click('#persp-clear');
        assert((await q()).poly === 0 && await dis('#persp-go'), 'clear left a polygon or fit enabled');
      });
    }

    if (phone) {
      await c('9 phone: lines button, touch-draw two lines, move an end (22 px), fit, bar inside the screen', async () => {
        await page.tap('#tool-crop'); await page.waitFor(frameShown, {timeout: 60000, what: 'the frame'});
        await page.tap('#persp'); await page.waitFor(`!document.querySelector('#persp-bar').hidden`, {what: 'bar'});
        // the bar makes the toolbar taller and the view shorter: the frame must follow the photo as shown
        const fits = `(() => { const f = document.querySelector('#cropframe').getBoundingClientRect(), v = document.querySelector('.view').getBoundingClientRect(); return f.height <= v.height + 1; })()`;
        await sleep(1000);
        if (!await page.eval(fits)) { frameStale = JSON.stringify(await fr()) + ' after 1 s'; await page.waitFor(fits, {timeout: 6000, what: 'the frame to shrink'}).catch(() => { frameStale += '; still stale after 7 s (a window resize event fixes it)'; }); if (!await page.eval(fits)) await page.eval(`dispatchEvent(new Event('resize'))`); await sleep(300); }
        log('frame ' + JSON.stringify(await fr()));
        await drawLine([0.3, 0.1], [0.33, 0.9]); await drawLine([0.7, 0.1], [0.67, 0.9]);
        assert(await count() === '2 vertical, 0 horizontal', await count() + JSON.stringify(await lines()) + JSON.stringify(await fr()));
        { const h = await page.eval(`document.querySelector('#pv').getBoundingClientRect().height`); assert(h >= 200, 'photo only ' + h + ' px tall with the lines bar'); }
        assert(await page.eval(`[...document.querySelectorAll('#persp-svg line.pl')].every((l) => { const r = l.getBoundingClientRect(); return r.width + r.height > 20; })`), 'drawn lines not on screen');
        const a = await lines(), e = await at(0.33, 0.9);
        await drag({x: e.x - 12, y: e.y + 8}, {x: e.x + 18, y: e.y + 8});   // 14 px off the end: inside 22
        const b = await lines();
        assert(Math.abs(b[0].x2 - a[0].x2) > 10, 'the end did not move');
        assert(Math.abs(b[0].x1 - a[0].x1) < 0.6, 'the other end moved');
        await page.screenshot(`${OUT}/phone-lines.png`);
        const out = await page.eval(`[...document.querySelectorAll('#persp-bar > *, #persp-bar select, #persp-bar input')].map((x) => [x.id || x.tagName, Math.round(x.getBoundingClientRect().right)]).filter((x) => x[1] > 390)`);
        assert(!out.length, 'beyond 390 px: ' + JSON.stringify(out));
        await page.eval(`document.querySelector('#persp-fit').value = 'vertical'`);
        const p = await fit('phone fit');
        assert(p.status === 200 && await said('/perspective fit/.test(s)'), `${p.status} ${await status()}`);
      });
    }

    if (phone) await c('9a phone: the crop frame follows the photo when the lines bar opens (no stale size)', async () => { assert(!frameStale, frameStale); });
    await c(`10 no js errors, no failed loads (${mode})`, async () => {
      assert(!page.errors.length, page.errors.join('; '));
      const bad = page.failedLoads.filter((l) => !/favicon\.ico/.test(l.url) && !/\/dust\/find/.test(l.url) && !(!phone && /\/perspective$/.test(l.url) && /400/.test(l.text)));   // the shear refusal is a 400 on purpose
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
console.log(bad.length ? `persp: ${results.length - bad.length}/${results.length} passed, ${bad.length} failed` : `persp: ${results.length}/${results.length} passed (${URL_}, photo ${PHOTO})`);
process.exit(bad.length ? 1 : 0);
