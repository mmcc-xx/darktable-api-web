// The backlog page: sort a table by its header, expand long items, and the
// writes (edit, add, queue, move, unqueue; ideas: delete), and the night run's cap and run now. Every write answers with the new
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
    if (r.ok && j.mentions && j.mentions.length) {      // a deleted idea: show where it is still named, then reload
      form.innerHTML = `<h3>Deleted ${esc(j.deleted)}</h3><p>${esc(j.commit ? 'committed ' + j.commit : j.warning || 'written')}. Still mentioned in:</p>` +
        `<pre>${j.mentions.map((m) => esc(`${m.file}:${m.line}: ${m.text}`)).join('\n')}</pre>` +
        '<div class="btns"><button value="" class="primary">close</button></div>';
      dlg.onclose = () => location.reload();
      dlg.showModal();
      return j;
    }
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

  function ideaDialog(tr) {
    const cells = JSON.parse(tr.dataset.cells), desc = tr.dataset.desc ? JSON.parse(tr.dataset.desc) : null;
    form.innerHTML = `<h3>Edit ${esc(tr.dataset.id)}</h3>${field('Idea', 'Idea', cells.Idea)}` +
      '<div class="grid4">' + SCORES.map((c) => `<div>${field(c, c, cells[c])}</div>`).join('') + '</div>' + field('Serves', 'Serves', cells.Serves) +
      (desc ? field('description', 'description (after the bold lead; rewrapped)', desc.text, 'textarea') +
        (desc.shared ? `<p class="shared">This bullet is shared: ${esc(desc.shared)}</p>` : '') : '<p class="shared">No description bullet in IDEAS.md.</p>') +
      '<div class="btns"><button value="">cancel</button><button value="ok" class="primary">save</button></div>';
    dlg.onclose = () => {
      if (dlg.returnValue !== 'ok') return;
      const out = {}, body = {file: 'ideas', id: tr.dataset.id, row_hash: tr.dataset.hash, cells: out};
      for (const el of form.elements) if (el.name && el.name !== 'description' && el.value !== cells[el.name]) out[el.name] = el.value;
      const d = form.elements.description;
      if (desc && d && d.value.trim().split(/\s+/).join(' ') !== desc.text) Object.assign(body, {description: d.value, desc_hash: desc.hash});
      post('edit', body);
    };
    dlg.showModal();
  }

  function addIdeaDialog() {
    const themes = JSON.parse(root.dataset.themes || '[]'), def = 'From the web page';
    if (!themes.includes(def)) themes.push(def);
    form.innerHTML = '<h3>Add an idea</h3><label>numbered</label><select name="series"><option value="I">IN (general)</option><option value="P">PN (printing)</option></select>' +
      field('title', 'title', '') + field('text', 'description', '', 'textarea') + field('area', 'serves', '') +
      `<label>section for the description</label><select name="section">${themes.map((t) => `<option${t === def ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>` +
      '<div class="grid4">' + SCORES.map((c) => `<div>${field(c, c + ' (number or ?)', '')}</div>`).join('') + '</div>' +
      '<div class="btns"><button value="">cancel</button><button value="ok" class="primary">add</button></div>';
    dlg.onclose = () => {
      if (dlg.returnValue !== 'ok') return;
      const f = form.elements, scores = {};
      SCORES.forEach((c) => { if (f[c].value.trim()) scores[c] = f[c].value; });
      post('add', {kind: 'idea', series: f.series.value, title: f.title.value, text: f.text.value, area: f.area.value, section: f.section.value, scores});
    };
    dlg.showModal();
  }

  function editDialog(tr) {
    const file = tr.closest('table').dataset.file, cells = JSON.parse(tr.dataset.cells);
    if (file === 'ideas') return ideaDialog(tr);
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

  // The queue's capacity uses the last week % known; read it now (/usage, a few
  // seconds) and, if it moved, swap in the tab as it renders with it.
  const capBar = root.querySelector('.bl-cap');
  if (root.dataset.tab === 'queue' && capBar) {
    fetch('/api/backlog/usage').then((r) => r.json()).then(async (j) => {
      if (j.week == null || j.week === parseFloat(capBar.dataset.week) || document.querySelector('dialog[open]')) return;
      const doc = new DOMParser().parseFromString(await (await fetch('/backlog?f=queue')).text(), 'text/html');
      const fresh = doc.getElementById('bl');
      if (fresh && !document.querySelector('dialog[open]')) { root.innerHTML = fresh.innerHTML; root.dataset.qhash = fresh.dataset.qhash; const rb = document.getElementById('bl-run'); if (rb) renderRun(JSON.parse(rb.dataset.run)); }
    }).catch(() => {});
  }

  // The night run (W66): today's cap (launchd/.cap-<date>, read by a run when
  // it starts), run queue now (kickstart), and what a run is doing; polled.
  // (looked up each time: the usage refresh above swaps the tab's HTML)
  const runEl = document.getElementById('bl-run');
  let run = runEl ? JSON.parse(runEl.dataset.run) : null, runTimer = null;
  function renderRun(st) {
    run = st;
    const runBar = document.getElementById('bl-run'), runStatus = document.getElementById('bl-run-status');
    if (!runBar) return;
    const capIn = document.getElementById('bl-cap-in'), pct = (x) => `${Math.round(x * 10) / 10}%`;
    if (document.activeElement !== capIn) capIn.value = st.cap;
    runBar.querySelector('[data-act="cap-reset"]').hidden = st.override == null;
    runBar.querySelector('[data-act="cap-reset"]').textContent = `back to ${st.week_cap}%`;
    document.getElementById('bl-cap-info').textContent =
      (st.override != null ? `set for ${st.date} (from the weekly reset: ${st.week_cap}%)` : `day ${st.day} of the week`) +
      (st.week != null ? `; week ${pct(st.week)} used` : '') +
      (st.held ? `; a change applies to runs started after this one${st.run_cap != null ? ` (it runs with ${st.run_cap}%)` : ''}` : '');
    const go = runBar.querySelector('[data-act="run-now"]');
    go.disabled = st.held || !st.open;
    go.title = st.held ? 'a night run is going' : !st.open ? 'the queue has no open item' : `start the night run now (${st.item} first)`;
    let s = st.held ? `<b>running</b>${st.item ? ' ' + esc(st.item) : ''}${st.item_since ? ' since ' + esc(st.item_since.slice(11, 16)) : ''}` +
                      ` (night run since ${esc((st.since || '').slice(5, 16))}, pid ${esc(st.pid ?? '?')})`
          : st.open ? `no run going; next: ${esc(st.item)} (${st.open} open)` : 'no run going; the queue is empty';
    if (st.stale) s += `; stale lock (pid ${esc(st.pid)} gone, the next run removes it)`;
    if (!st.held && st.open && st.week != null && st.week >= st.cap - 1) s += `; <span class="warn">the week is at the cap: a run would stop at once</span>`;
    if (st.last) s += `<br>${esc(st.note)}: ${esc(st.last)}`;
    runStatus.innerHTML = s;
    renderDash(st.dash);
  }
  // What the run scripts last wrote (W73, launchd/.run-status.json): running or
  // why not, the caps, session and week used, the item, and how old that is.
  const DASH_STATES = {starting: 'Starting', running: 'Running', waiting: 'Waiting', finishing: 'Finishing up',
                       cap: 'Not running: week cap reached', empty: 'Not running: queue empty', ended: 'Not running: run ended',
                       stopped: 'Not running: the run stopped without finishing'};
  const clock = (t) => new Date(t * 1000).toLocaleString([], {weekday: 'short', hour: '2-digit', minute: '2-digit'});
  const ago = (s) => s < 60 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : s < 129600 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} d`;
  function renderDash(d) {
    const el = document.getElementById('bl-dash');
    if (!el) return;
    if (!d) { el.textContent = ''; return; }
    const cls = ['starting', 'running', 'finishing'].includes(d.state) ? 'going' : ['waiting', 'cap', 'stopped'].includes(d.state) ? 'warn' : '';
    const why = d.state === 'stopped' ? `its last status was ${esc(d.last_state)}${d.why ? ' (' + esc(d.why) + ')' : ''}; no process holds the lock` : esc(d.why || '');
    const cell = (label, value, sub) => `<div><small>${label}</small><b>${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
    const of = (v, c) => (v == null ? '?' : `${v}%`) + (c != null ? ` of ${c}%` : '');
    el.innerHTML = `<div class="main"><b class="state ${cls}">${esc(DASH_STATES[d.state] || d.state)}</b>${why ? ' ' + why : ''}</div>` +
      cell('item', d.item ? esc(d.item) : '–') +
      cell('week used', of(d.week, d.week_cap), d.week_reset ? 'resets ' + esc(clock(d.week_reset)) : '') +
      cell('session used', of(d.session, d.session_cap), d.session_reset ? 'resets ' + esc(clock(d.session_reset)) : '') +
      cell('updated', `${ago(d.age)} ago`, d.late ? '<span class="warn">late: the scripts write every minute</span>' : '');
  }
  function pollRun(ms) {
    clearTimeout(runTimer);
    runTimer = setTimeout(async () => {
      try { const r = await fetch('/api/backlog/run'); if (r.ok) renderRun(await r.json()); } catch (e) {}
      pollRun(30000);
    }, ms);
  }
  async function postRun(path, body) {
    let r, j = {};
    try { r = await fetch('/api/backlog/' + path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)}); j = await r.json(); }
    catch (err) { await tell('The server did not answer: ' + err.message); return null; }
    if (!r.ok) { if (j.held !== undefined) renderRun(j); await tell(j.error || `error ${r.status}`); return null; }
    return j;
  }
  async function saveCap(cap) {
    const j = await postRun('cap', {cap});
    if (!j) return;
    try { sessionStorage.setItem('bl-toast', (cap == null ? `cap for ${j.date}: back to ${j.cap}%` : `cap for ${j.date}: ${j.cap}%`) +
      (j.held ? ' (applies to the runs started after this one)' : '')); } catch (e) {}
    location.reload();                                     // the capacity line and the cut follow the cap
  }
  if (runEl) {
    renderRun(run);
    pollRun(30000);
    document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'bl-cap-in') document.querySelector('[data-act="cap-save"]').click(); });
  }

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act, tr = b.closest('tr'), item = b.closest('.bl-item');
    if (act === 'cap-save') {
      const v = document.getElementById('bl-cap-in').value.trim(), n = Number(v);
      if (!/^\d+$/.test(v) || n < 1 || n > 100) { await tell('The cap is a week % from 1 to 100.'); return; }
      saveCap(n);
    }
    else if (act === 'cap-reset') saveCap(null);
    else if (act === 'run-now') {
      if (!(await ask(`Start the night run now? It works the queue from ${run.item} (${run.open} open) up to today's cap of ${run.cap}%` +
                      (run.week != null ? ` (week at ${Math.round(run.week * 10) / 10}%)` : '') + '.', {ok: 'run now'}))) return;
      b.disabled = true;
      const j = await postRun('run', {});
      if (j) { showToast('night run started'); pollRun(5000); } else b.disabled = run.held || !run.open;
    }
    else if (act === 'edit') editDialog(tr);
    else if (act === 'add') b.dataset.kind === 'idea' ? addIdeaDialog() : addDialog(b.dataset.kind);
    else if (act === 'delete') {
      if (await ask(`Delete ${tr.dataset.id} and its description?`, {ok: 'delete'}))
        post('delete', {file: 'ideas', id: tr.dataset.id, row_hash: tr.dataset.hash});
    }
    else if (act === 'queue') { b.disabled = true; post('queue', {id: tr.dataset.id, file: tr.closest('table').dataset.file}).then((j) => { if (!j) b.disabled = false; }); }
    else if (act === 'move') post('move', {label: item.dataset.label, dir: b.dataset.dir, queue_hash: root.dataset.qhash});
    else if (act === 'unqueue') {
      if (await ask(`Move ${item.dataset.label} to Deferred? Its text is kept.`, {ok: 'unqueue'}))
        post('unqueue', {label: item.dataset.label, queue_hash: root.dataset.qhash});
    }
  });
})();
