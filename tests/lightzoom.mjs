#!/usr/bin/env node
// The wide lighttable's preview over CDP (#155): a click toggles 100% at the clicked point,
// a drag pans or does nothing, double-click opens the photo, full screen moved to the ⛶
// button and `f`; a finger's tap and the narrow layout still open full screen.
// Scratch web app only (:8030), never :8010; it changes nothing in the library.
//
//   (source /tmp/dts-N/env; node tests/lightzoom.mjs [--url http://127.0.0.1:8030]
//     [--port 9333] [--photo 409] [--other 472] [--out /tmp/155] [--brief])

import {mkdirSync} from 'node:fs';
import {startChrome, openPage} from './cdp.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i < 0 ? dflt : args[i + 1]; };
const URL_ = opt('url', 'http://127.0.0.1:8030').replace(/\/$/, '');
const PORT = +opt('port', 9333);
const PHOTO = opt('photo', '409');
const OTHER = opt('other', '472');
const OUT = opt('out', '/tmp/155');
const BRIEF = args.includes('--brief');
if (/:8010\b/.test(URL_) && !args.includes('--force')) {
  console.error('lightzoom: refusing :8010 (the real library); use a scratch web app'); process.exit(2);
}
mkdirSync(OUT, {recursive: true});

const results = [];
const log = (s) => { if (!BRIEF) console.log(s); };
const assert = (c, m) => { if (!c) throw new Error(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SETTLE = 450;      // past the 250 ms wait for a double-click

const chrome = await startChrome({port: PORT});
const page = await openPage(chrome.port);

async function c(name, f) {
  try {
    await f();
    results.push({name, ok: true}); log(`ok   ${name}`);
  } catch (e) {
    const shot = `${OUT}/${name.split(' ')[0]}.png`;
    await page.screenshot(shot).catch(() => {});
    results.push({name, ok: false, why: e.message, shot}); log(`FAIL ${name}: ${e.message}`);
  }
}

const tile = (id) => `figure.tile[data-id="${id}"] a`;
const mouse = (type, x, y, extra = {}) => page.send('Input.dispatchMouseEvent', {type, x, y, button: 'left', ...extra});
async function press(x, y, clickCount = 1) {
  await mouse('mouseMoved', x, y, {button: 'none'});
  await mouse('mousePressed', x, y, {clickCount, buttons: 1});
  await mouse('mouseReleased', x, y, {clickCount});
}
async function drag(x, y, dx, dy) {
  await mouse('mouseMoved', x, y, {button: 'none'});
  await mouse('mousePressed', x, y, {clickCount: 1, buttons: 1});
  for (let i = 1; i <= 5; i++) await mouse('mouseMoved', x + dx * i / 5, y + dy * i / 5, {buttons: 1});
  await mouse('mouseReleased', x + dx, y + dy, {clickCount: 1});
}
async function key(k) {
  const code = k.length > 1 ? k : 'Key' + k.toUpperCase();
  await page.send('Input.dispatchKeyEvent', {type: 'keyDown', key: k, code, ...(k.length > 1 ? {} : {text: k})});
  await page.send('Input.dispatchKeyEvent', {type: 'keyUp', key: k, code});
}
const view = () => page.eval(`(() => {
  const m = document.querySelector('.detail-pv .dz-layer').style.transform.match(/translate\\((.+?)px, (.+?)px\\) scale\\((.+?)\\)/);
  return m ? {tx: +m[1], ty: +m[2], s: +m[3]} : {tx: 0, ty: 0, s: 1};
})()`);
const box = () => page.eval(`(() => { const r = document.querySelector('.detail-pv').getBoundingClientRect(); return {l: r.left, t: r.top, w: r.width, h: r.height}; })()`);
const fullOpen = () => page.eval('dtFull.isOpen');
const onBtn = () => page.eval(`[...document.querySelectorAll('.detail-pv .dz-bar [data-z].on')].map((b) => b.dataset.z).join()`);
const zoomed = () => page.eval(`document.querySelector('.detail-pv').classList.contains('zoomed')`);
const onPhoto = () => page.eval(`location.pathname.startsWith('/photo/')`);

// the library page with this photo in the preview, fitted
async function ready(id = PHOTO) {
  await page.goto(URL_ + '/');
  await page.waitFor(`document.querySelector(${JSON.stringify(tile(id))})`, {what: 'tile'});
  await page.click(tile(id));
  await page.waitFor(`(() => { const i = document.querySelector('.detail-pv .dz-layer img'); return i && i.naturalWidth > 0 && i.style.width; })()`, {what: 'preview'});
  await sleep(400);    // the box's resize and the larger render reset the zoom
}
async function point() { const b = await box(); return {x: b.l + b.w * 0.6, y: b.t + b.h * 0.55, b}; }

async function main() {
  await page.desktop({width: 1700, height: 950});
  await ready();

  await c('01 the bar ends with clip and the full screen button', async () => {
    const t = await page.eval(`[...document.querySelectorAll('.detail-pv .dz-bar button')].map((b) => b.textContent).join('|')`);
    assert(t === 'fit|100%|200%|clip|⛶', t);
    assert(await page.eval(`getComputedStyle(document.querySelector('.detail-pv')).cursor`) === 'zoom-in', 'cursor');
  });
  await c('02 a click zooms to 100% at the clicked point', async () => {
    const {x, y, b} = await point();
    const before = await view();
    assert(before.s === 1, 'not fitted: ' + JSON.stringify(before));
    await press(x, y);
    await sleep(100);
    assert(!await zoomed(), 'zoomed before the double-click wait ended');
    await sleep(SETTLE);
    const v = await view();
    assert(await zoomed() && await onBtn() === '1', `zoomed ${await zoomed()} on ${await onBtn()}`);
    assert(!await fullOpen(), 'full screen opened');
    assert(!await onPhoto(), 'left the library page');
    const px = x - b.l, py = y - b.t;
    assert(Math.abs((px - v.tx) / v.s - px) < 2 && Math.abs((py - v.ty) / v.s - py) < 2, `point moved: ${JSON.stringify(v)} at ${px},${py}`);
  });
  await c('03 the point holds once the engine reports the size', async () => {
    const {x, y, b} = await point();
    await sleep(2500);                  // the sharp render's size correction
    const v = await view();
    const px = x - b.l, py = y - b.t;
    assert(Math.abs((px - v.tx) / v.s - px) < 2 && Math.abs((py - v.ty) / v.s - py) < 2, `point moved: ${JSON.stringify(v)}`);
    assert(await onBtn() === '1', 'on: ' + await onBtn());
  });
  await c('04 a drag while zoomed pans and stays zoomed', async () => {
    const {x, y} = await point();
    const a = await view();
    await drag(x, y, -60, -40);
    await sleep(SETTLE);
    const v = await view();
    assert(await zoomed(), 'zoomed out');
    assert(v.s === a.s && (v.tx !== a.tx || v.ty !== a.ty), `${JSON.stringify(a)} -> ${JSON.stringify(v)}`);
    assert(!await fullOpen(), 'full screen opened');
  });
  await c('05 a click while zoomed goes back to fit', async () => {
    const {x, y} = await point();
    await press(x, y);
    await sleep(SETTLE);
    const v = await view();
    assert(!await zoomed() && v.s === 1 && await onBtn() === 'fit', JSON.stringify(v));
    assert(!await fullOpen(), 'full screen opened');
  });
  await c('06 a drag at fit does nothing', async () => {
    const {x, y} = await point();
    await drag(x, y, 50, 30);
    await sleep(SETTLE);
    assert(!await zoomed() && !await fullOpen() && !await onPhoto(), 'it reacted');
  });
  await c('07 the bar\'s buttons don\'t count as clicks on the preview', async () => {
    await page.click('.detail-pv .dz-bar [data-z="2"]');
    await sleep(SETTLE);
    assert(await onBtn() === '2', 'on: ' + await onBtn());
    await page.click('.detail-pv .dz-bar [data-z="fit"]');
    await sleep(SETTLE);
    assert(!await zoomed() && await onBtn() === 'fit', 'not fit');
  });
  await c('08 the button opens full screen, the same photo', async () => {
    await page.eval(`void document.querySelector('.detail-pv .dz-bar button:last-child').setAttribute('data-fs', '')`);
    await page.click('[data-fs]');
    await page.waitFor('dtFull.isOpen', {what: 'full screen', timeout: 3000});
    await key('Escape');
    await page.waitFor('!dtFull.isOpen', {what: 'closed', timeout: 3000});
    await sleep(SETTLE);
    assert(!await zoomed(), 'the press zoomed the preview');
  });
  await c('09 f opens full screen', async () => {
    await key('f');
    await page.waitFor('dtFull.isOpen', {what: 'full screen', timeout: 3000});
    await key('Escape');
    await page.waitFor('!dtFull.isOpen', {what: 'closed', timeout: 3000});
  });
  await c('10 a click then another photo doesn\'t zoom the new one', async () => {
    await ready();
    const {x, y} = await point();
    await press(x, y);
    await page.click(tile(OTHER));
    await sleep(SETTLE);
    assert(!await zoomed(), 'the new photo zoomed');
    await page.waitFor(`document.querySelector('figure.tile.current[data-id="${OTHER}"]')`, {what: 'other current', timeout: 3000});
  });
  await c('11 a double-click at fit opens the photo', async () => {
    await ready();
    const {x, y} = await point();
    await press(x, y, 1);
    await press(x, y, 2);
    await page.waitFor(`location.pathname.startsWith('/photo/')`, {what: 'photo page', timeout: 5000});
  });
  await c('12 a slow double-click opens the photo too', async () => {
    await ready();
    const {x, y} = await point();
    await press(x, y, 1);
    await sleep(320);                   // past the wait: the first click has zoomed
    await press(x, y, 2);
    await page.waitFor(`location.pathname.startsWith('/photo/')`, {what: 'photo page', timeout: 5000});
  });
  await c('13 a double-click while zoomed opens the photo', async () => {
    await ready();
    const {x, y} = await point();
    await press(x, y);
    await sleep(SETTLE);
    assert(await zoomed(), 'not zoomed');
    await press(x, y, 1);
    await press(x, y, 2);
    await page.waitFor(`location.pathname.startsWith('/photo/')`, {what: 'photo page', timeout: 5000});
  });
  await c('14 no js errors, wide', async () => { assert(!page.errors.length, page.errors.join('; ')); });

  // a finger on a wide screen can't pan: its tap stays full screen
  await page.send('Emulation.setTouchEmulationEnabled', {enabled: true, maxTouchPoints: 5});
  await c('15 a tap in the wide split opens full screen', async () => {
    await ready();
    const {x, y} = await point();
    await page.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x, y}]});
    await page.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
    await page.waitFor('dtFull.isOpen', {what: 'full screen', timeout: 3000});
    assert(!await zoomed(), 'zoomed');
    await key('Escape');
  });
  await page.send('Emulation.setTouchEmulationEnabled', {enabled: false});

  await page.desktop({width: 1100, height: 800});
  await c('16 narrow: no bar, a click opens full screen', async () => {
    await ready();
    assert(await page.eval(`getComputedStyle(document.querySelector('.detail-pv .dz-bar')).display`) === 'none', 'bar shown');
    const {x, y} = await point();
    await press(x, y);
    await page.waitFor('dtFull.isOpen', {what: 'full screen', timeout: 3000});
    assert(!await zoomed(), 'zoomed');
    await key('Escape');
    await page.waitFor('!dtFull.isOpen', {what: 'closed', timeout: 3000});
  });
  await c('17 narrow: a double-click opens the photo', async () => {
    const {x, y} = await point();
    await press(x, y, 1);
    await press(x, y, 2);
    await page.waitFor(`location.pathname.startsWith('/photo/')`, {what: 'photo page', timeout: 5000});
  });
  await c('18 no js errors, all', async () => { assert(!page.errors.length, page.errors.join('; ')); });
}

try { await main(); } finally { await page.close(); await chrome.stop(); }
const bad = results.filter((r) => !r.ok);
for (const r of bad) console.log(`FAIL ${r.name}: ${r.why}${r.shot ? ' (' + r.shot + ')' : ''}`);
console.log(bad.length ? `lightzoom: ${results.length - bad.length}/${results.length} passed, ${bad.length} failed` : `lightzoom: ${results.length}/${results.length} passed (${URL_})`);
process.exit(bad.length ? 1 : 0);
