// in-page dialogs in place of confirm(), alert() and prompt(), which a
// browser may answer by itself once a tab has ticked "don't let this site
// prompt again" (Firefox then answers every confirm() with no).
//   ask(message, {ok, cancel, danger})  -> Promise<boolean>
//   ask(message, {value})               -> Promise<string | null> (an input)
//   tell(message, {value})              -> Promise<void> (one button)
//   choose(message, [{label, value, kind}]) -> Promise<value | null>
//     (one button per choice, in order; kind 'primary' or 'danger'; the
//     primary one is the default)
// Esc and the cancel button answer no (null); Enter answers the default
// button. A modal <dialog> sits in the top layer, above the phone sheet and
// the full screen view, keeps focus inside, and focus goes back afterwards.
(function () {
  let dlg = null;
  function build() {
    dlg = document.createElement('dialog');
    dlg.className = 'connect ask-dlg';
    dlg.innerHTML = '<form method="dialog"><p class="ask-msg"></p>' +
      '<input class="ask-val" autocomplete="off" spellcheck="false">' +
      '<div class="ask-btns"><button type="button" value="" class="ask-no"></button>' +
      '<button value="ok" class="ask-ok"></button></div></form>';
    document.body.appendChild(dlg);
    dlg.querySelector('.ask-no').onclick = () => dlg.close('');
    dlg.onclick = (e) => { if (e.target === dlg) dlg.close(''); };
    // the page's own keys (Esc, Del, arrows) stay out of it
    dlg.addEventListener('keydown', (e) => e.stopPropagation());
  }
  function show(message, o, one) {
    if (!dlg) build();
    if (dlg.open) dlg.close('');
    const back = document.activeElement;
    const input = dlg.querySelector('.ask-val'), ok = dlg.querySelector('.ask-ok'), no = dlg.querySelector('.ask-no');
    const withValue = o.value !== undefined;
    dlg.querySelector('.ask-msg').textContent = message;
    input.hidden = !withValue;
    input.readOnly = one;
    input.value = withValue ? String(o.value) : '';
    ok.textContent = o.ok || 'OK';
    ok.className = 'ask-ok ' + (o.danger ? 'danger' : 'primary');
    no.textContent = o.cancel || 'cancel';
    no.hidden = one;
    dlg.returnValue = '';
    return new Promise((resolve) => {
      dlg.addEventListener('close', () => {
        if (back && back.focus && document.contains(back)) back.focus({preventScroll: true});
        const yes = dlg.returnValue === 'ok';
        resolve(withValue && !one ? (yes ? input.value : null) : yes);
      }, {once: true});
      dlg.showModal();
      if (withValue) { input.focus(); input.select(); } else ok.focus();
    });
  }
  let cdlg = null;
  window.choose = (message, choices) => {
    if (!cdlg) {
      cdlg = document.createElement('dialog');
      cdlg.className = 'connect ask-dlg';
      cdlg.innerHTML = '<form method="dialog"><p class="ask-msg"></p><div class="ask-btns"></div></form>';
      document.body.appendChild(cdlg);
      cdlg.onclick = (e) => { if (e.target === cdlg) cdlg.close(''); };
      cdlg.addEventListener('keydown', (e) => e.stopPropagation());
    }
    if (cdlg.open) cdlg.close('');
    const back = document.activeElement, btns = cdlg.querySelector('.ask-btns');
    cdlg.querySelector('.ask-msg').textContent = message;
    btns.replaceChildren(...choices.map((c, i) => {
      const b = document.createElement('button');
      b.value = String(i); b.textContent = c.label; b.className = c.kind || '';
      return b;
    }));
    cdlg.returnValue = '';
    return new Promise((resolve) => {
      cdlg.addEventListener('close', () => {
        if (back && back.focus && document.contains(back)) back.focus({preventScroll: true});
        const c = choices[cdlg.returnValue === '' ? -1 : +cdlg.returnValue];
        resolve(c ? c.value : null);
      }, {once: true});
      cdlg.showModal();
      (btns.querySelector('.primary') || btns.lastElementChild).focus();
    });
  };
  window.ask = (message, o = {}) => show(message, o, false);
  window.tell = (message, o = {}) => show(message, o, true).then(() => {});
})();
