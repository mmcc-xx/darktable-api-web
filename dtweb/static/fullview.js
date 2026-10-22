// Full screen view: the photo alone on black, from the lighttable and the
// darkroom. dtFull.open({images, index, more, query, first, onRated, onClose}):
//   images: [{id, version, rating, name, width?, height?}] (/api/collection)
//   more: a promise of the whole list, merged in when it comes; the view
//         opens at once, in the click, or the browser refuses full screen
//   first: {id, src}, the darkroom's preview of its photo (unsaved changes
//          included), shown instead of that photo's thumbnail
// The fitted photo is one <img> under a CSS transform (scale s >= 1 and a
// shift); zoomed in, a sharp render of the region on screen is laid over it.
window.dtFull = (() => {
  let current = null;

  function open(opts) {
    if (current) return;
    const images = opts.images;
    if (!images || !images.length) return;
    const dpr = window.devicePixelRatio || 1;
    const MAXZ = 2;                     // the engine's largest zoom
    let idx = Math.max(0, Math.min(images.length - 1, opts.index || 0));
    let W = 0, H = 0, fw = 0, fh = 0, ox = 0, oy = 0;     // screen, fitted photo, its offset
    let s = 1, tx = 0, ty = 0;
    let natW = 0, natH = 0;
    let loadToken = 0, sharpToken = 0, sharpTimer = null, sharpUrl = null;
    let idleTimer = null, msgTimer = null, lastTouch = 0, lastTap = null;
    let inFs = false, closed = false;
    const fullW = {};                   // photo id -> width in pixels, learned from region renders
    const fs = (cb) => { try { return cb(); } catch (e) { return undefined; } };

    const cls = (tag, c, text) => { const e = document.createElement(tag); e.className = c; if (text !== undefined) e.textContent = text; return e; };
    const el = cls('div', 'fullview');
    const stage = cls('div', 'fv-stage');
    const layer = cls('div', 'fv-layer');
    const base = cls('img', 'fv-base'), sharp = cls('img', 'fv-sharp');
    base.draggable = sharp.draggable = false;
    base.alt = '';
    sharp.hidden = true;
    layer.append(base, sharp);
    stage.append(layer);
    const top = cls('div', 'fv-bar fv-top fv-ui');
    const nameEl = cls('span', 'fv-name'), countEl = cls('span', 'fv-count'), msgEl = cls('span', 'fv-msg');
    const closeBtn = cls('button', 'fv-btn', '✕'); closeBtn.title = 'close (Esc)'; closeBtn.setAttribute('aria-label', 'close');
    top.append(nameEl, countEl, msgEl, closeBtn);
    const bottom = cls('div', 'fv-bar fv-bottom fv-ui');
    const rej = cls('button', 'fv-btn fv-rej', '✕'); rej.title = 'reject (r)'; rej.dataset.rate = 'reject';
    bottom.append(rej);
    const stars = [];
    for (let n = 1; n <= 5; n++) {
      const b = cls('button', 'fv-btn fv-star', '★'); b.title = `${n} (key ${n})`; b.dataset.rate = n;
      stars.push(b); bottom.append(b);
    }
    const prevBtn = cls('button', 'fv-btn fv-nav fv-prev fv-ui', '‹'), nextBtn = cls('button', 'fv-btn fv-nav fv-next fv-ui', '›');
    prevBtn.title = 'previous (←)'; nextBtn.title = 'next (→)';
    el.append(stage, top, bottom, prevBtn, nextBtn);

    const listeners = [];
    const on = (t, type, fn, o) => { t.addEventListener(type, fn, o); listeners.push([t, type, fn, o]); };

    // ── layout and the view transform
    const maxS = () => Math.max(1, MAXZ * fullPx() / (fw * dpr || 1));
    function fullPx() {
      const im = images[idx];
      if (fullW[im.id]) return fullW[im.id];
      let w = im.width, h = im.height;
      if (w && h && natW && (w > h) !== (natW > natH)) w = h;     // orientation of the picture, not the sensor
      return w || 4 * natW || 1;
    }
    function layout() {
      W = el.clientWidth; H = el.clientHeight;
      if (!natW || !W || !H) return;
      const k = Math.min(W / natW, H / natH);
      fw = natW * k; fh = natH * k;
      ox = (W - fw) / 2; oy = (H - fh) / 2;
      Object.assign(base.style, {left: ox + 'px', top: oy + 'px', width: fw + 'px', height: fh + 'px'});
    }
    // keep the photo covering the screen when it is bigger, centred when smaller
    function clampView() {
      s = Math.max(1, Math.min(maxS(), s));
      const fit = (size, off, len, t) => s * len >= size ? Math.max(size - s * (off + len), Math.min(-s * off, t)) : (1 - s) * size / 2;
      tx = fit(W, ox, fw, tx); ty = fit(H, oy, fh, ty);
    }
    function apply(extra) {
      layer.style.transform = `translate(${tx + (extra || 0)}px, ${ty}px) scale(${s})`;
      el.classList.toggle('zoomed', s > 1.001);
    }
    // the view changed: drop the sharp layer, fetch a new one when still
    function changed() {
      clampView(); apply(); hideSharp();
      if (s > 1.05) sharpTimer = setTimeout(() => requestSharp(false), 300);
    }
    function reset() { s = 1; tx = ty = 0; apply(); hideSharp(); }
    function zoomAt(s2, px, py) {
      s2 = Math.max(1, Math.min(maxS(), s2));
      tx = px - (px - tx) * s2 / s; ty = py - (py - ty) * s2 / s; s = s2;
      changed();
    }
    // 100%: one photo pixel per device pixel (at least a bit more than fit)
    function toggleZoom(px, py) {
      if (s > 1.05) { s = 1; tx = ty = 0; changed(); }
      else zoomAt(Math.min(maxS(), Math.max(1.5, fullPx() / (fw * dpr))), px, py);
    }

    // ── the sharp layer
    function hideSharp() {
      sharpToken++; clearTimeout(sharpTimer);
      sharp.hidden = true;
    }
    async function requestSharp(retry) {
      const id = images[idx].id, token = ++sharpToken;
      const Z = Math.min(MAXZ, s * fw * dpr / fullPx());
      const lx = (W / 2 - tx) / s, ly = (H / 2 - ty) / s;
      const cx = Math.max(0, Math.min(1, (lx - ox) / fw)), cy = Math.max(0, Math.min(1, (ly - oy) / fh));
      const vw = Math.min(3200, Math.round(W * dpr)), vh = Math.min(3200, Math.round(H * dpr));
      let r;
      try {
        r = await fetch(`/api/photo/${id}/preview.jpg?w=${vw}&h=${vh}&zoom=${Z.toFixed(4)}&cx=${cx.toFixed(5)}&cy=${cy.toFixed(5)}`);
      } catch (e) { return; }
      if (token !== sharpToken || r.status === 204 || !r.ok) return;
      const reg = r.headers.get('X-Region');
      if (!reg) return;
      const R = JSON.parse(reg), blob = await r.blob();
      if (token !== sharpToken) return;
      const url = URL.createObjectURL(blob), probe = new Image();
      probe.src = url;
      try { await probe.decode(); } catch (e) { URL.revokeObjectURL(url); return; }
      if (token !== sharpToken) { URL.revokeObjectURL(url); return; }
      // the photo's real size, from what the region shows
      const real = probe.naturalWidth / (Z * (R.right - R.left));
      const guess = fullPx();
      if (real > 0 && isFinite(real)) fullW[id] = real;
      Object.assign(sharp.style, {left: ox + R.left * fw + 'px', top: oy + R.top * fh + 'px',
                                  width: (R.right - R.left) * fw + 'px', height: (R.bottom - R.top) * fh + 'px'});
      sharp.src = url;
      sharp.hidden = false;
      if (sharpUrl) URL.revokeObjectURL(sharpUrl);
      sharpUrl = url;
      if (!retry && real > 0 && Math.abs(guess / real - 1) > 0.1) {
        if (s > maxS()) { changed(); return; }       // the view changed: a new request follows
        requestSharp(true);
      }
    }

    // ── showing a photo
    const thumbSize = Math.min(2048, Math.ceil(Math.max(screen.width, screen.height) * dpr / 256) * 256);
    const srcOf = (im) => opts.first && opts.first.id === im.id ? opts.first.src
      : `/thumb/${im.id}/${im.version}.jpg?size=${thumbSize}`;
    function ratingOf(im) { return im.rating === 'reject' ? 'reject' : +im.rating || 0; }
    function draw() {
      const im = images[idx], r = ratingOf(im);
      nameEl.textContent = im.name || '';
      countEl.textContent = `${idx + 1} / ${images.length}`;
      rej.classList.toggle('on', r === 'reject');
      stars.forEach((b, i) => b.classList.toggle('on', r !== 'reject' && r >= i + 1));
      prevBtn.hidden = idx === 0; nextBtn.hidden = idx === images.length - 1;
    }
    function show(i) {
      idx = i; draw(); reset();
      const token = ++loadToken, im = images[i];
      const img = new Image();
      img.onload = () => {
        if (token !== loadToken || closed) return;
        natW = img.naturalWidth; natH = img.naturalHeight;
        base.src = img.src;
        layout(); reset();
      };
      img.onerror = () => { if (token === loadToken) flash('the photo did not load'); };
      img.src = srcOf(im);
      for (const j of [i + 1, i - 1]) {          // warm the cache for the neighbours
        if (images[j] && !(opts.first && opts.first.id === images[j].id)) new Image().src = srcOf(images[j]);
      }
    }
    const go = (d) => { const i = idx + d; if (i >= 0 && i < images.length) show(i); };

    // ── messages, rating
    function flash(text) {
      msgEl.textContent = text;
      clearTimeout(msgTimer);
      msgTimer = setTimeout(() => { msgEl.textContent = ''; }, 3500);
    }
    async function rate(v) {
      const im = images[idx];
      try {
        const r = await fetch(`/api/photo/${im.id}/rating?${opts.query || ''}`, {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({rating: v === 'reject' ? 'reject' : parseInt(v)})});
        if (!r.ok) {
          let d = ''; try { d = (await r.json()).detail; } catch (e) {}
          return flash(d || `rating failed (${r.status})`);
        }
        const html = await r.text();
        const t = document.createElement('template');
        t.innerHTML = html;
        const fig = t.content.querySelector('[data-rating]');
        if (fig) im.rating = fig.dataset.rating === 'reject' ? 'reject' : parseInt(fig.dataset.rating);
        if (images[idx] === im) draw();
        if (opts.onRated) opts.onRated(im.id, html);
      } catch (e) { flash('rating failed: ' + e.message); }
    }
    on(bottom, 'click', (e) => { const b = e.target.closest('[data-rate]'); if (b) { rate(b.dataset.rate); b.blur(); } });
    on(prevBtn, 'click', () => { go(-1); prevBtn.blur(); });
    on(nextBtn, 'click', () => { go(1); nextBtn.blur(); });
    on(closeBtn, 'click', close);

    // ── controls fade out
    function poke() {
      el.classList.remove('idle');
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => el.classList.add('idle'), 2500);
    }
    on(el, 'pointermove', (e) => { if (e.pointerType === 'mouse') poke(); });
    on(el, 'contextmenu', (e) => e.preventDefault());
    on(el, 'dragstart', (e) => e.preventDefault());

    // ── keys: all of them are ours while open
    on(window, 'keydown', (e) => {
      e.stopPropagation();
      if (e.metaKey || e.ctrlKey || e.altKey) return;      // browser shortcuts keep working
      const k = e.key;
      poke();
      e.preventDefault();
      if (k === 'ArrowRight' || k === 'PageDown') go(1);
      else if (k === 'ArrowLeft' || k === 'PageUp') go(-1);
      else if (/^[0-5]$/.test(k)) rate(k);
      else if (k === 'r' || k === 'R') rate('reject');
      else if (k === 'Escape' || k === 'f' || k === 'F') { if (!e.repeat) close(); }
      else if (k === '+' || k === '=') zoomAt(s * 1.25, W / 2, H / 2);
      else if (k === '-' || k === '_') zoomAt(s / 1.25, W / 2, H / 2);
      else if (k === 'z' || k === 'Z') { if (!e.repeat) toggleZoom(W / 2, H / 2); }
    }, true);
    on(window, 'resize', () => { layout(); reset(); });

    // ── mouse: wheel (and trackpad pinch) zooms at the cursor, drag pans
    on(stage, 'wheel', (e) => {
      e.preventDefault();
      poke();
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
      zoomAt(s * Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.002)), e.clientX, e.clientY);
    }, {passive: false});
    on(stage, 'dblclick', (e) => {
      if (Date.now() - lastTouch < 800) return;             // touch: the double tap below
      toggleZoom(e.clientX, e.clientY);
    });

    // ── pointers: pan, pinch, swipe, taps
    const ptr = new Map();
    let g = null;      // {x, y, s, tx, ty, moved, swipe, dx} of the gesture's start; pinch: d, mx, my
    function grab() {
      const [a, b] = [...ptr.values()];
      g = {s, tx, ty, moved: true};
      if (b) Object.assign(g, {pinch: true, d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2});
      else Object.assign(g, {x: a.x, y: a.y, t: Date.now(), moved: false, touch: a.type !== 'mouse'});
    }
    on(stage, 'pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      poke();
      ptr.set(e.pointerId, {x: e.clientX, y: e.clientY, type: e.pointerType});
      if (e.pointerType !== 'mouse') lastTouch = Date.now();
      try { stage.setPointerCapture(e.pointerId); } catch (err) {}
      hideSharp();
      grab();
    });
    on(stage, 'pointermove', (e) => {
      const p = ptr.get(e.pointerId);
      if (!p || !g) return;
      p.x = e.clientX; p.y = e.clientY;
      if (g.pinch) {
        const [a, b] = [...ptr.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1, mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const s2 = Math.max(1, Math.min(maxS(), g.s * d / g.d));
        tx = mx - (g.mx - g.tx) * s2 / g.s; ty = my - (g.my - g.ty) * s2 / g.s; s = s2;
        clampView(); apply();
        return;
      }
      const dx = p.x - g.x, dy = p.y - g.y;
      if (!g.moved && Math.hypot(dx, dy) > 6) g.moved = true;
      if (!g.moved) return;
      if (s > 1.001) {
        tx = g.tx + dx; ty = g.ty + dy;
        clampView(); apply();
      } else if (g.touch && (g.swipe || Math.abs(dx) > Math.abs(dy))) {
        g.swipe = true; g.dx = dx;
        layer.style.transition = 'none';
        apply(dx);                                   // the photo follows the finger
      }
    });
    function release(e) {
      const p = ptr.get(e.pointerId);
      if (!p) return;
      ptr.delete(e.pointerId);
      const was = g;
      if (ptr.size) { grab(); g.moved = true; return; }   // one finger left a pinch: pan on
      g = null;
      if (!was) return;
      if (was.pinch) { changed(); return; }
      if (was.swipe) {
        const d = was.dx || 0;
        layer.style.transition = '';
        if (Math.abs(d) > 60 && e.type === 'pointerup' && images[idx + (d < 0 ? 1 : -1)]) go(d < 0 ? 1 : -1);
        else { layer.style.transition = 'transform .2s'; apply(); setTimeout(() => { layer.style.transition = ''; }, 220); }
        return;
      }
      if (s > 1.05) changed();                        // pointerdown hid the sharp layer
      if (was.moved || p.type === 'mouse') return;
      // a tap: a second one close by is a double tap; any toggles the controls
      const now = Date.now();
      if (lastTap && now - lastTap.t < 350 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 30) {
        lastTap = null; toggleZoom(p.x, p.y);
      } else {
        lastTap = {t: now, x: p.x, y: p.y};
        if (el.classList.contains('idle')) poke();
        else { el.classList.add('idle'); clearTimeout(idleTimer); }
      }
    }
    on(stage, 'pointerup', release);
    on(stage, 'pointercancel', release);

    // ── fullscreen, and leaving it
    on(document, 'fullscreenchange', () => { if (inFs && !document.fullscreenElement) close(); });
    on(document, 'webkitfullscreenchange', () => { if (inFs && !document.webkitFullscreenElement && !document.fullscreenElement) close(); });

    // ── closing
    function close() {
      if (closed) return;
      closed = true; current = null;
      const id = images[idx].id;
      clearTimeout(idleTimer); clearTimeout(msgTimer); clearTimeout(sharpTimer);
      sharpToken++; loadToken++;
      for (const [t, type, fn, o] of listeners) t.removeEventListener(type, fn, o);
      const was = inFs;
      inFs = false;
      if (was) fs(() => (document.exitFullscreen || document.webkitExitFullscreen).call(document))?.catch?.(() => {});
      el.remove();
      if (sharpUrl) URL.revokeObjectURL(sharpUrl);
      document.body.style.overflow = bodyOverflow;
      document.documentElement.style.overflow = rootOverflow;
      if (opts.onClose) opts.onClose(id);
    }

    // ── go
    const bodyOverflow = document.body.style.overflow, rootOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = document.documentElement.style.overflow = 'hidden';
    current = {close};
    document.body.append(el);
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (req) {
      try {
        Promise.resolve(req.call(el)).then(() => { inFs = !closed; if (closed) fs(() => document.exitFullscreen())?.catch?.(() => {}); },
                                           () => {});    // refused (iPhone Safari): the fixed overlay does
      } catch (e) {}
    }
    W = el.clientWidth; H = el.clientHeight;
    show(idx);
    poke();
    if (opts.more) opts.more.then((list) => {
      const k = list && !closed ? list.findIndex((x) => x.id === images[idx].id) : -1;
      if (k < 0) return;
      images.splice(0, images.length, ...list);
      idx = k; draw();
      for (const j of [k + 1, k - 1]) if (images[j]) new Image().src = srcOf(images[j]);
    }, () => {});
  }

  return {open, get isOpen() { return !!current; }};
})();
