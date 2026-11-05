#!/usr/bin/env node
// The curve editor in the pipeline view (W67) over CDP: rgb curve, color zones and tone
// curve get a graph; a click or tap off the points adds one where it lands, a drag moves it
// (mouse or touch), arrow keys nudge it, double-click / double-tap removes it, the spline
// type and reset are sent, independent channels show R/G/B tabs and edit only their own
// curve, color zones by hue wrap (reset gives darktable's two nodes at 0.25 and 0.75). Every
// change is checked against the engine's curve_get (GET /module) and must re-render the
// photo. Scratch web app only (:8030), never :8010; the edit is discarded (never saved).
//
//   (source /tmp/dts-N/env; node tests/curves.mjs [--url http://127.0.0.1:8030]
//     [--photo 409] [--only desktop|phone] [--out /tmp/w67] [--brief])

import {mkdirSync} from 'node:fs';
import {startChrome, openPage} from './cdp.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i < 0 ? dflt : args[i + 1]; };
const URL_ = opt('url', 'http://127.0.0.1:8030').replace(/\/$/, '');
const PORT = +opt('port', 9333);
const PHOTO = opt('photo', '409');
const OUT = opt('out', '/tmp/w67');
const ONLY = opt('only', null);
const BRIEF = args.includes('--brief');
if (/:8010\b/.test(URL_) && !args.includes('--force')) {
  console.error('curves: refusing :8010 (the real library); use a scratch web app'); process.exit(2);
}
if (!process.env.DTAPI_SOCKET) { console.error('curves: source the scratch engine\'s env first (DTAPI_SOCKET)'); process.exit(2); }
mkdirSync(OUT, {recursive: true});

const results = [];
const log = (s) => { if (!BRIEF) console.log(s); };
const assert = (c, m) => { if (!c) throw new Error(m); };
const near = (a, b, eps = 0.03) => Math.abs(a - b) <= eps;
const API = `${URL_}/api/photo/${PHOTO}`;
const post = (p, body) => fetch(`${API}/${p}`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
const discard = () => post('open?fresh=true', {});
const curves = async (op) => (await (await fetch(`${API}/module?operation=${op}&instance=0`)).json());
const rendered = `(() => { const i = document.querySelector('#pv'); return i && i.src.startsWith('blob:') && i.complete && i.naturalWidth > 0; })()`;
const row = (k) => `#pipeline .prow[data-key="${k}"]`;

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
  // rgb curve and color zones in the edit, switched off; tone curve on
  for (const op of ['rgbcurve', 'colorzones', 'tonecurve']) {
    const r = await post('instance', {action: 'add', operation: op});
    assert(r.ok, `add ${op}: ${r.status}`);
  }
  for (const op of ['rgbcurve', 'colorzones']) await post('enable', {operation: op, instance: 0, enabled: false});
  const page = await openPage(port);
  const c = (name, f) => check(mode, page, name, f);
  const touch = mode === 'phone';
  // the graph's point (x, y in 0..1) in CSS pixels; the editor keeps 6 px around the square
  const at = async (k, x, y) => {
    // the point itself scrolled to the middle of its scroller (on the phone the graph is about as tall as the sheet)
    await page.eval(`(() => { const cv = document.querySelector('${row(k)} canvas.curve-graph');
      cv.scrollIntoView({block: 'center'});
      let s = cv.parentElement; while (s && !(s.scrollHeight > s.clientHeight && /auto|scroll/.test(getComputedStyle(s).overflowY))) s = s.parentElement;
      if (s) { const b = cv.getBoundingClientRect(), v = s.getBoundingClientRect();
        s.scrollTo({top: s.scrollTop + (b.top + b.height - 6 - ${y} * (b.height - 12)) - (v.top + v.height / 2), behavior: 'instant'}); } })()`);
    // the phone's sheet resizes as it scrolls: measure once the layout has settled
    await new Promise((res) => setTimeout(res, touch ? 600 : 50));
    const r = await page.eval(`(() => { const r = document.querySelector('${row(k)} canvas.curve-graph').getBoundingClientRect();
      return {l: r.left, t: r.top, w: r.width, h: r.height}; })()`);
    return {x: r.l + 6 + x * (r.w - 12), y: r.t + r.h - 6 - y * (r.h - 12)};
  };
  const press = async (k, x, y) => {
    const p = await at(k, x, y);
    if (touch) await page.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [p]});
    else {
      await page.send('Input.dispatchMouseEvent', {type: 'mouseMoved', ...p});
      await page.send('Input.dispatchMouseEvent', {type: 'mousePressed', ...p, button: 'left', clickCount: 1});
    }
    return p;
  };
  const moveTo = async (k, x, y) => {
    const p = await at(k, x, y);
    if (touch) await page.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [p]});
    else await page.send('Input.dispatchMouseEvent', {type: 'mouseMoved', ...p, button: 'left', buttons: 1});
  };
  const release = async (p) => {
    if (touch) await page.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
    else await page.send('Input.dispatchMouseEvent', {type: 'mouseReleased', ...p, button: 'left', clickCount: 1});
  };
  const tapAt = async (k, x, y) => { await release(await press(k, x, y)); };
  // the engine's points once they match want(points); wait out the queue first
  const settled = async (op, ch, want, what) => {
    let last;
    for (let i = 0; i < 100; i++) {
      const busy = await page.eval(`document.querySelector('#status') && /…|working/.test(document.querySelector('#status').textContent)`);
      const g = await curves(op);
      last = (g.curves || []).find((q) => q.channel === ch);
      if (!busy && last && want(last)) return last;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`${what}: engine has ${JSON.stringify(last)}`);
  };
  const newRender = async (src, what) => page.waitFor(`document.querySelector('#pv').src !== ${JSON.stringify(src)} && ${rendered}`,
    {timeout: 60000, what});
  const pvSrc = () => page.eval("document.querySelector('#pv').src");
  const openModule = async (k) => {
    if (!await page.eval(`!!document.querySelector('${row(k)}.open')`)) await page.click(`${row(k)} .pname`);
    await page.waitFor(`!!document.querySelector('${row(k)} canvas.curve-graph')`, {what: `the ${k} graph`});
  };
  try {
    if (mode === 'phone') await page.phone(); else await page.desktop();
    if (!await c('page opens, pipeline view shows the curve modules', async () => {
      await page.goto(`${URL_}/photo/${PHOTO}`);
      await page.waitFor(rendered, {timeout: 60000, what: 'the first render'});
      await page.click('[data-view=pipeline]');
      await page.waitFor(`!!document.querySelector('${row('rgbcurve:0')}') && !!document.querySelector('${row('colorzones:0')}')`, {what: 'the curve rows'});
    })) return;

    await c('rgb curve: a graph, one RGB tab, 2 points, monotonic', async () => {
      await openModule('rgbcurve:0');
      const s = await page.eval(`(() => { const b = document.querySelector('${row('rgbcurve:0')} .curve');
        return {tabs: [...b.querySelectorAll('.curve-tabs button')].map((x) => x.textContent), hidden: b.querySelector('.curve-tabs').hidden,
                type: b.querySelector('.curve-bar select').value, read: b.querySelector('.curve-read').textContent}; })()`);
      assert(s.hidden && s.tabs.join() === 'RGB', 'tabs: ' + JSON.stringify(s));
      assert(s.type === 'monotonic spline' && /2 points/.test(s.read), JSON.stringify(s));
      await page.screenshot(`${OUT}/${mode}-rgbcurve.png`);
    });

    await c('click off the points adds one there; module switched on; new render', async () => {
      const src = await pvSrc();
      await tapAt('rgbcurve:0', 0.5, 0.7);
      const q = await settled('rgbcurve', 'R', (q) => q.points.length === 3, 'a third point');
      assert(near(q.points[1][0], 0.5) && near(q.points[1][1], 0.7), JSON.stringify(q.points));
      await newRender(src, 'a render after the point');
      assert(await page.eval(`document.querySelector('${row('rgbcurve:0')} .phead input[type=checkbox]').checked`), 'row not ticked');
      assert((await curves('rgbcurve')).enabled, 'engine: rgbcurve still off');
    });

    await c(`${touch ? 'touch' : 'mouse'} drag moves the point`, async () => {
      const p = await press('rgbcurve:0', 0.5, 0.7);
      for (const y of [0.6, 0.5, 0.4]) await moveTo('rgbcurve:0', 0.45, y);
      await release(p);
      const q = await settled('rgbcurve', 'R', (q) => q.points.length === 3 && near(q.points[1][1], 0.4), 'the point dragged to 0.4');
      assert(near(q.points[1][0], 0.45), JSON.stringify(q.points));
      await page.screenshot(`${OUT}/${mode}-dragged.png`);
    });

    if (!touch) await c('arrow up nudges the selected point 0.005, Shift ×10', async () => {
      const y0 = (await curves('rgbcurve')).curves[0].points[1][1];
      await page.eval(`document.querySelector('${row('rgbcurve:0')} canvas.curve-graph').focus()`);
      await page.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, modifiers: 8});
      await page.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, modifiers: 8});
      await settled('rgbcurve', 'R', (q) => near(q.points[1][1], y0 + 0.05, 0.002), 'the point 0.05 higher');
    });

    await c('spline type: cubic sent', async () => {
      await page.eval(`(() => { const s = document.querySelector('${row('rgbcurve:0')} .curve-bar select'); s.value = 'cubic spline';
        s.dispatchEvent(new Event('change', {bubbles: true})); })()`);
      await settled('rgbcurve', 'R', (q) => q.type === 'cubic spline' && q.points.length === 3, 'cubic spline');
    });

    await c(`${touch ? 'double-tap' : 'double-click'} removes the point`, async () => {
      const q = (await curves('rgbcurve')).curves[0].points[1];
      if (touch) {
        // both taps at one measured spot: at()'s settling wait is longer than the double-tap's 350 ms
        const p = await at('rgbcurve:0', q[0], q[1]);
        for (const n of [1, 2]) {
          await page.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [p]});
          await page.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
        }
      }
      else {
        const p = await at('rgbcurve:0', q[0], q[1]);
        for (const n of [1, 2]) {
          await page.send('Input.dispatchMouseEvent', {type: 'mousePressed', ...p, button: 'left', clickCount: n});
          await page.send('Input.dispatchMouseEvent', {type: 'mouseReleased', ...p, button: 'left', clickCount: n});
        }
      }
      await settled('rgbcurve', 'R', (q) => q.points.length === 2, 'two points again');
    });

    await c('independent channels: R, G, B tabs; a point on G leaves R alone', async () => {
      const r0 = JSON.stringify((await curves('rgbcurve')).curves[0].points);
      await page.eval(`(() => { const s = document.querySelector('${row('rgbcurve:0')} .field[data-field=curve_autoscale] select');
        s.value = 'DT_S_SCALE_MANUAL_RGB'; s.dispatchEvent(new Event('change', {bubbles: true})); })()`);
      await page.waitFor(`[...document.querySelectorAll('${row('rgbcurve:0')} .curve-tabs button')].map((x) => x.textContent).join() === 'R,G,B'`, {what: 'R, G, B tabs'});
      await page.click(`${row('rgbcurve:0')} .curve-tabs button[data-ch=G]`);
      await page.waitFor(`document.querySelector('${row('rgbcurve:0')} .curve').dataset.ch === 'G'`, {what: 'tab G'});
      await tapAt('rgbcurve:0', 0.3, 0.4);
      await settled('rgbcurve', 'G', (q) => q.points.length === 3 && near(q.points[1][1], 0.4), 'a point on G');
      assert(JSON.stringify((await curves('rgbcurve')).curves[0].points) === r0, 'R changed');
      await page.screenshot(`${OUT}/${mode}-green.png`);
    });

    await c('reset puts G back to the diagonal', async () => {
      await page.click(`${row('rgbcurve:0')} .curve-bar button:nth-of-type(2)`);
      await settled('rgbcurve', 'G', (q) => q.points.length === 2 && q.points[0][1] === 0 && q.points[1][1] === 1, 'G reset');
    });

    await c('color zones by hue: lightness/chroma/hue tabs, wraps; a point, then reset to 0.25/0.75', async () => {
      await openModule('colorzones:0');
      const s = await page.eval(`(() => { const b = document.querySelector('${row('colorzones:0')} .curve');
        return {tabs: [...b.querySelectorAll('.curve-tabs button')].map((x) => x.textContent).join(), by: b.querySelector('.curve-tabs .dim').textContent}; })()`);
      assert(s.tabs === 'lightness,chroma,hue' && /wraps/.test(s.by), JSON.stringify(s));
      await page.click(`${row('colorzones:0')} .curve-tabs button[data-ch=chroma]`);
      await tapAt('colorzones:0', 0.5, 0.8);
      await settled('colorzones', 'chroma', (q) => q.points.length === 3 && near(q.points[1][1], 0.8), 'a chroma point');
      await page.screenshot(`${OUT}/${mode}-colorzones.png`);
      await page.click(`${row('colorzones:0')} .curve-bar button:nth-of-type(2)`);
      await settled('colorzones', 'chroma', (q) => JSON.stringify(q.points) === '[[0.25,0.5],[0.75,0.5]]', 'chroma reset');
    });

    await c('tone curve: one L tab (linked channels)', async () => {
      await openModule('tonecurve:0');
      const t = await page.eval(`[...document.querySelectorAll('${row('tonecurve:0')} .curve-tabs button')].map((x) => x.textContent).join()`);
      assert(t === 'L', 'tabs: ' + t);
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
console.log(bad.length ? `curves: ${results.length - bad.length}/${results.length} passed, ${bad.length} failed` : `curves: ${results.length}/${results.length} passed (${URL_}, photo ${PHOTO})`);
process.exit(bad.length ? 1 : 0);
