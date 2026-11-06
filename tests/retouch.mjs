#!/usr/bin/env node
// Retouch tool (W69) over CDP: heal, clone, blur and fill spots drawn on the
// photo (mouse drags; touch on the phone): circle, ellipse, path and brush
// shapes, source handle, moving, resizing, deleting, the wavelet scales, and
// whether the rendered pixels line up with the overlay. Scratch web app only
// (:8030), never :8010; the edit is discarded at the start and the end of each
// mode (never saved).
//
//   node tests/retouch.mjs [--url http://127.0.0.1:8030] [--photo 161]
//                          [--only desktop|phone] [--out /tmp/w69] [--brief]

import {mkdirSync} from 'node:fs';
import {startChrome, openPage} from './cdp.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i < 0 ? dflt : args[i + 1]; };
const URL_ = opt('url', 'http://127.0.0.1:8030').replace(/\/$/, '');
const PORT = +opt('port', 9333);
const PHOTO = opt('photo', '161');
const OUT = opt('out', '/tmp/w69');
const ONLY = opt('only', null);
const BRIEF = args.includes('--brief');
if (/:8010\b/.test(URL_) && !args.includes('--force')) {
  console.error('retouch: refusing :8010 (the real library); use a scratch web app'); process.exit(2);
}
mkdirSync(OUT, {recursive: true});

const results = [];
const log = (s) => { if (!BRIEF) console.log(s); };
const assert = (c, m) => { if (!c) throw new Error(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const API = `${URL_}/api/photo/${PHOTO}`;
const getRt = () => fetch(`${API}/retouch`).then((r) => r.json());
const post = (path, body) => fetch(`${API}/${path}`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
const discard = () => post('open?fresh=true', {});
// the photo's saved edit may hold spots; take them out of the open edit (in memory, never saved)
async function clearSpots() {
  const d = await getRt();
  if (d.spots.length) await post('retouch/remove', {formids: d.spots.map((s) => s.formid)});
}
const rendered = `(() => { const i = document.querySelector('#pv'); return i && i.src.startsWith('blob:') && i.complete && i.naturalWidth > 0; })()`;
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const fmt = (p) => p && p.map((v) => +v.toFixed(3));
const bbox = (o) => { const xs = o.map((p) => p[0]), ys = o.map((p) => p[1]); return {l: Math.min(...xs), r: Math.max(...xs), t: Math.min(...ys), b: Math.max(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys)}; };
const centroid = (o) => [o.reduce((a, p) => a + p[0], 0) / o.length, o.reduce((a, p) => a + p[1], 0) / o.length];

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
// a straight drag in a few steps
const line = (a, b, n = 6) => Array.from({length: n + 1}, (_, i) => [a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n]);
const poly = (cx, cy, rx, ry, n = 8) => Array.from({length: n + 1}, (_, i) => [cx + rx * Math.cos(i * 2 * Math.PI / n), cy + ry * Math.sin(i * 2 * Math.PI / n)]);
// no request in flight (the status says "…" while one is), the preview drawn
const idle = (page) => page.waitFor(`!/…$/.test(document.querySelector('#rt-status').textContent) && ${rendered}`, {timeout: 60000, what: 'the edit done and rendered'});
// poll GET retouch until pred(d) holds; returns d
async function until(pred, what, timeout = 30000) {
  const end = Date.now() + timeout; let d;
  for (;;) {
    d = await getRt();
    if (pred(d)) return d;
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}; spots: ${JSON.stringify(d.spots.map((s) => ({...s, outline: undefined, anchor: undefined})))}`);
    await sleep(150);
  }
}
const setVal = (page, sel, v) => page.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('change', {bubbles: true})); })()`);
const selShown = (page) => page.eval("!document.querySelector('#rt-sel').hidden");
// deselect: a click on empty photo with a shape kind that adds nothing from a click
async function deselect(page) {
  if (!await selShown(page)) return;
  await page.click('[data-rtkind=ellipse]');
  await drag(page, [[0.93, 0.07]]);
  await page.waitFor("document.querySelector('#rt-sel').hidden", {what: 'the spot deselected'});
}
const lastSpot = (d) => d.spots[d.spots.length - 1];
// poll until a spot not in `before` (a list of formids) is there; returns [spot, d]
async function newSpot(before, what) {
  const d = await until((x) => x.spots.some((q) => !before.includes(q.formid)), what);
  return [d.spots.find((q) => !before.includes(q.formid)), d];
}
const ids = async () => (await getRt()).spots.map((q) => q.formid);
// the colour of the shown photo at a fraction, through a canvas
const pixelAt = (page, pts) => page.eval(`(async () => {
  const i = document.querySelector('#pv'), c = document.createElement('canvas');
  c.width = i.naturalWidth; c.height = i.naturalHeight; const g = c.getContext('2d'); g.drawImage(i, 0, 0);
  return ${JSON.stringify(pts)}.map(([x, y]) => { const d = g.getImageData(Math.round(x * (c.width - 1)), Math.round(y * (c.height - 1)), 1, 1).data; return [d[0], d[1], d[2]]; });
})()`);
const key = async (page, k, code, vk) => {
  await page.send('Input.dispatchKeyEvent', {type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, text: k.length === 1 ? k : undefined});
  await page.send('Input.dispatchKeyEvent', {type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk});
  await sleep(250);
};

async function openTool(page) {
  if (await page.eval("document.querySelector('#toolbar-retouch').hidden")) await page.click('#tool-retouch');
  await page.waitFor("!document.querySelector('#toolbar-retouch').hidden", {what: 'the retouch bar'});
  await page.waitFor("!/…$/.test(document.querySelector('#rt-status').textContent) && document.querySelector('#rt-status').textContent.length > 0", {what: 'the status'});
}
async function loadPhoto(page) {
  await page.goto(`${URL_}/photo/${PHOTO}`);
  await page.waitFor(rendered, {timeout: 60000, what: 'the first render'});
  await page.waitFor("document.querySelectorAll('.field input[type=range]').length", {what: 'module sliders'});
}

async function run(mode, port) {
  const page = await openPage(port);
  const c = (n, f) => check(mode, page, n, f);
  const phone = mode === 'phone';
  // a reload with unsaved changes asks "leave the page?": say yes
  page.on('Page.javascriptDialogOpening', () => { page.send('Page.handleJavaScriptDialog', {accept: true}).catch(() => {}); });
  try {
    if (phone) await page.phone(); else await page.desktop();
    await discard();
    await clearSpots();
    await page.eval("try { localStorage.removeItem('dr:rttool'); localStorage.removeItem('dr:rtkind'); localStorage.removeItem('dr:rtsize'); } catch (e) {}").catch(() => {});

    if (!await c('1 tool opens (and closes the dust tool)', async () => {
      await loadPhoto(page);
      assert(!await page.eval("document.querySelector('#tool-retouch').disabled"), 'retouch button disabled');
      let note = 'dust not tried';
      if (!await page.eval("document.querySelector('#tool-dust').disabled")) {
        await page.click('#tool-dust');
        await page.waitFor("!document.querySelector('#toolbar-dust').hidden", {what: 'the dust bar'});
        await page.click('#tool-retouch');
        await page.waitFor("!document.querySelector('#toolbar-retouch').hidden", {what: 'the retouch bar'});
        assert(await page.eval("document.querySelector('#toolbar-dust').hidden"), 'dust bar still shown');
        assert(await page.eval("document.querySelector('#tool-dust').getAttribute('aria-pressed')") === 'false', 'dust still pressed');
        note = 'dust closed';
      } else await page.click('#tool-retouch');
      await openTool(page);
      assert(await page.eval("document.querySelector('#tool-retouch').getAttribute('aria-pressed')") === 'true', 'not pressed');
      assert(!page.errors.length, page.errors.join('; '));
      assert((await getRt()).spots.length === 0, 'the photo starts with spots');
      return note;
    })) return;

    let sp, src0;
    await c('2 heal circle', async () => {
      await page.click('[data-rttool=heal]');
      await page.click('[data-rtkind=circle]');
      await drag(page, [[0.3, 0.4]]);
      const d = await until((x) => x.spots.length === 1, 'one spot');
      await idle(page);
      sp = d.spots[0];
      assert(sp.type === 'circle' && sp.tool === 'heal', `type/tool ${sp.type}/${sp.tool}`);
      assert(near(sp.anchor[0], 0.3, 0.01) && near(sp.anchor[1], 0.4, 0.01), 'anchor ' + fmt(sp.anchor));
      assert(sp.source && (Math.abs(sp.source[0] - sp.anchor[0]) > 0.005 || Math.abs(sp.source[1] - sp.anchor[1]) > 0.005), 'source ' + JSON.stringify(sp.source));
      assert(await selShown(page), '#rt-sel hidden');
      src0 = sp.source;
      return `anchor ${fmt(sp.anchor)}, source ${fmt(sp.source)}`;
    });
    await c('3 outline overlay', async () => {
      await page.waitFor("document.querySelector('.photo-ov polygon.rt-spot') && document.querySelector('.photo-ov circle.mark-handle')", {what: 'polygon.rt-spot and circle.mark-handle'});
    });
    await c('4 drag the source', async () => {
      await drag(page, line(src0, [0.6, 0.6]));
      const d = await until((x) => x.spots[0] && near(x.spots[0].source[0], 0.6, 0.02) && near(x.spots[0].source[1], 0.6, 0.02), 'source at (0.6,0.6)');
      assert(near(d.spots[0].anchor[0], sp.anchor[0], 0.002) && near(d.spots[0].anchor[1], sp.anchor[1], 0.002), 'anchor moved to ' + fmt(d.spots[0].anchor));
      sp = d.spots[0];
      await idle(page);
      return `source ${fmt(sp.source)}`;
    });
    await c('5 move the spot', async () => {
      const a = sp.anchor, s = sp.source;
      await drag(page, line(a, [a[0] + 0.1, a[1] + 0.05]));
      const d = await until((x) => x.spots[0] && near(x.spots[0].anchor[0], a[0] + 0.1, 0.015) && near(x.spots[0].anchor[1], a[1] + 0.05, 0.015), 'anchor moved by (0.1,0.05)');
      const n = d.spots[0];
      assert(near(n.source[0] - s[0], 0.1, 0.02) && near(n.source[1] - s[1], 0.05, 0.02), `source moved by ${fmt([n.source[0] - s[0], n.source[1] - s[1]])}`);
      sp = n;
      await idle(page);
      return `anchor ${fmt(n.anchor)}, source ${fmt(n.source)}`;
    });
    await c('6 bigger (+) grows the outline by 1.25', async () => {
      const w0 = bbox(sp.outline).w;
      await page.click('#rt-bigger');
      const d = await until((x) => x.spots[0] && bbox(x.spots[0].outline).w > w0 * 1.05, 'a bigger outline');
      const k = bbox(d.spots[0].outline).w / w0;
      assert(k > 1.15 && k < 1.35, 'ratio ' + k.toFixed(3));
      sp = d.spots[0];
      await idle(page);
      return 'ratio ' + k.toFixed(3);
    });
    await c('7 clone: tool changes, blur/fill disabled', async () => {
      await page.click('[data-rttool=clone]');
      await until((x) => x.spots[0] && x.spots[0].tool === 'clone', 'tool clone');
      await idle(page);
      const dis = await page.eval("['blur','fill'].map((t) => document.querySelector('[data-rttool=' + t + ']').disabled)");
      assert(dis[0] && dis[1], 'blur/fill disabled: ' + dis);
      if (!phone) await page.screenshot(`${OUT}/desktop-spots.png`);
    });
    await c('8 delete', async () => {
      await page.click('#rt-delete');
      await until((x) => x.spots.length === 0, 'no spots');
      await page.waitFor("document.querySelector('#rt-sel').hidden", {what: '#rt-sel hidden'});
      await idle(page);
    });
    await c('9 ellipse clone', async () => {
      await page.click('[data-rttool=clone]');
      await page.click('[data-rtkind=ellipse]');
      await drag(page, line([0.2, 0.2], [0.35, 0.3]));
      const d = await until((x) => x.spots.length === 1, 'one ellipse');
      await idle(page);
      const s = d.spots[0], b = bbox(s.outline);
      assert(s.type === 'ellipse' && s.tool === 'clone' && s.source, `type/tool/source ${s.type}/${s.tool}/${JSON.stringify(s.source)}`);
      assert(near(b.l, 0.2, 0.02) && near(b.r, 0.35, 0.02) && near(b.t, 0.2, 0.02) && near(b.b, 0.3, 0.02), `bbox l${b.l.toFixed(3)} r${b.r.toFixed(3)} t${b.t.toFixed(3)} b${b.b.toFixed(3)}`);
      return `bbox ${fmt([b.l, b.t, b.r, b.b])}`;
    });
    let pathId;
    await c('10 path blur, bilateral radius 25 then 40', async () => {
      await deselect(page);
      await page.click('[data-rttool=blur]');
      await page.click('[data-rtkind=path]');
      await setVal(page, '#rt-blur-radius', '25');
      await setVal(page, '#rt-blur-type', 'bilateral');
      const before = await ids();
      await drag(page, poly(0.7, 0.3, 0.06, 0.08, 8));
      const [s] = await newSpot(before, 'the path spot');
      await idle(page);
      pathId = s.formid;
      assert(s.type === 'path' && s.tool === 'blur', `type/tool ${s.type}/${s.tool}`);
      assert(s.blur_type === 'bilateral' && near(s.blur_radius, 25, 0.5), `blur ${s.blur_type} ${s.blur_radius}`);
      assert(s.source == null, 'source ' + JSON.stringify(s.source));
      assert(await selShown(page), 'path not selected');
      await setVal(page, '#rt-blur-radius', '40');
      const e = await until((x) => x.spots.find((q) => q.formid === pathId && near(q.blur_radius, 40, 0.5)), 'radius 40');
      await idle(page);
      return `radius ${e.spots.find((q) => q.formid === pathId).blur_radius}`;
    });
    let brushId;
    await c('11 brush fill (color)', async () => {
      await deselect(page);
      await page.click('[data-rttool=fill]');
      await page.click('[data-rtkind=brush]');
      await setVal(page, '#rt-fill-mode', 'color');
      const before = await ids();
      await drag(page, line([0.15, 0.75], [0.45, 0.8], 8));
      const [s] = await newSpot(before, 'the brush spot');
      await idle(page);
      const b = bbox(s.outline);
      brushId = s.formid;
      assert(s.type === 'brush' && s.tool === 'fill' && s.fill_mode === 'color', `type/tool/mode ${s.type}/${s.tool}/${s.fill_mode}`);
      assert(b.h > 0.05 + 0.005, 'outline height ' + b.h.toFixed(3) + ' not larger than the line (0.05)');
      return `outline height ${b.h.toFixed(3)}`;
    });
    await c('12 move the path', async () => {
      const d0 = await getRt(), s0 = d0.spots.find((q) => q.formid === pathId), c0 = centroid(s0.outline);
      await drag(page, line(c0, [c0[0] + 0.05, c0[1]]));
      const d = await until((x) => { const q = x.spots.find((z) => z.formid === pathId); return q && near(centroid(q.outline)[0], c0[0] + 0.05, 0.015); }, 'the path moved by 0.05');
      const c1 = centroid(d.spots.find((q) => q.formid === pathId).outline);
      assert(near(c1[1], c0[1], 0.015), 'y moved by ' + (c1[1] - c0[1]).toFixed(3));
      await idle(page);
      return `moved ${fmt([c1[0] - c0[0], c1[1] - c0[1]])}`;
    });

    await c('13 pixels line up with the overlay (red fill)', async () => {
      await discard();
      await clearSpots();
      await loadPhoto(page);
      await openTool(page);
      await deselect(page);
      const pts = [[0.5, 0.5], [0.58, 0.5], [0.42, 0.5]];
      const before = await pixelAt(page, pts), src = await page.eval("document.querySelector('#pv').src");
      await page.click('[data-rttool=fill]');
      await page.click('[data-rtkind=circle]');
      await setVal(page, '#rt-fill-mode', 'color');
      await setVal(page, '#rt-fill-color', '#ff0000');
      await setVal(page, '#rt-size', '0.05');
      await drag(page, [[0.5, 0.5]]);
      const d = await until((x) => x.spots.length === 1, 'the red spot');
      assert(d.spots[0].tool === 'fill' && d.spots[0].fill_mode === 'color', JSON.stringify(d.spots[0]));
      await page.waitFor(`document.querySelector('#pv').src !== ${JSON.stringify(src)} && ${rendered}`, {timeout: 60000, what: 'the new preview'});
      let after = await pixelAt(page, pts);
      for (let i = 0; i < 40 && Math.hypot(...after[0].map((v, j) => v - before[0][j])) < 20; i++) { await sleep(250); after = await pixelAt(page, pts); }
      await page.screenshot(`${OUT}/${mode}-fill.png`);
      const dom = (p) => p[0] - Math.max(p[1], p[2]);
      const diff = Math.hypot(...after[0].map((v, i) => v - before[0][i]));
      const note = `centre ${before[0]} -> ${after[0]}, right ${before[1]} -> ${after[1]}, left ${before[2]} -> ${after[2]}`;
      assert(diff > 60 && dom(after[0]) > 60, 'centre not clearly red: ' + note);
      assert(dom(after[1]) < 40 && dom(after[1]) < dom(after[0]) - 40, 'the pixel beside the spot is red too: ' + note);
      return note;
    });

    await c('14 scales: number, current scale, spot scale, merge', async () => {
      await deselect(page);
      await page.click('#rt-scales');
      await page.waitFor("!document.querySelector('#rt-scalebar').hidden", {what: 'the scale bar'});
      await setVal(page, '#rt-num', '4');
      await until((x) => x.num_scales === 4, 'num_scales 4');
      await idle(page);
      await page.waitFor("document.querySelectorAll('#rt-cells button').length === 6", {what: '6 cells'});
      await page.click('#rt-cells button[data-scale="3"]');
      await until((x) => x.curr_scale === 3, 'curr_scale 3');
      await idle(page);
      await page.click('[data-rttool=fill]');   // not heal: a heal click fails without a source (see the report)
      await page.click('[data-rtkind=circle]');
      const before = await ids();
      await drag(page, [[0.8, 0.7]]);
      let [s] = await newSpot(before, 'the scale spot');
      await idle(page);
      assert(s.scale === 3, 'new spot scale ' + s.scale);
      await page.click('#rt-cells button[data-scale="2"]');
      await until((x) => x.spots.find((q) => q.formid === s.formid && q.scale === 2), 'spot scale 2');
      await idle(page);
      await setVal(page, '#rt-merge', '2');
      await until((x) => x.merge_from_scale === 2, 'merge_from_scale 2');
      await idle(page);
      await setVal(page, '#rt-num', '1');
      const d = await until((x) => x.num_scales === 1, 'num_scales 1');
      await idle(page);
      const st = await page.eval("document.querySelector('#rt-status').textContent");
      assert(!/^not done/.test(st), 'status: ' + st);
      return `status "${st}"; merge now ${d.merge_from_scale}`;
    });

    // toolbar screenshot: blur tool chosen, scales open
    await c('toolbar screenshot (blur, scales open)', async () => {
      await deselect(page);
      await page.click('[data-rttool=blur]');
      if (await page.eval("document.querySelector('#rt-scalebar').hidden")) await page.click('#rt-scales');
      await page.waitFor("!document.querySelector('#rt-blur').hidden && !document.querySelector('#rt-scalebar').hidden", {what: 'blur options and scale bar'});
      await sleep(300);
      await page.screenshot(`${OUT}/${mode}-toolbar.png`);
      const h = await page.eval(`(() => { const t = document.querySelector('#toolbar-retouch').getBoundingClientRect(), v = document.querySelector('.view').getBoundingClientRect(); return {bar: Math.round(t.height), view: Math.round(v.height), window: innerHeight}; })()`);
      console.log(`${mode}: #toolbar-retouch ${h.bar}px, .view ${h.view}px of ${h.window}px`);
      if (phone) assert(h.bar <= 170 && h.view >= 330, `the photo gets too little: bar ${h.bar}, view ${h.view}`);
      return `bar ${h.bar}, view ${h.view}`;
    });

    await c('15 leave: ' + (phone ? 'done button' : 'r key, Escape, Escape') + '; overlay empty', async () => {
      if (!phone) {
        await page.eval('document.activeElement && document.activeElement.blur()');
        await key(page, 'r', 'KeyR', 82);
        await page.waitFor("document.querySelector('#toolbar-retouch').hidden", {what: 'r closes the tool'});
        await key(page, 'r', 'KeyR', 82);
        await page.waitFor("!document.querySelector('#toolbar-retouch').hidden", {what: 'r opens the tool'});
        await page.waitFor("document.querySelectorAll('.photo-ov polygon.rt-spot').length > 0", {what: 'spots drawn'});
        await idle(page);
        // select a spot with a click on its center
        const d = await getRt(), o = d.spots[0].outline, ce = centroid(o);
        await drag(page, [ce]);
        await page.waitFor("!document.querySelector('#rt-sel').hidden", {what: 'a spot selected'});
        await page.eval('document.activeElement && document.activeElement.blur()');
        await key(page, 'Escape', 'Escape', 27);
        await page.waitFor("document.querySelector('#rt-sel').hidden", {what: 'Escape deselects'});
        assert(!await page.eval("document.querySelector('#toolbar-retouch').hidden"), 'first Escape left the tool');
        await key(page, 'Escape', 'Escape', 27);
        await page.waitFor("document.querySelector('#toolbar-retouch').hidden", {what: 'second Escape leaves'});
      } else {
        await page.click('#rt-done');
        await page.waitFor("document.querySelector('#toolbar-retouch').hidden", {what: 'done leaves'});
      }
      assert(await page.eval("document.querySelector('#tool-retouch').getAttribute('aria-pressed')") === 'false', 'still pressed');
      const n = await page.eval("document.querySelectorAll('.photo-ov polygon, .photo-ov circle, .photo-ov path').length");
      assert(n === 0, n + ' overlay shapes left');
    });

    await c('16 reload: tool reopens with the spots; no js errors', async () => {
      await loadPhoto(page);
      await openTool(page);
      const d = await getRt();
      await page.waitFor(`document.querySelectorAll('.photo-ov polygon.rt-spot').length === ${d.spots.length}`, {what: `${d.spots.length} spots drawn`});
      assert(!page.errors.length, page.errors.join('; '));
      return `${d.spots.length} spots, scales ${d.num_scales}`;
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
for (const m of ['desktop', 'phone']) { const rs = results.filter((r) => r.mode === m); if (rs.length) console.log(`${m}: ${rs.filter((r) => r.ok).length}/${rs.length}`); }
console.log(bad.length ? `retouch: ${results.length - bad.length}/${results.length} passed, ${bad.length} failed` : `retouch: ${results.length}/${results.length} passed (${URL_}, photo ${PHOTO})`);
process.exit(bad.length ? 1 : 0);
