// Shapes over the photo shown in the darkroom (dust spots now; erase and
// mask outlines later). An <svg> laid over the photo inside the view:
//   const ov = dtOverlay.create(view, () => ({rect, region}))
// rect is where the photo is drawn in the view (px: x, y, w, h), region the
// part of the photo shown, in fractions of the photo (left, top, right,
// bottom; 0..1 when it is all there). Shapes are in photo fractions:
//   {id, kind: "circle", x, y, r (fraction of the photo's width), cls, title}
//   {id, kind: "polygon", points: [[x, y], ...], cls, title}
// ov.set(items), ov.place() (after every render, resize or zoom),
// ov.setTransform(css) (follow a pan drag), ov.show(bool), ov.interactive(bool),
// ov.onclick((item | null, {x, y} | null, event) => ...), ov.remove().
// While interactive, shapes show a pointer and a tooltip, and a click on
// the view (not the end of a drag) is hit-tested here: the item under it, else
// the photo point. Circles are never drawn smaller than MIN_R px across.
const dtOverlay = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const MIN_R = 8;

  function create(view, geometry) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'photo-ov');
    view.append(svg);
    let items = [], handler = null, on = true, live = false, down = null;

    // photo fractions to px inside the svg, and the scale of a width fraction
    function map() {
      const {rect, region: R} = geometry();
      const kx = rect.w / (R.right - R.left), ky = rect.h / (R.bottom - R.top);
      return {rect, kx, ky, px: (x) => (x - R.left) * kx, py: (y) => (y - R.top) * ky, R};
    }
    const radius = (m, it) => Math.max(MIN_R, it.r * m.kx);

    function place() {
      const m = map();
      svg.style.transform = '';
      Object.assign(svg.style, {left: m.rect.x + 'px', top: m.rect.y + 'px', width: m.rect.w + 'px', height: m.rect.h + 'px'});
      svg.replaceChildren();
      svg.style.display = on ? '' : 'none';
      for (const it of items) {
        let el;
        if (it.kind === 'polygon') {
          el = document.createElementNS(NS, 'polygon');
          el.setAttribute('points', it.points.map(([x, y]) => `${m.px(x).toFixed(1)},${m.py(y).toFixed(1)}`).join(' '));
        } else {
          el = document.createElementNS(NS, 'circle');
          el.setAttribute('cx', m.px(it.x).toFixed(1)); el.setAttribute('cy', m.py(it.y).toFixed(1));
          el.setAttribute('r', radius(m, it).toFixed(1));
        }
        if (it.cls) el.setAttribute('class', it.cls);
        if (it.title) { const t = document.createElementNS(NS, 'title'); t.textContent = it.title; el.append(t); }
        svg.append(el);
      }
    }

    // the item under a client point: the nearest circle center inside its
    // radius, else a polygon containing it
    function hit(e) {
      const m = map(), b = view.getBoundingClientRect();
      const px = e.clientX - b.left - m.rect.x, py = e.clientY - b.top - m.rect.y;
      let best = null, bd = Infinity;
      for (const it of items) {
        if (it.kind === 'polygon') {
          let inside = false;
          const P = it.points.map(([x, y]) => [m.px(x), m.py(y)]);
          for (let i = 0, j = P.length - 1; i < P.length; j = i++)
            if ((P[i][1] > py) !== (P[j][1] > py) && px < (P[j][0] - P[i][0]) * (py - P[i][1]) / (P[j][1] - P[i][1]) + P[i][0]) inside = !inside;
          if (inside && bd > 0) { best = it; bd = 0; }
        } else {
          const d = Math.hypot(px - m.px(it.x), py - m.py(it.y));
          if (d <= radius(m, it) + 2 && d < bd) { best = it; bd = d; }
        }
      }
      const x = m.R.left + px / m.kx, y = m.R.top + py / m.ky;
      const inPhoto = px >= 0 && py >= 0 && px <= m.rect.w && py <= m.rect.h;
      return [best, inPhoto ? {x, y} : null];
    }

    const onDown = (e) => { down = [e.clientX, e.clientY]; };
    const onClick = (e) => {
      if (!live || !handler || e.button !== 0) return;
      // the end of a pan drag is not a click
      if (down && Math.abs(e.clientX - down[0]) + Math.abs(e.clientY - down[1]) > 4) return;
      const [it, pt] = hit(e);
      if (it || pt) handler(it, pt, e);
    };
    view.addEventListener('pointerdown', onDown, true);
    view.addEventListener('click', onClick);

    return {
      svg,
      set(list) { items = list; place(); },
      place,
      setTransform(css) { svg.style.transform = css; },
      show(b) { on = b; svg.style.display = b ? '' : 'none'; },
      interactive(b) { live = b; svg.classList.toggle('live', b); },
      onclick(fn) { handler = fn; },
      remove() {
        view.removeEventListener('pointerdown', onDown, true);
        view.removeEventListener('click', onClick);
        svg.remove();
      },
    };
  }

  return {create};
})();
