// Full screen view: the photo alone on black, from the lighttable and the
// darkroom. dtFull.open({images, index, more, query, first, onRated, onClose}):
//   images: [{id, version, rating, name, width?, height?}] (/api/collection)
//   more: a promise of the whole list, merged in when it comes; the view
//         opens at once, in the click, or the browser refuses full screen
//   first: {id, src}, the darkroom's preview of its photo (unsaved changes
//          included), shown instead of that photo's thumbnail
// The zoom and pan are static/zoomview.js (dtZoom).
window.dtFull = (() => {
  let current = null;

  function open(opts) {
    if (current) return;
    const images = opts.images;
    if (!images || !images.length) return;
    const dpr = window.devicePixelRatio || 1;
    let idx = Math.max(0, Math.min(images.length - 1, opts.index || 0));
    let loadToken = 0;
    let idleTimer = null, msgTimer = null, lastTouch = 0, lastTap = null;
    let inFs = false, closed = false;
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
    const z = dtZoom.create({box: el, layer, base, sharp, onZoom: (on) => el.classList.toggle('zoomed', on)});

    const listeners = [];
    const on = (t, type, fn, o) => { t.addEventListener(type, fn, o); listeners.push([t, type, fn, o]); };

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
      idx = i; draw(); z.setPhoto(images[i]);
      const token = ++loadToken, im = images[i];
      const img = new Image();
      img.onload = () => {
        if (token !== loadToken || closed) return;
        base.src = img.src;
        z.natural(img.naturalWidth, img.naturalHeight);
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
      else if (k === '+' || k === '=') { const v = z.state(); z.zoomAt(v.s * 1.25, v.W / 2, v.H / 2); }
      else if (k === '-' || k === '_') { const v = z.state(); z.zoomAt(v.s / 1.25, v.W / 2, v.H / 2); }
      else if (k === 'z' || k === 'Z') { if (!e.repeat) { const v = z.state(); z.toggleZoom(v.W / 2, v.H / 2); } }
    }, true);
    on(window, 'resize', () => { z.layout(); z.reset(); });

    // ── mouse: wheel (and trackpad pinch) zooms at the cursor, drag pans
    on(stage, 'wheel', (e) => {
      e.preventDefault();
      poke();
      z.zoomAt(z.state().s * dtZoom.wheelFactor(e), e.clientX, e.clientY);
    }, {passive: false});
    on(stage, 'dblclick', (e) => {
      if (Date.now() - lastTouch < 800) return;             // touch: the double tap below
      z.toggleZoom(e.clientX, e.clientY);
    });

    // ── pointers: pan, pinch, swipe, taps
    const ptr = new Map();
    let g = null;      // {x, y, s, tx, ty, moved, swipe, dx} of the gesture's start; pinch: d, mx, my
    function grab() {
      const [a, b] = [...ptr.values()];
      const v = z.state();
      g = {s: v.s, tx: v.tx, ty: v.ty, moved: true};
      if (b) Object.assign(g, {pinch: true, d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2});
      else Object.assign(g, {x: a.x, y: a.y, t: Date.now(), moved: false, touch: a.type !== 'mouse'});
    }
    on(stage, 'pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      poke();
      ptr.set(e.pointerId, {x: e.clientX, y: e.clientY, type: e.pointerType});
      if (e.pointerType !== 'mouse') lastTouch = Date.now();
      try { stage.setPointerCapture(e.pointerId); } catch (err) {}
      z.hideSharp();
      grab();
    });
    on(stage, 'pointermove', (e) => {
      const p = ptr.get(e.pointerId);
      if (!p || !g) return;
      p.x = e.clientX; p.y = e.clientY;
      if (g.pinch) {
        const [a, b] = [...ptr.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1, mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const s2 = Math.max(1, Math.min(z.maxS(), g.s * d / g.d));
        z.view(s2, mx - (g.mx - g.tx) * s2 / g.s, my - (g.my - g.ty) * s2 / g.s);
        return;
      }
      const dx = p.x - g.x, dy = p.y - g.y;
      if (!g.moved && Math.hypot(dx, dy) > 6) g.moved = true;
      if (!g.moved) return;
      if (z.state().s > 1.001) {
        z.view(g.s, g.tx + dx, g.ty + dy);
      } else if (g.touch && (g.swipe || Math.abs(dx) > Math.abs(dy))) {
        g.swipe = true; g.dx = dx;
        layer.style.transition = 'none';
        z.apply(dx);                                 // the photo follows the finger
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
      if (was.pinch) { z.changed(); return; }
      if (was.swipe) {
        const d = was.dx || 0;
        layer.style.transition = '';
        if (Math.abs(d) > 60 && e.type === 'pointerup' && images[idx + (d < 0 ? 1 : -1)]) go(d < 0 ? 1 : -1);
        else { layer.style.transition = 'transform .2s'; z.apply(); setTimeout(() => { layer.style.transition = ''; }, 220); }
        return;
      }
      if (z.zoomed()) z.changed();                        // pointerdown hid the sharp layer
      if (was.moved || p.type === 'mouse') return;
      // a tap: a second one close by is a double tap; any toggles the controls
      const now = Date.now();
      if (lastTap && now - lastTap.t < 350 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 30) {
        lastTap = null; z.toggleZoom(p.x, p.y);
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
      clearTimeout(idleTimer); clearTimeout(msgTimer);
      z.destroy(); loadToken++;
      for (const [t, type, fn, o] of listeners) t.removeEventListener(type, fn, o);
      const was = inFs;
      inFs = false;
      if (was) fs(() => (document.exitFullscreen || document.webkitExitFullscreen).call(document))?.catch?.(() => {});
      el.remove();
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
    z.layout();
    show(idx);
    poke();
    if (opts.more) opts.more.then((list) => {
      const k = list && !closed ? list.findIndex((x) => x.id === images[idx].id) : -1;
      if (k < 0) return;
      images.splice(0, images.length, ...list);
      idx = k; draw(); z.setSize(images[k].width, images[k].height);
      for (const j of [k + 1, k - 1]) if (images[j]) new Image().src = srcOf(images[j]);
    }, () => {});
  }

  return {open, get isOpen() { return !!current; }};
})();
