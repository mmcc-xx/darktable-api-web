#!/usr/bin/env node
// Immich page and "send to Immich" (W57) over CDP, against a fake Immich
// (darktableluamcp/darktable-api/fake_immich_serve.py: source its env file
// first, so the web app and this test see the same IMMICH_URL and
// FAKE_IMMICH_ORIG / FAKE_IMMICH_TRIPS). Desktop: the inbox photo is listed,
// opened, edited, sent with an album (saved first, after the question), the
// fake's state checked, resent, opened again from its URL. Phone: the page
// and the picker fit, a send with no album change. Scratch web app only
// (:8030), never :8010. The photo is the inbox photo the web app imports.
//
//   node tests/immich.mjs [--url http://127.0.0.1:8030] [--only desktop|phone]
//                         [--out /tmp/w57-shots] [--port 9333] [--brief]

import {mkdirSync} from 'node:fs';
import {startChrome, openPage} from './cdp.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i < 0 ? dflt : args[i + 1]; };
const URL_ = opt('url', 'http://127.0.0.1:8030').replace(/\/$/, '');
const PORT = +opt('port', 9333);
const OUT = opt('out', '/tmp/w57-shots');
const ONLY = opt('only', null);
const BRIEF = args.includes('--brief');
if (/:8010\b/.test(URL_) && !args.includes('--force')) {
  console.error('immich: refusing :8010 (the real library); use a scratch web app'); process.exit(2);
}
const ORIG = process.env.FAKE_IMMICH_ORIG, TRIPS = process.env.FAKE_IMMICH_TRIPS;
const FAKE = (process.env.IMMICH_URL || '').replace(/\/api\/?$/, '');
if (!ORIG || !TRIPS || !FAKE) { console.error('immich: source the fake\'s env file (fake_immich_serve.py) first'); process.exit(2); }
mkdirSync(OUT, {recursive: true});

const results = [];
const log = (s) => { if (!BRIEF) console.log(s); };
const assert = (c, m) => { if (!c) throw new Error(m); };
const fakeState = () => fetch(`${FAKE}/_fake/state`).then((r) => r.json());
const albumsOf = (st, id) => Object.entries(st.albums).filter(([, ids]) => ids.includes(id)).map(([n]) => n);
let PHOTO = null;               // the inbox photo's library id

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

const rendered = `(() => { const i = document.querySelector('#pv'); return i && i.src.startsWith('blob:') && i.complete && i.naturalWidth > 0; })()`;
const noOverflow = (page) => page.eval('document.documentElement.scrollWidth <= window.innerWidth');
let ev = 0;
// a small edit through the app's own API; the page shows it as unsaved
async function edit(page) {
  ev += 0.2;
  await page.eval(`fetch('/api/photo/${PHOTO}/set', {method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({operation: 'exposure', values: {exposure: ${ev.toFixed(2)}}})}).then((r) => r.ok || Promise.reject(new Error('set ' + r.status)))`);
  const shown = "!document.querySelector('#save').disabled";
  // the page learns of it by an event; if its stream wasn't up yet, reopening joins the edit
  try { await page.waitFor(shown, {timeout: 3000}); } catch {
    await page.goto(URL_ + `/photo/${PHOTO}`);
    await page.waitFor(rendered, {timeout: 60000, what: 'the render after reopening'});
    await page.waitFor(shown, {what: 'unsaved changes shown'});
  }
}
async function openPhoto(page) {
  await page.goto(`${URL_}/photo/${PHOTO}`);
  await page.waitFor(rendered, {timeout: 60000, what: 'the first render'});
  await new Promise((r) => setTimeout(r, 1500));      // the page's event stream is connected
}
async function openPicker(page) {
  await page.eval("document.querySelector('#export').open = true");
  // on the phone the sections are in the raised bottom sheet
  if (page.touch && !await page.eval("document.body.classList.contains('sheet-up')")) {
    await page.click('#sheet-handle');
    await page.waitFor("document.body.classList.contains('sheet-up')", {what: 'the sheet raised'});
  }
  await page.click('#im-open');
  await page.waitFor("!document.querySelector('#im-pick').hidden && document.querySelectorAll('#im-list label').length > 0", {what: 'the album picker'});
}
// send with the picker as it is; accept the save question when the edit is unsaved
async function send(page, {albums = []} = {}) {
  for (const id of albums) await page.eval(`(() => { const i = document.querySelector('#im-list input[value="${id}"]'); if (!i.checked) i.click(); })()`);
  await page.click('#im-go');
  await page.waitFor("document.querySelector('dialog[open] .ask-ok')", {what: 'the save and send question'});
  await page.click('dialog[open] .ask-ok');
  await page.waitFor("/^(sent to Immich|already sent)/.test(document.querySelector('#im-result').textContent)", {timeout: 120000, what: 'the send result'});
  await page.waitFor("document.querySelector('#save').disabled", {what: 'the edit saved'});
  return page.eval("document.querySelector('#im-result').textContent");
}

async function run(mode) {
  const page = await openPage(chrome.port);
  try {
    if (mode === 'phone') await page.phone(); else await page.desktop();
    const c = (name, f) => check(mode, page, name, f);

    if (mode === 'desktop') {
      if (!await c('immich page lists the inbox photo', async () => {
        await page.goto(URL_ + '/immich');
        assert(await page.eval("[...document.querySelectorAll('header.top a')].some((a) => a.getAttribute('href') === '/immich')"), 'no immich link in the nav');
        await page.waitFor("!document.querySelector('#im').hidden", {what: 'the page'});
        await page.click('#im-check');
        await page.waitFor("document.querySelectorAll('#im-waiting figure.tile').length === 1", {timeout: 120000, what: 'the inbox photo'});
        const t = await page.eval(`(() => { const f = document.querySelector('#im-waiting figure.tile');
          return {name: f.querySelector('.name').textContent, href: f.querySelector('a').getAttribute('href'),
                  badge: (f.querySelector('.badge') || {}).textContent, why: (f.querySelector('.badge') || {}).title}; })()`);
        assert(t.name === 'orig.jpg', 'file name ' + t.name);
        assert(t.badge === 'JPEG' && /less latitude/.test(t.why), 'JPEG badge ' + JSON.stringify(t));
        PHOTO = t.href.replace('/photo/', '');
        assert(/^\d+$/.test(PHOTO), 'link ' + t.href);
        await page.screenshot(`${OUT}/immich-desktop.png`);
        return `photo ${PHOTO}`;
      })) return;

      if (!await c('photo page picker', async () => {
        await page.click('#im-waiting figure.tile a');
        await page.waitFor(`location.pathname === '/photo/${PHOTO}'`, {what: 'the photo page'});
        await page.waitFor(rendered, {timeout: 60000, what: 'the first render'});
        assert(await page.eval("document.querySelector('#im-open') && document.querySelector('#im-open').textContent === 'send to Immich…'"), 'no send to Immich… button');
        assert(await page.eval("!!document.querySelector('#more-immich')"), 'no ⋯ menu entry');
        await openPicker(page);
        const names = await page.eval("[...document.querySelectorAll('#im-list label')].map((l) => l.textContent.replace(/\\s+\\d*$/, '').trim())");
        for (const n of ['Family', 'Trips', 'Edit in darktable']) assert(names.includes(n), `album ${n} missing from ${names}`);
        assert(names.join('|') === [...names].sort((a, b) => a.localeCompare(b)).join('|'), 'not sorted: ' + names);
        assert(await page.eval("!document.querySelector('#im-note').hidden && /original's albums/.test(document.querySelector('#im-note').textContent)"), 'no line about the original\'s albums');
        await page.screenshot(`${OUT}/picker-desktop.png`);
        return names.join(', ');
      })) return;

      await c('send with Trips', async () => {
        await edit(page);
        await openPicker(page);
        const text = await send(page, {albums: [TRIPS]});
        assert(/albums: .*Trips/.test(text) && /stacked over the original/.test(text) && /open in Immich/.test(text), text);
        const href = await page.eval("document.querySelector('#im-result a').href");
        const st = await fakeState();
        assert(st.uploaded.length === 1, 'uploads ' + st.uploaded.length);
        const up = st.uploaded[0];
        assert(href === `${FAKE}/photos/${up}`, 'link ' + href);
        const al = albumsOf(st, up);
        assert(al.includes('Family') && al.includes('Trips'), 'albums ' + al);
        const stack = st.assets[up].stack;
        assert(stack && stack.primary === up && stack.assets.includes(ORIG), 'stack ' + JSON.stringify(stack));
        assert(!st.assets[ORIG].isTrashed, 'the original is trashed');
        assert(!albumsOf(st, ORIG).includes('Edit in darktable') && !albumsOf(st, up).includes('Edit in darktable'), 'still in the inbox');
        return text;
      });

      await c('immich page: waiting empty, sent listed', async () => {
        await page.goto(URL_ + '/immich');
        await page.waitFor(`document.querySelectorAll('#im-sent figure.tile').length === 1 && document.querySelectorAll('#im-waiting figure.tile').length === 0`, {timeout: 60000, what: 'sent listed, nothing waiting'});
        const t = await page.eval(`(() => { const a = document.querySelector('#im-sent figure.tile a[target=_blank]');
          return {href: a && a.href, rel: a && a.rel, from: document.querySelector('#im-sent').textContent.includes('from Immich'),
                  photo: document.querySelector('#im-sent figure.tile a').getAttribute('href')}; })()`);
        const up = (await fakeState()).uploaded[0];
        assert(t.href === `${FAKE}/photos/${up}` && /noopener/.test(t.rel), 'Immich link ' + JSON.stringify(t));
        assert(t.photo === `/photo/${PHOTO}` && t.from, 'tile ' + JSON.stringify(t));
        assert(await page.eval("!document.querySelector('#im-waiting-empty').hidden"), 'no empty line for waiting');
      });

      await c('resend trashes the previous upload', async () => {
        await openPhoto(page);
        await edit(page);
        await openPicker(page);
        assert(await page.eval(`document.querySelector('#im-list input[value="${TRIPS}"]').checked`), 'Trips not pre-checked');
        const text = await send(page);
        assert(/previous upload in Immich's trash/.test(text), text);
        const st = await fakeState();
        assert(st.uploaded.length === 2, 'uploads ' + st.uploaded.length);
        const [u1, u2] = st.uploaded;
        assert(st.assets[u1].isTrashed && !st.assets[u2].isTrashed && !st.assets[ORIG].isTrashed, 'trash state');
        assert(st.assets[u2].stack && st.assets[u2].stack.primary === u2, 'stack primary');
        assert(albumsOf(st, u2).includes('Trips'), 'albums ' + albumsOf(st, u2));
      });

      await c('open from Immich with the original\'s URL', async () => {
        await page.goto(URL_ + '/immich');
        await page.waitFor("!document.querySelector('#im').hidden", {what: 'the page'});
        await page.eval(`document.querySelector('#im-asset').value = '${FAKE}/photos/${ORIG}'`);
        await page.eval("document.querySelector('#im-open-form button').click()");
        await page.waitFor(`location.pathname === '/photo/${PHOTO}'`, {timeout: 60000, what: 'the same photo'});
      });
    } else {
      if (!PHOTO) {   // phone alone: find the photo
        await page.goto(URL_ + '/immich');
        await page.waitFor("!document.querySelector('#im').hidden", {what: 'the page'});
        await page.eval("document.querySelector('#im-check').click()");
        const st = await page.waitFor(`fetch('/api/immich').then((r) => r.json()).then((s) => (s.waiting[0] || s.sent[0] || {}).image_id)`, {timeout: 120000, what: 'the photo'});
        PHOTO = String(st);
      }
      await c('immich page fits the phone', async () => {
        await page.goto(URL_ + '/immich');
        await page.waitFor("!document.querySelector('#im').hidden && document.querySelectorAll('figure.tile').length > 0", {timeout: 60000, what: 'tiles'});
        assert(await noOverflow(page), 'horizontal overflow: ' + await page.eval('document.documentElement.scrollWidth'));
        await page.screenshot(`${OUT}/immich-phone.png`);
      });
      await c('picker fits and scrolls; send without album change', async () => {
        await openPhoto(page);
        await edit(page);
        await openPicker(page);
        await page.eval("document.querySelector('#im-pick').scrollIntoView({block: 'center'})");
        const g = await page.eval(`(() => { const p = document.querySelector('#im-pick').getBoundingClientRect(), l = document.querySelector('#im-list'), cs = getComputedStyle(l);
          return {right: p.right, left: p.left, w: innerWidth, oy: cs.overflowY, maxh: parseFloat(cs.maxHeight), vh: innerHeight, over: document.documentElement.scrollWidth > innerWidth}; })()`);
        assert(g.left >= 0 && g.right <= g.w && !g.over, 'picker outside the width: ' + JSON.stringify(g));
        assert(g.oy === 'auto' && g.maxh <= g.vh * 0.41, 'list does not scroll: ' + JSON.stringify(g));
        await page.screenshot(`${OUT}/picker-phone.png`);
        const before = (await fakeState()).uploaded.length;
        const text = await send(page);
        const st = await fakeState();
        assert(st.uploaded.length === before + 1, 'uploads ' + st.uploaded.length);
        const [, u2, u3] = st.uploaded;
        assert(st.assets[u2].isTrashed && !st.assets[u3].isTrashed && !st.assets[ORIG].isTrashed, 'trash state');
        assert(albumsOf(st, u3).includes('Trips'), 'albums ' + albumsOf(st, u3));
        return text;
      });
    }

    await c('no JS errors', async () => {
      if (page.errors.length) throw new Error(page.errors.slice(0, 5).join(' | '));
    });
    await c('no failed loads', async () => {
      const other = page.failedLoads.filter((f) => !new URL(f.url, URL_).pathname.startsWith('/thumb/') && !f.url.endsWith('/favicon.ico'));
      if (other.length) throw new Error(other.slice(0, 5).map((f) => `${f.url}: ${f.text}`).join(' | '));
    });
  } finally {
    // the edit is saved by the sends; open it fresh so nothing stays unsaved in the engine
    if (PHOTO) await fetch(`${URL_}/api/photo/${PHOTO}/open?fresh=true`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'}).catch(() => {});
    await page.close();
  }
}

const chrome = await startChrome({port: PORT});
try {
  for (const mode of ['desktop', 'phone']) if (!ONLY || ONLY === mode) await run(mode);
} finally {
  await chrome.stop();
}

const bad = results.filter((r) => !r.ok);
const count = (m) => `${results.filter((r) => r.mode === m && r.ok).length}/${results.filter((r) => r.mode === m).length}`;
if (bad.length) {
  if (BRIEF) for (const r of bad) console.log(`FAIL ${r.mode} ${r.name}: ${r.why}${r.shot ? ' (' + r.shot + ')' : ''}`);
  console.log(`immich: ${results.length - bad.length}/${results.length} passed, ${bad.length} failed`);
  process.exit(1);
}
console.log(`immich: ${results.length}/${results.length} passed (desktop ${count('desktop')}, phone ${count('phone')}; ${URL_}, photo ${PHOTO})`);
