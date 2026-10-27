// W42: the photo's library id as a button (.pid): a click copies "photo 431" so it can be
// pasted to an AI assistant. dtCopy(text, what) is also used by the selection bar.
(() => {
  let toast = null, timer = null;
  function say(text) {
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'toast';
      toast.setAttribute('role', 'status');
      document.body.append(toast);
    }
    toast.textContent = text;
    toast.classList.add('on');
    clearTimeout(timer);
    timer = setTimeout(() => toast.classList.remove('on'), 1800);
  }
  async function copy(text, owner) {
    try { await navigator.clipboard.writeText(text); say('copied ' + text); return; } catch (e) {}
    // no clipboard API (plain http off localhost): select the text, or a hidden textarea
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.append(ta); ta.select();
      const ok = document.execCommand('copy');
      if (ok) { ta.remove(); say('copied ' + text); return; }
      ta.remove();
    } catch (e) {}
    if (owner) getSelection().selectAllChildren(owner);
    say('press ⌘C / Ctrl+C to copy ' + text);
  }
  window.dtCopy = copy;
  // capture phase: the tile's own click handlers must not run (select, show, open)
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('.pid');
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    copy(b.dataset.copy, b);
  }, true);
  for (const type of ['pointerdown', 'mousedown', 'dblclick'])
    document.addEventListener(type, (e) => {
      if (e.target.closest && e.target.closest('.pid')) e.stopPropagation();
    }, true);
})();
