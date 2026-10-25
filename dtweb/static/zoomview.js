// Zoom and pan of a photo fitted in a box: a fitted <img> under a CSS
// transform (scale s >= 1 and a shift); zoomed in, a sharp render of the
// region in view (/api/photo/{id}/preview.jpg?zoom=) is laid over it.
// Used by the full screen view (fullview.js) and the lighttable preview.
window.dtZoom = (() => {
  const MAXZ = 2;            // the engine's largest zoom
  const fullW = {};          // photo id -> width in pixels, learned from region renders

  // box: the clipping element; layer: the transformed element holding base and sharp
  // (both <img>, placed by layout()); onZoom(zoomed): optional. Points are box-local pixels.
  function create({box, layer, base, sharp, onZoom}) {
    const dpr = window.devicePixelRatio || 1;
    let W = 0, H = 0, fw = 0, fh = 0, ox = 0, oy = 0;     // box, fitted photo, its offset
    let s = 1, tx = 0, ty = 0;
    let natW = 0, natH = 0;
    let photo = {id: 0, width: 0, height: 0};
    let sharpToken = 0, sharpTimer = null, sharpUrl = null;
    let wantZ = null;                   // an engine zoom asked for by zoomTo, until the view moves

    // ── layout and the view transform
    const maxS = () => Math.max(1, MAXZ * fullPx() / (fw * dpr || 1));
    function fullPx() {
      if (fullW[photo.id]) return fullW[photo.id];
      let w = photo.width, h = photo.height;
      if (w && h && natW && (w > h) !== (natW > natH)) w = h;     // orientation of the picture, not the sensor
      return w || 4 * natW || 1;
    }
    function layout() {
      W = box.clientWidth; H = box.clientHeight;
      if (!natW || !W || !H) return;
      const k = Math.min(W / natW, H / natH);
      fw = natW * k; fh = natH * k;
      ox = (W - fw) / 2; oy = (H - fh) / 2;
      Object.assign(base.style, {left: ox + 'px', top: oy + 'px', width: fw + 'px', height: fh + 'px'});
    }
    // keep the photo covering the box when it is bigger, centred when smaller
    function clampView() {
      s = Math.max(1, Math.min(maxS(), s));
      const fit = (size, off, len, t) => s * len >= size ? Math.max(size - s * (off + len), Math.min(-s * off, t)) : (1 - s) * size / 2;
      tx = fit(W, ox, fw, tx); ty = fit(H, oy, fh, ty);
    }
    function apply(extra) {
      layer.style.transform = `translate(${tx + (extra || 0)}px, ${ty}px) scale(${s})`;
      if (onZoom) onZoom(s > 1.001);
    }
    // the view changed: drop the sharp layer, fetch a new one when still
    function changed() {
      clampView(); apply(); hideSharp();
      if (s > 1.05) sharpTimer = setTimeout(() => requestSharp(false), 300);
    }
    function reset() { s = 1; tx = ty = 0; wantZ = null; apply(); hideSharp(); }
    function zoomRaw(s2, px, py) {
      s2 = Math.max(1, Math.min(maxS(), s2));
      tx = px - (px - tx) * s2 / s; ty = py - (py - ty) * s2 / s; s = s2;
      changed();
    }
    function zoomAt(s2, px, py) { wantZ = null; zoomRaw(s2, px, py); }
    // 100%: one photo pixel per device pixel (at least a bit more than fit)
    function toggleZoom(px, py) {
      wantZ = null;
      if (s > 1.05) { s = 1; tx = ty = 0; changed(); }
      else zoomRaw(Math.min(maxS(), Math.max(1.5, fullPx() / (fw * dpr))), px, py);
    }
    // an engine zoom (1 = 100%, 2 = 200%) around a point (default the centre)
    function zoomTo(Z, px, py) {
      if (px === undefined) { px = W / 2; py = H / 2; }
      zoomRaw(Z * fullPx() / ((fw * dpr) || 1), px, py);
      wantZ = Z;
    }
    function view(s2, tx2, ty2) { wantZ = null; s = s2; tx = tx2; ty = ty2; clampView(); apply(); }

    // ── the sharp layer
    function hideSharp() {
      sharpToken++; clearTimeout(sharpTimer);
      sharp.hidden = true;
    }
    async function requestSharp(retry) {
      const id = photo.id, token = ++sharpToken;
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
        if (wantZ) {                                  // size known now: the zoom asked for, around the centre
          const s2 = Math.max(1, Math.min(maxS(), wantZ * fullPx() / (fw * dpr)));
          tx = W / 2 - (W / 2 - tx) * s2 / s; ty = H / 2 - (H / 2 - ty) * s2 / s; s = s2;
          clampView(); apply();
        }
        if (s > maxS()) { changed(); return; }       // the view changed: a new request follows
        requestSharp(true);
      }
    }

    function setPhoto(p) { photo = {id: p.id, width: p.width || 0, height: p.height || 0}; reset(); }
    function natural(w, h) { natW = w; natH = h; layout(); reset(); }
    function destroy() {
      clearTimeout(sharpTimer); sharpToken++;
      if (sharpUrl) URL.revokeObjectURL(sharpUrl);
      sharpUrl = null;
    }
    const local = (cx, cy) => { const r = box.getBoundingClientRect(); return [cx - r.left, cy - r.top]; };
    return {setPhoto, setSize(w, h) { photo.width = w || 0; photo.height = h || 0; }, natural, layout, reset, changed, apply,
            clampView, zoomAt, toggleZoom, hideSharp, zoomTo, view, maxS, local, destroy,
            state: () => ({s, tx, ty, W, H}), zoomed: () => s > 1.05, wantZ: () => wantZ};
  }

  // wheel (and trackpad pinch) → the factor to scale by
  function wheelFactor(e) {
    const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
    return Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.002));
  }
  return {create, wheelFactor};
})();
