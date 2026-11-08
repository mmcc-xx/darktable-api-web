#!/usr/bin/env node
// The Immich inbox in the library (W61) and "send to Immich" (W57) over CDP, against a fake Immich
// (darktableluamcp/darktable-api/fake_immich_serve.py: source its env file
// first, so the web app and this test see the same IMMICH_URL and
// FAKE_IMMICH_ORIG / FAKE_IMMICH_TRIPS / FAKE_IMMICH_SECOND). Desktop: no nav link;
// /immich leads to the library filtered to the inbox (a pseudo-roll in the picker, a
// bar, JPEG badges, wide mode, darkroom prev/next inside it); the inbox photo is
// opened, edited, sent with an album (saved first, after the question), the
// fake's state checked, resent, opened again from its URL. Phone: the inbox view
// and the picker fit, a send with no album change. Scratch web app only
// (:8030), never :8010. The photo is the inbox photo the web app imports.
//
//   node tests/immich.mjs [--url http://127.0.0.1:8030] [--only desktop|phone]
//                         [--out /tmp/w61-shots] [--port 9333] [--brief]

import {mkdirSync} from 'node:fs';
import {startChrome, openPage} from './cdp.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i < 0 ? dflt : args[i + 1]; };
const URL_ = opt('url', 'http://127.0.0.1:8030').replace(/\/$/, '');
const PORT = +opt('port', 9333);
const OUT = opt('out', '/tmp/w61-shots');
const ONLY = opt('only', null);
const BRIEF = args.includes('--brief');
if (/:8010\b/.test(URL_) && !args.includes('--force')) {
  console.error('immich: refusing :8010 (the real library); use a scratch web app'); process.exit(2);
}
const ORIG = process.env.FAKE_IMMICH_ORIG, TRIPS = process.env.FAKE_IMMICH_TRIPS, SECOND = process.env.FAKE_IMMICH_SECOND;
const FAKE = (process.env.IMMICH_URL || '').replace(/\/api\/?$/, '');
if (!ORIG || !TRIPS || !SECOND || !FAKE) { console.error('immich: source the fake\'s env file (fake_immich_serve.py) first'); process.exit(2); }
mkdirSync(OUT, {recursive: true});

const results = [];
const log = (s) => { if (!BRIEF) console.log(s); };
const assert = (c, m) => { if (!c) throw new Error(m); };
const fakeState = () => fetch(`${FAKE}/_fake/state`).then((r) => r.json());
const albumsOf = (st, id) => Object.entries(st.albums).filter(([, ids]) => ids.includes(id)).map(([n]) => n);
let PHOTO = null;               // orig.jpg's library id
// choose a roll picker option; the form submits, so give the navigation time before looking at the page
const pickRoll = async (page, expr) => {
  await page.eval(`(() => { const s = document.querySelector('select[name=roll]'); ${expr}; s.dispatchEvent(new Event('change')); })()`);
  await new Promise((r) => setTimeout(r, 1500));
};
const INBOX = '/?tag=immich%7Cinbox';
const tiles = (page) => page.eval(`[...document.querySelectorAll('#grid figure.tile')].map((f) => ({id: f.dataset.id, name: f.dataset.name, badge: (f.querySelector('.badge') || {}).textContent, why: (f.querySelector('.badge') || {}).title}))`);

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
      if (!await c('no nav link (the inbox is a roll); /immich leads to the inbox view', async () => {
        await page.goto(URL_ + '/');
        const hrefs = await page.eval("[...document.querySelectorAll('header.top a')].map((a) => a.getAttribute('href'))");
        assert(!hrefs.some((h) => /immich/.test(h || '')), 'an Immich link in the nav: ' + hrefs);
        await page.goto(URL_ + '/immich');
        const loc = await page.eval('decodeURIComponent(location.pathname + location.search)');
        assert(loc === '/?tag=immich|inbox', 'redirected to ' + loc);
      })) return;

      if (!await c('roll picker has the pseudo-rolls, the inbox selected', async () => {
        const o = await page.eval(`(() => { const s = document.querySelector('select[name=roll]');
          return {texts: [...s.options].map((x) => x.textContent), sel: s.selectedOptions[0].textContent}; })()`);
        assert(o.texts.includes('Immich inbox') && o.texts.includes('sent to Immich'), 'options ' + o.texts);
        assert(o.sel === 'Immich inbox', 'selected ' + o.sel);
        assert(o.texts.indexOf('Immich inbox') === 1, 'not right under "all film rolls": ' + o.texts);
      })) return;

      if (!await c('inbox bar, check now, two JPEG tiles', async () => {
        assert(await page.eval("!!document.querySelector('#im-bar') && !document.querySelector('#im-bar').hidden"), 'no bar');
        await page.waitFor("document.querySelector('#im-when') && document.querySelector('#im-when').textContent !== '…'", {what: 'the bar filled'});
        await page.click('#im-check');
        await page.waitFor("document.querySelectorAll('#grid figure.tile').length === 2", {timeout: 120000, what: 'the two inbox photos'});
        await page.waitFor("document.querySelectorAll('#grid figure.tile .badge').length === 2", {what: 'the JPEG badges'});
        const t = await tiles(page);
        const names = t.map((x) => x.name).sort();
        assert(names.join() === 'orig.jpg,second.jpg', 'tiles ' + names);
        for (const x of t) assert(x.badge === 'JPEG' && /less latitude/.test(x.why), 'JPEG badge ' + JSON.stringify(x));
        assert(await page.eval("/inbox: album/.test(document.querySelector('#im-bar').textContent) && document.querySelector('#im-err').textContent === ''"), 'bar text');
        PHOTO = t.find((x) => x.name === 'orig.jpg').id;
        assert(/^\d+$/.test(PHOTO), 'id ' + PHOTO);
        await page.screenshot(`${OUT}/inbox-desktop.png`);
        return `photo ${PHOTO}`;
      })) return;

      await c('wide mode on the inbox', async () => {
        const g = await page.eval(`(() => { const sp = document.querySelector('#lt-split'), d = document.querySelector('#detail');
          return {split: getComputedStyle(sp).display, detail: getComputedStyle(d).display, w: d.getBoundingClientRect().width}; })()`);
        assert(g.split === 'block' && g.detail !== 'none' && g.w > 300, 'not wide: ' + JSON.stringify(g));
        await page.click('#grid figure.tile a');
        await page.waitFor("document.querySelector('#detail img, #detail canvas') && document.querySelector('#detail .detail-name, #detail .name, #detail h3')", {timeout: 30000, what: 'the preview beside the grid'});
        assert(await page.eval("location.pathname === '/'"), 'left the library');
        assert(await noOverflow(page), 'horizontal overflow');
      });

      if (!await c('darkroom prev/next stay in the inbox', async () => {
        await page.goto(URL_ + INBOX);
        await page.waitFor("document.querySelectorAll('#grid figure.tile').length === 2", {what: 'tiles'});
        const t = await tiles(page);
        await page.goto(`${URL_}/photo/${t[0].id}?tag=immich%7Cinbox`);
        const nav = async () => { await page.waitFor("!!document.querySelector('.photo-nav')", {what: 'the photo page'}); return page.eval(`(() => { const n = document.querySelector('.photo-nav'); const g = (id) => { const a = document.querySelector(id); return a && a.getAttribute('href'); };
          return {pos: [...n.querySelectorAll('span')].map((x) => x.textContent).find((x) => /^\\d+ \\/ \\d+$/.test(x)), prev: g('#prev'), next: g('#next'), id: location.pathname.split('/')[2]}; })()`); };
        let n = await nav();
        assert(n.pos === '1 / 2' && n.next && !n.prev, 'first ' + JSON.stringify(n));
        assert(n.next.startsWith(`/photo/${t[1].id}?`) && /tag=immich%7Cinbox/.test(n.next), 'next link ' + n.next);
        await page.click('#next');
        await page.waitFor(`location.pathname === '/photo/${t[1].id}'`, {what: 'the other inbox photo'});
        n = await nav();
        assert(n.pos === '2 / 2' && n.prev && !n.next, 'second ' + JSON.stringify(n));
        await page.click('#prev');
        await page.waitFor(`location.pathname === '/photo/${t[0].id}'`, {what: 'back'});
        n = await nav();
        assert(n.pos === '1 / 2', 'back ' + JSON.stringify(n));
        assert(await page.eval("new URLSearchParams(location.search).get('tag') === 'immich|inbox'"), 'tag lost');
      })) return;

      if (!await c('picking "sent to Immich" sets the tag, no roll', async () => {
        await page.goto(URL_ + INBOX);
        await pickRoll(page, "s.value = 'tag:immich|export'");
        await page.waitFor("new URLSearchParams(location.search).get('tag') === 'immich|export'", {what: 'the export view'});
        assert(!await page.eval("new URLSearchParams(location.search).get('roll')"), 'roll param: ' + await page.eval('location.search'));
        assert(await page.eval("document.querySelector('select[name=roll]').selectedOptions[0].textContent === 'sent to Immich'"), 'picker');
        assert(await page.eval("!document.querySelector('#im-bar')"), 'bar shown outside the inbox');
        assert(await page.eval("document.querySelectorAll('#grid figure.tile').length === 0"), 'tiles before any send');
      })) return;

      if (!await c('picking a real roll or all rolls clears the pseudo-roll tag', async () => {
        await page.goto(URL_ + '/?tag=immich%7Cexport');
        await pickRoll(page, 's.selectedIndex = 0');
        await page.waitFor("location.search.includes('tag=') && !new URLSearchParams(location.search).get('tag')", {what: 'the tag cleared'});
        assert(await page.eval("document.querySelector('select[name=roll]').selectedOptions[0].textContent === 'all film rolls'"), 'picker');
      })) return;

      if (!await c('photo page picker', async () => {
        await page.goto(`${URL_}/photo/${PHOTO}`);
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

      await c('after the send: orig.jpg leaves the inbox, is under "sent to Immich"', async () => {
        await page.goto(URL_ + INBOX);
        await page.click('#im-check');
        await page.waitFor("document.querySelectorAll('#grid figure.tile').length === 1", {timeout: 120000, what: 'one tile left in the inbox'});
        const left = await tiles(page);
        assert(left[0].name === 'second.jpg', 'left ' + JSON.stringify(left));
        await page.goto(URL_ + '/?tag=immich%7Cexport');
        await page.waitFor("document.querySelectorAll('#grid figure.tile').length === 1", {what: 'sent photo listed'});
        const sent = await tiles(page);
        assert(sent[0].id === PHOTO && sent[0].name === 'orig.jpg', 'sent ' + JSON.stringify(sent));
      });

      await c('photo page links to Immich', async () => {
        await openPhoto(page);
        await page.eval("document.querySelector('#info').open = true");
        await page.waitFor("document.querySelectorAll('#meta .im-links a').length === 2", {what: 'the links'});
        const l = await page.eval("[...document.querySelectorAll('#meta .im-links a')].map((a) => ({t: a.textContent, h: a.href, tg: a.target, rel: a.rel}))");
        const up = (await fakeState()).uploaded.at(-1);
        assert(l[0].t === 'in Immich ↗' && l[0].h === `${FAKE}/photos/${up}`, 'in Immich ' + JSON.stringify(l[0]));
        assert(l[1].t === 'from Immich ↗' && l[1].h === `${FAKE}/photos/${ORIG}`, 'from Immich ' + JSON.stringify(l[1]));
        assert(l.every((x) => x.tg === '_blank' && /noopener/.test(x.rel)), 'target/rel');
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
        await page.goto(URL_ + INBOX);
        await page.waitFor("!!document.querySelector('#im-asset')", {what: 'the bar'});
        await page.eval(`document.querySelector('#im-asset').value = '${FAKE}/photos/${ORIG}'`);
        await page.eval("document.querySelector('#im-open-form button').click()");
        await page.waitFor(`location.pathname === '/photo/${PHOTO}'`, {timeout: 60000, what: 'the same photo'});
      });
    } else {
      if (!PHOTO) {   // phone alone: find the photo
        await page.goto(URL_ + INBOX);
        await page.waitFor("!!document.querySelector('#im-bar')", {what: 'the bar'});
        await page.eval("document.querySelector('#im-check').click()");
        const st = await page.waitFor(`fetch('/api/immich').then((r) => r.json()).then((s) => (s.waiting.find((p) => p.file === 'orig.jpg') || s.sent[0] || {}).image_id)`, {timeout: 120000, what: 'the photo'});
        PHOTO = String(st);
      }
      await c('inbox view fits the phone', async () => {
        await page.goto(URL_ + INBOX);
        await page.waitFor("!!document.querySelector('#im-bar') && document.querySelectorAll('figure.tile').length > 0", {timeout: 60000, what: 'tiles'});
        assert(await noOverflow(page), 'horizontal overflow: ' + await page.eval('document.documentElement.scrollWidth'));
        await page.eval("document.querySelector('#im-err').textContent = 'check failed: a long reason ' + 'x'.repeat(200); document.querySelector('#im-asset').value = 'https://immich.example.org/photos/' + '0123456789abcdef'.repeat(4)");
        assert(await noOverflow(page), 'horizontal overflow with a long error: ' + await page.eval('document.documentElement.scrollWidth'));
        await page.eval("document.querySelector('#im-err').textContent = ''; document.querySelector('#im-asset').value = ''");
        await page.screenshot(`${OUT}/inbox-phone.png`);
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
