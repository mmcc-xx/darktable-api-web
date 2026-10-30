// The backlog page: sort a table by its header, expand long items, and the
// writes (edit, add, queue, move, unqueue). Every write answers with the new
// commit; the page then reloads the tab (new hashes) and shows it in a toast.
(function () {
  const root = document.getElementById('bl'), dlg = document.getElementById('bl-dlg'),
        form = document.getElementById('bl-form'), toast = document.getElementById('bl-toast');
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const SCORES = ['Value', 'Time', 'Risk/enable', 'Size'];

  function showToast(text) {
    toast.textContent = text;
    toast.classList.add('on');
    setTimeout(() => toast.classList.remove('on'), 5000);
  }
  try { const t = sessionStorage.getItem('bl-toast'); if (t) { sessionStorage.removeItem('bl-toast'); showToast(t); } } catch (e) {}

  // sorting: the first click sorts ascending (numbers: high first), the next flips it, the third restores file order
  document.querySelectorAll('table.bl th[data-type]').forEach((th) => th.onclick = () => {
    const table = th.closest('table'), body = table.tBodies[0], col = th.cellIndex, type = th.dataset.type;
    const state = th.classList.contains('asc') ? 'asc' : th.classList.contains('desc') ? 'desc' : '';
    table.querySelectorAll('th').forEach((h) => h.classList.remove('asc', 'desc'));
    const next = state === '' ? (type === 'txt' ? 'asc' : 'desc') : state === (type === 'txt' ? 'asc' : 'desc') ? (type === 'txt' ? 'desc' : 'asc') : '';
    const rows = [...body.rows];
    if (next === '') rows.sort((a, b) => a.dataset.i - b.dataset.i);
    else {
      th.classList.add(next);
      const key = (r) => { const v = r.cells[col].dataset.sort; return type === 'txt' ? v : v === '' ? null : parseFloat(v); };
      rows.sort((a, b) => {
        const x = key(a), y = key(b);
        if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;     // blanks last either way
        const c = type === 'txt' ? x.localeCompare(y) : x - y;
        return (next === 'asc' ? c : -c) || a.dataset.i - b.dataset.i;
      });
    }
    rows.forEach((r) => body.appendChild(r));
  });
  root.addEventListener('click', (e) => {
    const clip = e.target.closest('.clip');
    if (clip && !e.target.closest('a')) clip.classList.toggle('open');
  });

  async function post(path, body) {
    let r, j = {};
    try { r = await fetch('/api/backlog/' + path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)}); j = await r.json(); }
    catch (err) { await tell('The server did not answer: ' + err.message); return null; }
    if (r.ok) {
      const text = (j.commit ? `committed ${j.commit}` : j.changed === false ? 'nothing changed' : 'written') + (j.warning ? ` (${j.warning})` : '');
      try { sessionStorage.setItem('bl-toast', text); } catch (err) {}
      location.reload();
      return j;
    }
    if (r.status === 409 && j.current !== undefined) { conflict(j); return null; }
    await tell(j.error || j.detail || `error ${r.status}`);
    return null;
  }

  function conflict(j) {
    form.innerHTML = `<h3>Conflict</h3><p>${esc(j.error)}</p><label>current in the file</label><pre id="bl-cur">${esc(j.current || '(gone)')}</pre>` +
      `<label>yours</label><pre id="bl-yours">${esc(j.yours)}</pre>` +
      '<div class="btns"><button value="">close</button><button value="reload" class="primary">reload the tab</button></div>';
    dlg.onclose = () => { if (dlg.returnValue === 'reload') location.reload(); };
    dlg.showModal();
  }

  function field(name, label, value, tag) {
    const input = tag === 'textarea' ? `<textarea name="${name}" rows="6">${esc(value)}</textarea>` : `<input name="${name}" value="${esc(value)}">`;
    return `<label>${esc(label)}</label>${input}`;
  }

  function editDialog(tr) {
    const file = tr.closest('table').dataset.file, cells = JSON.parse(tr.dataset.cells);
    const cols = file === 'features' ? ['Area', ...SCORES, 'Est'] : ['Area', 'Severity', 'Found', 'Est'];
    const sev = (v) => `<label>Severity</label><select name="Severity">${['high', 'medium', 'low'].map((s) => `<option${s === v ? ' selected' : ''}>${s}</option>`).join('')}</select>`;
    form.innerHTML = `<h3>Edit ${esc(tr.dataset.id)}</h3>${field('Item', 'Item', cells.Item, 'textarea')}` +
      (file === 'features' ? '<div class="grid4">' + SCORES.map((c) => `<div>${field(c, c, cells[c])}</div>`).join('') + '</div>' + field('Area', 'Area', cells.Area) + field('Est', 'Est', cells.Est)
        : field('Area', 'Area', cells.Area) + sev(cells.Severity) + field('Found', 'Found', cells.Found) + field('Est', 'Est', cells.Est)) +
      '<div class="btns"><button value="">cancel</button><button value="ok" class="primary">save</button></div>';
    dlg.onclose = () => {
      if (dlg.returnValue !== 'ok') return;
      const out = {};
      for (const el of form.elements) if (el.name && el.value !== cells[el.name]) out[el.name] = el.value;
      post('edit', {file, id: tr.dataset.id, row_hash: tr.dataset.hash, cells: out});
    };
    dlg.showModal();
  }

  function addDialog(kind) {
    form.innerHTML = '<h3>Add an item</h3><label>kind</label><select name="kind"><option value="feature">feature (FEATURES.md)</option><option value="bug">bug (BUGS.md)</option></select>' +
      '<label>numbered</label><select name="series"><option value="#">#N (engine, MCP, scripts)</option><option value="W">WN (web app)</option></select>' +
      field('title', 'title', '') + field('text', 'description (one line)', '', 'textarea') + field('area', 'area', '') +
      '<div id="bl-sc" class="grid4">' + SCORES.map((c) => `<div>${field(c, c + ' (number or ?)', '')}</div>`).join('') + '</div>' +
      '<div id="bl-sv" hidden><label>severity</label><select name="severity"><option>high</option><option selected>medium</option><option>low</option></select></div>' +
      '<div class="btns"><button value="">cancel</button><button value="ok" class="primary">add</button></div>';
    const sync = () => { const b = form.elements.kind.value === 'bug'; document.getElementById('bl-sc').hidden = b; document.getElementById('bl-sv').hidden = !b; };
    form.elements.kind.value = kind; form.elements.kind.onchange = sync; sync();
    dlg.onclose = () => {
      if (dlg.returnValue !== 'ok') return;
      const f = form.elements, scores = {};
      SCORES.forEach((c) => { if (f[c].value.trim()) scores[c] = f[c].value; });
      post('add', {kind: f.kind.value, series: f.series.value, title: f.title.value, text: f.text.value, area: f.area.value,
                   scores: f.kind.value === 'feature' ? scores : null, severity: f.kind.value === 'bug' ? f.severity.value : null});
    };
    dlg.showModal();
  }

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act, tr = b.closest('tr'), item = b.closest('.bl-item');
    if (act === 'edit') editDialog(tr);
    else if (act === 'add') addDialog(b.dataset.kind);
    else if (act === 'queue') { b.disabled = true; post('queue', {id: tr.dataset.id, file: tr.closest('table').dataset.file}).then((j) => { if (!j) b.disabled = false; }); }
    else if (act === 'move') post('move', {label: item.dataset.label, dir: b.dataset.dir, queue_hash: root.dataset.qhash});
    else if (act === 'unqueue') {
      if (await ask(`Move ${item.dataset.label} to Deferred? Its text is kept.`, {ok: 'unqueue'}))
        post('unqueue', {label: item.dataset.label, queue_hash: root.dataset.qhash});
    }
  });
})();
