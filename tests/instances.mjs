#!/usr/bin/env node
// Module instances in the pipeline view (W60) over CDP: search for a module and add it
// (vignette), duplicate it, rename an instance (and back to darktable's label with an
// empty name), remove one (instances renumber), "a new instance" for a module already in
// the edit, disabled buttons and menu entries for one-instance modules (raw black/white
// point, rawprepare). Scratch web app only (:8030), never :8010; the edit is discarded
// (never saved).
//
//   (source /tmp/dts-N/env; node tests/instances.mjs [--url http://127.0.0.1:8030]
//     [--photo 161] [--only desktop|phone] [--out /tmp/w60] [--brief])

import {mkdirSync} from 'node:fs';
import {startChrome, openPage} from './cdp.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i < 0 ? dflt : args[i + 1]; };
const URL_ = opt('url', 'http://127.0.0.1:8030').replace(/\/$/, '');
const PORT = +opt('port', 9333);
const PHOTO = opt('photo', '161');
const OUT = opt('out', '/tmp/w60');
const ONLY = opt('only', null);
const BRIEF = args.includes('--brief');
if (/:8010\b/.test(URL_) && !args.includes('--force')) {
  console.error('instances: refusing :8010 (the real library); use a scratch web app'); process.exit(2);
}
if (!process.env.DTAPI_SOCKET) { console.error('instances: source the scratch engine\'s env first (DTAPI_SOCKET)'); process.exit(2); }
mkdirSync(OUT, {recursive: true});

const results = [];
const log = (s) => { if (!BRIEF) console.log(s); };
const assert = (c, m) => { if (!c) throw new Error(m); };
const API = `${URL_}/api/photo/${PHOTO}`;
const discard = () => fetch(`${API}/open?fresh=true`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'});
const rendered = `(() => { const i = document.querySelector('#pv'); return i && i.src.startsWith('blob:') && i.complete && i.naturalWidth > 0; })()`;
const row = (k) => `#pipeline .prow[data-key="${k}"]`;
const vigRows = `document.querySelectorAll('#pipeline .prow[data-key^="vignette:"]').length`;

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
  const page = await openPage(port);
  const c = (name, f) => check(mode, page, name, f);
  // set a select's value / an input's value and fire the event
  const choose = (k, v) => page.eval(`(() => { const s = document.querySelector('${row(k)} select.pinst'); s.value = ${JSON.stringify(v)};
    s.dispatchEvent(new Event('change', {bubbles: true})); return s.value; })()`);
  const typeSearch = async (text) => {
    await page.eval(`(() => { const q = document.querySelector('#pipeline .padd input'); q.value = ${JSON.stringify(text)};
      q.dispatchEvent(new Event('input', {bubbles: true})); })()`);
  };
  const removeDisabled = (k) => page.eval(`document.querySelector('${row(k)} select.pinst option[value=remove]').disabled`);
  try {
    if (mode === 'phone') await page.phone(); else await page.desktop();
    if (!await c('page opens, pipeline view shows, no vignette row', async () => {
      await page.goto(`${URL_}/photo/${PHOTO}`);
      await page.waitFor(rendered, {timeout: 60000, what: 'the first render'});
      await page.click('[data-view=pipeline]');
      await page.waitFor("!!document.querySelector('#pipeline .prow') && !!document.querySelector('#pipeline .padd input')", {what: 'the pipeline rows'});
      assert(await page.eval(vigRows) === 0, 'a vignette row before adding');
    })) return;

    await c('search "vignet", add it: row vignette:0 open, in_edit, new render', async () => {
      const src = await page.eval("document.querySelector('#pv').src");
      await typeSearch('vignet');
      await page.waitFor(`!!document.querySelector('#pipeline .padd-list button[data-op=vignette]')`, {what: 'the vignette hit'});
      await page.click('#pipeline .padd-list button[data-op=vignette]');
      await page.waitFor(`!!document.querySelector('${row('vignette:0')}')`, {what: 'row vignette:0'});
      await page.waitFor(`document.querySelector('${row('vignette:0')}').classList.contains('open')`, {what: 'the row open'});
      const m = (await (await fetch(`${API}/modules`)).json()).modules.find((x) => x.operation === 'vignette');
      assert(m && m.in_edit, 'GET /modules: ' + JSON.stringify(m));
      await page.waitFor(`document.querySelector('#pv').src !== ${JSON.stringify(src)} && ${rendered}`, {timeout: 60000, what: 'a new render'});
    });

    await c('duplicate: vignette:1 appears, vignette:0 can be removed', async () => {
      assert(await removeDisabled('vignette:0'), 'remove enabled with one instance');
      await choose('vignette:0', 'copy');
      await page.waitFor(`!!document.querySelector('${row('vignette:1')}')`, {what: 'row vignette:1'});
      assert(!await removeDisabled('vignette:0'), 'vignette:0 remove still disabled');
      await page.screenshot(`${OUT}/${mode}-instances.png`);
    });

    await c('rename vignette:1 to "edges", then back with an empty name', async () => {
      await choose('vignette:1', 'rename');
      await page.waitFor(`!!document.querySelector('${row('vignette:1')} input.prename')`, {what: 'the rename field'});
      const key = (k) => page.eval(`(() => { const i = document.querySelector('${row('vignette:1')} input.prename');
        i.dispatchEvent(new KeyboardEvent('keydown', {key: ${JSON.stringify(k)}, bubbles: true})); })()`);
      await page.eval(`(() => { const i = document.querySelector('${row('vignette:1')} input.prename'); i.value = 'edges';
        i.dispatchEvent(new Event('input', {bubbles: true})); })()`);
      await key('Enter');
      await page.waitFor(`/edges/.test((document.querySelector('${row('vignette:1')} .pname') || {}).textContent || '')`, {what: 'edges in the name'});
      await choose('vignette:1', 'rename');
      await page.waitFor(`!!document.querySelector('${row('vignette:1')} input.prename')`, {what: 'the rename field again'});
      await page.eval(`(() => { document.querySelector('${row('vignette:1')} input.prename').value = ''; })()`);
      await key('Enter');
      await page.waitFor(`(() => { const n = document.querySelector('${row('vignette:1')} .pname'); return n && !/edges/.test(n.textContent); })()`, {what: 'edges gone from the name'});
    });

    await c('remove vignette:0: one vignette row left, its remove disabled', async () => {
      await choose('vignette:0', 'remove');
      await page.waitFor(`${vigRows} === 1`, {what: 'one vignette row'});
      const k = await page.eval(`document.querySelector('#pipeline .prow[data-key^="vignette:"]').dataset.key`);
      assert(await removeDisabled(k), `${k}: remove enabled`);
      return k;
    });

    await c('search: "exposure" says new instance, "raw black" is disabled, Escape clears', async () => {
      await typeSearch('exposure');
      await page.waitFor(`!!document.querySelector('#pipeline .padd-list button[data-op=exposure]')`, {what: 'the exposure hit'});
      const t = await page.eval(`document.querySelector('#pipeline .padd-list button[data-op=exposure]').textContent`);
      assert(/new instance/.test(t), 'exposure hit: ' + t);
      await typeSearch('raw black');
      await page.waitFor(`!!document.querySelector('#pipeline .padd-list button[data-op=rawprepare]')`, {what: 'the rawprepare hit'});
      assert(await page.eval(`document.querySelector('#pipeline .padd-list button[data-op=rawprepare]').disabled`), 'rawprepare hit enabled');
      await page.eval(`document.querySelector('#pipeline .padd input').dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))`);
      await page.waitFor(`document.querySelector('#pipeline .padd-list').children.length === 0 && document.querySelector('#pipeline .padd input').value === ''`, {what: 'a cleared list'});
    });

    if (mode === 'desktop') await c('default modules shown: rawprepare cannot get a new instance', async () => {
      await page.eval(`(() => { const i = document.querySelector('#pipeline .pdef input'); if (!i.checked) i.click(); })()`);
      await page.waitFor(`!!document.querySelector('${row('rawprepare:0')}')`, {what: 'the rawprepare row'});
      const o = await page.eval(`(() => { const s = document.querySelector('${row('rawprepare:0')} select.pinst');
        return ['new', 'copy'].map((v) => s.querySelector('option[value=' + v + ']').disabled); })()`);
      assert(o[0] && o[1], 'new/copy disabled: ' + o);
    });

    await c('no js errors', async () => { assert(!page.errors.length, page.errors.join('; ')); });
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
console.log(bad.length ? `instances: ${results.length - bad.length}/${results.length} passed, ${bad.length} failed` : `instances: ${results.length}/${results.length} passed (${URL_}, photo ${PHOTO})`);
process.exit(bad.length ? 1 : 0);
