// Title, description and tags of one photo, editable: the lighttable's
// detail panel and the darkroom's "info & tags" section. Tag names use |
// for the hierarchy, as darktable's tagging module; a tag links to the
// library filtered by it.
(() => {
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const post = (url, body) => fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});

  // the library's tags as suggestions for every tag field (one <datalist id="tag-list">)
  let loaded = null;
  function suggestions(again) {
    if (loaded && !again) return loaded;
    let dl = document.getElementById('tag-list');
    if (!dl) { dl = el('datalist'); dl.id = 'tag-list'; document.body.append(dl); }
    loaded = fetch('/api/tags').then((r) => r.ok ? r.json() : {tags: []}).then((d) => {
      dl.textContent = '';
      for (const t of d.tags) { const o = el('option'); o.value = t.name; o.label = `${t.name} (${t.images})`; dl.append(o); }
      return d.tags;
    }).catch(() => []);
    return loaded;
  }

  async function setTags(imgids, attach, detach) {
    const r = await post('/api/tags', {imgids, attach, detach});
    if (!r.ok) throw new Error((await r.json()).detail);
    suggestions(true);
  }

  // editor(box, id, details, {onSaved}): details as /api/photo/{id}/details
  // replies (title, description, tags); fills box
  function editor(box, id, d, opts = {}) {
    box.textContent = '';
    box.classList.add('meta-ed');
    const note = el('p', 'meta-note dim');
    const say = (t) => { note.textContent = t; clearTimeout(say.t); if (t) say.t = setTimeout(() => { note.textContent = ''; }, 2500); };

    const field = (name, multi) => {
      const lab = el('label', 'meta-field');
      const inp = el(multi ? 'textarea' : 'input');
      if (multi) inp.rows = 2; else inp.type = 'text';
      inp.value = d[name] || ''; inp.dataset.saved = inp.value; inp.placeholder = 'none';
      inp.name = name;
      lab.append(el('span', 'dim', name), inp);
      const save = async () => {
        if (inp.value.trim() === inp.dataset.saved) return;
        const r = await post(`/api/photo/${id}/metadata`, {[name]: inp.value});
        if (!r.ok) { say((await r.json()).detail); return; }
        inp.dataset.saved = inp.value.trim();
        say(`${name} saved`);
        if (opts.onSaved) opts.onSaved();
      };
      inp.addEventListener('change', save);
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (!multi || e.metaKey || e.ctrlKey)) { e.preventDefault(); inp.blur(); }
        else if (e.key === 'Escape') { inp.value = inp.dataset.saved; inp.blur(); }
        e.stopPropagation();       // the page's keys (ratings, arrows) stay out of typing
      });
      return lab;
    };
    box.append(field('title', false), field('description', true));

    const tags = el('div', 'meta-tags');
    const chips = el('span', 'chips');
    const show = (list) => {
      chips.textContent = '';
      if (!list.length) chips.append(el('span', 'dim', 'no tags'));
      for (const t of list) {
        const c = el('span', 'chip');
        const a = el('a', null, t);
        a.href = '/?tag=' + encodeURIComponent(t); a.title = `the library's photos with ${t}`;
        const x = el('button', 'link', '✕'); x.title = `remove ${t}`; x.setAttribute('aria-label', `remove ${t}`);
        x.onclick = async () => {
          try { await setTags([id], [], [t]); } catch (e) { say(e.message); return; }
          list = list.filter((n) => n !== t); show(list); say(`${t} removed`);
          if (opts.onSaved) opts.onSaved();
        };
        c.append(a, x); chips.append(c);
      }
      current = list;
    };
    let current = d.tags || [];
    const add = el('input', 'meta-add'); add.type = 'text';
    add.setAttribute('list', 'tag-list'); add.placeholder = 'add a tag (| for a hierarchy)';
    add.title = 'Enter adds it; several: separate with commas';
    add.addEventListener('focus', () => suggestions());
    add.addEventListener('keydown', async (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { add.value = ''; add.blur(); return; }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const names = add.value.split(',').map((s) => s.trim()).filter((s) => s && !current.includes(s));
      if (!names.length) { add.value = ''; return; }
      try { await setTags([id], names, []); } catch (err) { say(err.message); return; }
      add.value = '';
      show([...current, ...names].sort((a, b) => a.localeCompare(b)));
      say(names.length > 1 ? `${names.length} tags added` : `${names[0]} added`);
      if (opts.onSaved) opts.onSaved();
    });
    tags.append(el('span', 'dim', 'tags'), chips, add);
    show(current);
    box.append(tags, note);
  }

  // whether someone is typing in box (an update from elsewhere waits)
  const typing = (box) => box.contains(document.activeElement) && document.activeElement.matches('input, textarea');

  window.dtMeta = {editor, setTags, suggestions, typing};
})();
