// Raw Chrome DevTools Protocol helpers for browser tests (W53): no packages,
// Node's built-in fetch and WebSocket. Used by tests/smoke.mjs; import it
// from a throwaway script instead of writing CDP plumbing again.
//
//   import {startChrome, openPage} from './cdp.mjs';
//   const chrome = await startChrome();            // Mac's headless Chrome
//   const page = await openPage(chrome.port);
//   await page.goto('http://127.0.0.1:8030/');
//   await page.waitFor("document.querySelectorAll('figure.tile').length > 0");
//   await page.click('#tool-crop');                 // or page.tap() with page.phone()
//   await page.screenshot('/tmp/shot.png');
//   page.errors, page.failedLoads                    // JS errors; failed resources
//   page.close(); await chrome.stop();
//
// Chrome must run outside the Bash sandbox (inside it dies with
// "Failed to get the path for 1001").

import {execFileSync, spawn} from 'node:child_process';
import {existsSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';

export const CHROME = process.env.CHROME ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function version(port) {
  try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); return r.ok ? await r.json() : null; }
  catch { return null; }
}

// Free memory before a new Chrome (#166: a night run's scratch engines,
// :8030 apps and Chrome filled the Mac's memory): throws when
// mem-check.sh says low. MEM_CHECK=off skips it, MEM_CHECK=path picks the script.
const MEM_CHECK = process.env.MEM_CHECK ||
  `${homedir()}/darktableluamcp/darktable-api/launchd/mem-check.sh`;
function memCheck() {
  if (MEM_CHECK === 'off' || !existsSync(MEM_CHECK)) return;
  try { execFileSync(MEM_CHECK, {encoding: 'utf8'}); }
  catch (e) {
    throw new Error(`${(e.stdout || e.message).trim()}: not starting Chrome (wait: mem-check.sh --wait --tries 1)`);
  }
}

// Start headless Chrome on port, or use one already listening there (then
// stop() leaves it running). Returns {port, stop}.
export async function startChrome({port = 9333, userDataDir = `${homedir()}/.cache/cdp-chrome`} = {}) {
  if (await version(port)) return {port, stop: async () => {}};
  memCheck();
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`, '--no-first-run', '--no-default-browser-check',
    '--disable-features=BackForwardCache',   // a form submit would keep the old page's event streams open: six connections are all there are
    'about:blank'],
    {stdio: 'ignore'});
  let exited = false;
  proc.on('exit', () => { exited = true; });
  for (let i = 0; i < 100 && !exited; i++) {
    if (await version(port)) {
      return {port, stop: async () => {
        proc.kill();
        for (let j = 0; j < 50 && !exited; j++) await sleep(100);
        if (!exited) proc.kill('SIGKILL');
      }};
    }
    await sleep(100);
  }
  proc.kill();
  throw new Error(`Chrome didn't start on port ${port} (inside the Bash sandbox? see the header)`);
}

// A new tab, with Page, Runtime and Log events on.
export async function openPage(port = 9333) {
  const r = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {method: 'PUT'});
  const target = await r.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error('CDP connect failed')); });
  const page = new Page(ws, port, target.id);
  await Promise.all(['Page.enable', 'Runtime.enable', 'Log.enable'].map((m) => page.send(m)));
  return page;
}

class Page {
  constructor(ws, port, id) {
    this.ws = ws; this.port = port; this.id = id;
    this.next = 1; this.calls = new Map(); this.listeners = new Map();
    this.errors = [];      // uncaught exceptions and console.error
    this.failedLoads = []; // resources that failed (404s and the like): {url, text}
    this.touch = false;
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id) {
        const c = this.calls.get(m.id); this.calls.delete(m.id);
        if (m.error) c.bad(new Error(`${c.method}: ${m.error.message}`)); else c.ok(m.result);
      } else {
        for (const f of this.listeners.get(m.method) || []) f(m.params);
      }
    };
    this.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails;
      this.errors.push('exception: ' + ((d.exception && d.exception.description) || d.text));
    });
    this.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error') this.errors.push('console.error: ' + p.args.map((a) => a.value ?? a.description).join(' '));
    });
    this.on('Log.entryAdded', (p) => {
      if (p.entry.level !== 'error') return;
      if (p.entry.source === 'network') this.failedLoads.push({url: p.entry.url || '', text: p.entry.text});
      else this.errors.push(`log: ${p.entry.text}${p.entry.url ? ' ' + p.entry.url : ''}`);
    });
  }

  send(method, params = {}) {
    const id = this.next++;
    this.ws.send(JSON.stringify({id, method, params}));
    return new Promise((ok, bad) => this.calls.set(id, {ok, bad, method}));
  }

  on(event, f) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(f);
  }

  once(event, timeout = 30000) {
    return new Promise((ok, bad) => {
      const t = setTimeout(() => bad(new Error(`timeout waiting for ${event}`)), timeout);
      const fs = this.listeners.get(event) || [];
      const f = (p) => { clearTimeout(t); fs.splice(fs.indexOf(f), 1); ok(p); };
      fs.push(f); this.listeners.set(event, fs);
    });
  }

  // Evaluate an expression in the page (awaits promises); returns its value.
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {expression: expr, awaitPromise: true, returnByValue: true});
    if (r.exceptionDetails) throw new Error(`eval ${expr}: ${(r.exceptionDetails.exception || {}).description || r.exceptionDetails.text}`);
    return r.result.value;
  }

  // Poll until expr is truthy; returns its value.
  async waitFor(expr, {timeout = 30000, every = 100, what = expr} = {}) {
    const end = Date.now() + timeout;
    for (;;) {
      let v;
      try { v = await this.eval(expr); } catch { v = undefined; }
      if (v) return v;
      if (Date.now() > end) throw new Error(`timeout (${timeout} ms) waiting for ${what}`);
      await sleep(every);
    }
  }

  // Navigate and wait for the load event.
  async goto(url, {timeout = 30000} = {}) {
    const loaded = this.once('Page.loadEventFired', timeout);
    const r = await this.send('Page.navigate', {url});
    if (r.errorText) throw new Error(`navigate ${url}: ${r.errorText}`);
    await loaded;
  }

  // The element's center in CSS pixels, scrolled into view.
  async center(selector) {
    const c = await this.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)});
      if (!e) return null; e.scrollIntoView({block: 'center', inline: 'center'});
      const r = e.getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height}; })()`);
    if (!c) throw new Error(`no element ${selector}`);
    if (!c.w || !c.h) throw new Error(`element ${selector} isn't shown`);
    return c;
  }

  // A real mouse click (or a tap, after phone()) at the element's center.
  async click(selector) {
    if (this.touch) return this.tap(selector);
    const {x, y} = await this.center(selector);
    const base = {x, y, button: 'left', clickCount: 1};
    await this.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x, y});
    await this.send('Input.dispatchMouseEvent', {type: 'mousePressed', ...base});
    await this.send('Input.dispatchMouseEvent', {type: 'mouseReleased', ...base});
  }

  async tap(selector) {
    const {x, y} = await this.center(selector);
    await this.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x, y}]});
    await this.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
  }

  // Emulate a phone (iPhone-sized, touch) from the next navigation on.
  async phone({width = 390, height = 844, scale = 3} = {}) {
    await this.send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: scale, mobile: true});
    await this.send('Emulation.setTouchEmulationEnabled', {enabled: true, maxTouchPoints: 5});
    await this.send('Emulation.setUserAgentOverride', {userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'});
    this.touch = true;
  }

  async desktop({width = 1400, height = 900} = {}) {
    await this.send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile: false});
  }

  async screenshot(path) {
    const r = await this.send('Page.captureScreenshot', {format: 'png'});
    writeFileSync(path, Buffer.from(r.data, 'base64'));
    return path;
  }

  async close() {
    this.ws.close();
    try { await fetch(`http://127.0.0.1:${this.port}/json/close/${this.id}`); } catch {}
  }
}
