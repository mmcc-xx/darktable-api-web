#!/usr/bin/env node
// Named masks shared with modules before them (W65) over CDP: a named mask "sky"
// (a circle) made through the web API, denoise (profiled) -- before it in the
// pipe -- picks it in its mask row ("sky (shapes, shared)"): the engine puts the
// mask's group of drawn shapes on denoise's own mask (mask_attach), so a shape
// added to "sky" shows on denoise too; colorbalancergb, after it, still uses the
// raster mask; denoise's parametric range stays its own, invert stays per
// module without a second group, "none" detaches (the shapes stay with "sky"),
// removing "sky" takes its group off denoise. Scratch web app only (:8030),
// never :8010; the edit is discarded at the end (never saved).
//
//   (source /tmp/dts-N/env; node tests/sharedmask.mjs [--url http://127.0.0.1:8030]
//     [--photo 161] [--only desktop|phone] [--out /tmp/w65] [--brief])

import {mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {startChrome, openPage} from './cdp.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i < 0 ? dflt : args[i + 1]; };
const URL_ = opt('url', 'http://127.0.0.1:8030').replace(/\/$/, '');
const PORT = +opt('port', 9333);
const PHOTO = opt('photo', '161');
const OUT = opt('out', '/tmp/w65');
const ONLY = opt('only', null);
const BRIEF = args.includes('--brief');
const PY = process.env.PYTHON || `${homedir()}/darktableluamcp/venv/bin/python`;
if (/:8010\b/.test(URL_) && !args.includes('--force')) {
  console.error('sharedmask: refusing :8010 (the real library); use a scratch web app'); process.exit(2);
}
if (!process.env.DTAPI_SOCKET) { console.error('sharedmask: source the scratch engine\'s env first (DTAPI_SOCKET)'); process.exit(2); }
mkdirSync(OUT, {recursive: true});

const results = [];
const log = (s) => { if (!BRIEF) console.log(s); };
const assert = (c, m) => { if (!c) throw new Error(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const API = `${URL_}/api/photo/${PHOTO}`;
const getMasks = () => fetch(`${API}/masks`).then((r) => r.json());
const post = (path, body) => fetch(`${API}/${path}`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
const sky = async () => { const m = (await getMasks()).masks.find((x) => x.name === 'sky'); assert(m, 'no mask "sky" in /masks'); return m; };
const target = async (op, inst = 0) => { const t = (await getMasks()).targets.find((x) => x.operation === op && x.instance === inst); assert(t, `no target ${op}:${inst}`); return t; };
const mcp = (...a) => {
  const out = execFileSync(PY, [new URL('./sharedmask_mcp.py', import.meta.url).pathname, ...a], {encoding: 'utf8', timeout: 300000}).trim().split('\n').pop();
  const j = JSON.parse(out);
  if (!j.ok) throw new Error('mcp: ' + out);
  return j;
};
// denoise's own mask groups, as the engine lists them: [{formid, members: n}]
const groups = (op) => mcp('masks', PHOTO, op).shapes.filter((s) => s.type === 'group').map((s) => ({formid: s.formid, members: (s.members || []).length}));
const discard = () => fetch(`${API}/open?fresh=true`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'});
const rendered = `(() => { const i = document.querySelector('#pv'); return i && i.src.startsWith('blob:') && i.complete && i.naturalWidth > 0; })()`;
const settled = (page) => page.waitFor(`!document.querySelector('#save').disabled && ${rendered}`, {timeout: 60000, what: 'the edit applied and rendered'});

const grab = (page, name, query) => page.eval(`(async () => {
  const r = await fetch('${API}/preview.jpg?w=600&h=600${query}'); if (!r.ok) throw new Error(r.status + ' ' + await r.text());
  const bmp = await createImageBitmap(await r.blob()), c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height; const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
  (window.__snap = window.__snap || {})[${JSON.stringify(name)}] = g.getImageData(0, 0, c.width, c.height).data; return c.width; })()`);
const diff = (page, a, b) => page.eval(`(() => { const x = window.__snap[${JSON.stringify(a)}], y = window.__snap[${JSON.stringify(b)}];
  let s = 0; for (let i = 0; i < x.length; i++) if (i % 4 < 3) s += Math.abs(x[i] - y[i]); return s / (x.length * 3 / 4); })()`);

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

// a module's row in the pipeline view, opened; its mask row's select options
const ROW = (op) => `#pipeline .prow[data-key="${op}:0"]`;
async function openRow(page, op) {
  await page.waitFor(`!!document.querySelector('${ROW(op)}')`, {what: op + ' row'});
  const open = await page.eval(`!!document.querySelector('${ROW(op)} .mask-row select')`);
  if (!open) await page.eval(`document.querySelector('${ROW(op)} .pname').click()`);
  await page.waitFor(`!!document.querySelector('${ROW(op)} .mask-row select')`, {what: op + ' mask row'});
  await page.eval(`document.querySelector('${ROW(op)}').scrollIntoView({block: 'center'})`);
}
const options = (page, op) => page.eval(`[...document.querySelectorAll('${ROW(op)} .mask-row select option')].map((o) => ({text: o.textContent, value: o.value, disabled: o.disabled}))`);
const pick = async (page, op, value) => {
  await openRow(page, op);
  await page.eval(`(() => { const s = document.querySelector('${ROW(op)} .mask-row select'); s.value = ${JSON.stringify(String(value))}; s.dispatchEvent(new Event('change', {bubbles: true})); })()`);
  await sleep(500); await settled(page);
};

async function run(mode, port) {
  await discard();
  mcp('setup', PHOTO);
  const page = await openPage(port);
  const c = (name, f) => check(mode, page, name, f);
  const phone = mode === 'phone';
  let N, group;
  try {
    if (phone) await page.phone(); else await page.desktop();

    await c('setup: web POST mask "sky" (a circle): group, attach, after denoise in the pipe', async () => {
      const r = await post('mask', {name: 'sky', shape: 'circle', x: 0.5, y: 0.3, radius: 0.15});
      assert(r.ok, 'POST mask ' + r.status + ' ' + await r.text());
      const d = await getMasks(), s = await sky();
      N = s.instance; group = s.group;
      assert(group !== null && group !== undefined, 'sky.group ' + group);
      assert(d.attach === true, 'attach ' + d.attach);
      const dn = await target('denoiseprofile');
      assert(s.pos > dn.pos, `sky pos ${s.pos} <= denoise pos ${dn.pos}`);
      assert(dn.shared === false && dn.mask === null, JSON.stringify(dn));
      return `sky ${N} group ${group} pos ${s.pos} > denoise ${dn.pos}`;
    });

    await c('open the page; denoise\'s mask row offers an enabled "sky (shapes, shared)"', async () => {
      await page.goto(`${URL_}/photo/${PHOTO}`);
      await page.waitFor(rendered, {timeout: 60000, what: 'the first render'});
      await page.click('[data-view=pipeline]');
      await openRow(page, 'denoiseprofile');
      const o = (await options(page, 'denoiseprofile')).find((x) => x.text === 'sky (shapes, shared)');
      assert(o && !o.disabled && o.value === String(N), 'options ' + JSON.stringify(await options(page, 'denoiseprofile')));
      await page.screenshot(`${OUT}/${mode}-row.png`);
      return JSON.stringify(o);
    });

    if (phone) {
      await c('phone: choose it (touch); /masks says shared', async () => {
        await openRow(page, 'denoiseprofile');
        const o = (await options(page, 'denoiseprofile')).find((x) => x.text === 'sky (shapes, shared)');
        assert(o && !o.disabled, 'option missing or disabled');
        await pick(page, 'denoiseprofile', N);
        const t = await target('denoiseprofile');
        assert(t.shared === true && t.mask === N, JSON.stringify(t));
        assert((await sky()).users.some((u) => u.operation === 'denoiseprofile' && u.shared), 'sky.users ' + JSON.stringify((await sky()).users));
        await page.screenshot(`${OUT}/phone-shared.png`);
        return JSON.stringify(t);
      });
      await c('no js errors', async () => { assert(!page.errors.length, page.errors.join('; ')); });
      return;
    }

    await c('choose it: denoise shared=true mask=sky; sky.users has it shared; engine has the group', async () => {
      await pick(page, 'denoiseprofile', N);
      const t = await target('denoiseprofile');
      assert(t.shared === true && t.mask === N && t.inverted === false, JSON.stringify(t));
      const u = (await sky()).users.find((x) => x.operation === 'denoiseprofile');
      assert(u && u.shared === true, 'sky.users ' + JSON.stringify((await sky()).users));
      const g = groups('denoiseprofile');
      assert(g.some((x) => x.formid === group), `engine groups ${JSON.stringify(g)} lack ${group}`);
      const sel = await page.eval(`document.querySelector('${ROW('denoiseprofile')} .mask-row select').value`);
      assert(sel === String(N), 'select shows ' + sel);
      return `groups ${JSON.stringify(g)}`;
    });

    await c('color balance rgb selects sky through its row: raster, shared=false', async () => {
      await pick(page, 'colorbalancergb', N);
      const t = await target('colorbalancergb');
      assert(t.mask === N && t.shared === false, JSON.stringify(t));
      const dn = await target('denoiseprofile');
      assert(dn.shared === true, 'denoise lost sharing ' + JSON.stringify(dn));
      return JSON.stringify(t);
    });

    await c('page: the masks section lists "denoise (profiled) (its shapes)" under sky', async () => {
      await page.eval("(() => { const d = document.querySelector('details[data-sec=\"masks\"]'); if (d) d.open = true; })()");
      await page.waitFor(`!!document.querySelector('details[data-sec="masks"]') && /used by: .*\\(its shapes\\)/.test(document.querySelector('details[data-sec="masks"]').textContent)`, {what: 'used by ... (its shapes)'});
      const t = await page.eval(`document.querySelector('details[data-sec="masks"]').textContent.replace(/\\s+/g, ' ').match(/used by: .{0,80}/)[0]`);
      return t;
    });

    await c('add a second shape to sky: denoise\'s group has 2 members; its masked preview changes', async () => {
      await grab(page, 'm0', `&mask_op=denoiseprofile&mask_instance=0`);
      assert(groups('denoiseprofile').find((x) => x.formid === group).members === 1, 'not 1 member before');
      const r = await post('mask', {instance: N, shape: 'circle', x: 0.2, y: 0.7, radius: 0.12});
      assert(r.ok, 'POST mask ' + r.status + ' ' + await r.text());
      const g = groups('denoiseprofile');
      assert(g.length === 1 && g[0].formid === group && g[0].members === 2, 'engine groups ' + JSON.stringify(g));
      await grab(page, 'm1', `&mask_op=denoiseprofile&mask_instance=0`);
      const d = await diff(page, 'm0', 'm1');
      assert(d > 0.1, `denoise's mask preview changed by ${d.toFixed(3)}`);
      assert((await sky()).shapes === 2, 'sky shapes ' + (await sky()).shapes);
      return `members 2; preview diff ${d.toFixed(2)}`;
    });

    await c('per-module parametric: set_blending g_in on denoise; sky stays without ranges, denoise still shared', async () => {
      mcp('param', PHOTO, 'denoiseprofile');
      const s = await sky(), t = await target('denoiseprofile');
      assert((s.parametric || []).length === 0, 'sky parametric ' + JSON.stringify(s.parametric));
      assert(t.shared === true && t.mask === N, JSON.stringify(t));
      assert(groups('denoiseprofile').some((x) => x.formid === group), 'group gone');
      return 'sky.parametric []';
    });

    await c('invert on denoise\'s row: still shared, inverted, one group', async () => {
      await sleep(1500);                       // the page follows the MCP's change (no reload: the edit is unsaved)
      await openRow(page, 'denoiseprofile');
      await page.eval(`document.querySelector('${ROW('denoiseprofile')} .mask-row input[type=checkbox]').click()`);
      await sleep(600); await settled(page);
      const t = await target('denoiseprofile');
      assert(t.shared === true && t.inverted === true && t.mask === N, JSON.stringify(t));
      const g = groups('denoiseprofile');
      assert(g.filter((x) => x.formid === group).length === 1 && g.length === 1, 'groups ' + JSON.stringify(g));
      assert((await target('colorbalancergb')).inverted === false, 'colorbalancergb inverted too');
      return JSON.stringify(g);
    });

    await c('choose "none" on denoise: shared false, mask null; sky keeps 2 shapes', async () => {
      await pick(page, 'denoiseprofile', '');
      const t = await target('denoiseprofile');
      assert(t.shared === false && t.mask === null, JSON.stringify(t));
      assert((await sky()).shapes === 2, 'sky shapes ' + (await sky()).shapes);
      assert(!groups('denoiseprofile').some((x) => x.formid === group), 'group still on denoise');
      return 'detached';
    });

    await c('re-share, then remove sky: denoise loses the group', async () => {
      await pick(page, 'denoiseprofile', N);
      let t = await target('denoiseprofile');
      assert(t.shared === true && t.mask === N, 're-share ' + JSON.stringify(t));
      const r = await post('mask/remove', {instance: N});
      assert(r.ok, 'mask/remove ' + r.status + ' ' + await r.text());
      assert(!(await getMasks()).masks.some((m) => m.instance === N), 'sky still listed');
      const g = groups('denoiseprofile');
      assert(!g.some((x) => x.formid === group), 'engine groups still have sky\'s: ' + JSON.stringify(g));
      t = await target('denoiseprofile');
      assert(t.shared === false && t.mask === null, JSON.stringify(t));
      return 'groups ' + JSON.stringify(g);
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
console.log(bad.length ? `sharedmask: ${results.length - bad.length}/${results.length} passed, ${bad.length} failed` : `sharedmask: ${results.length}/${results.length} passed (${URL_}, photo ${PHOTO})`);
process.exit(bad.length ? 1 : 0);
