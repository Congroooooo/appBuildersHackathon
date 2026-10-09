// Continuum page context: reads only what is visible as page text (title, headings, description, a short excerpt
// of the main content) and text the user highlights. Never reads form fields or runs in incognito windows.
(() => {
  if (chrome.extension?.inIncognitoContext) return;
  const MAX_EXCERPT = 1500, MAX_SELECTION = 500;
  const clean = text => String(text ?? '').replace(/\s+/g, ' ').trim();
  let sentFor = '', selectionTimer = null;

  function mainText() {
    const root = document.querySelector('article, main, [role="main"], #content, .content') ?? document.body;
    if (!root) return '';
    const clone = root.cloneNode(true);
    clone.querySelectorAll('nav, header, footer, aside, script, style, noscript, form, input, textarea, select, button, [aria-hidden="true"], [contenteditable="true"]').forEach(n => n.remove());
    return clean(clone.textContent).slice(0, MAX_EXCERPT);
  }

  function send(payload) {
    try { chrome.runtime.sendMessage({ type: 'continuum-page', payload }); } catch { /* extension reloaded */ }
  }

  function sendPage() {
    if (document.visibilityState !== 'visible' || location.href === sentFor) return;
    sentFor = location.href;
    const headings = [...document.querySelectorAll('h1, h2, h3')].map(h => clean(h.textContent)).filter(Boolean).slice(0, 8).map(h => h.slice(0, 120));
    send({
      kind: 'page', url: location.href, title: clean(document.title).slice(0, 200),
      description: clean(document.querySelector('meta[name="description"], meta[property="og:description"]')?.getAttribute('content')).slice(0, 300) || undefined,
      headings, excerpt: mainText(),
    });
  }

  // After the page has been visible for a moment; again when a single-page app changes the address.
  setTimeout(sendPage, 2500);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') setTimeout(sendPage, 2500); });
  setInterval(() => { if (location.href !== sentFor) sendPage(); }, 3000);

  document.addEventListener('mouseup', () => {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      const selection = window.getSelection();
      const anchor = selection?.anchorNode?.parentElement;
      if (!selection || anchor?.closest('input, textarea, [contenteditable="true"]')) return;
      const text = clean(selection.toString());
      if (text.length >= 20) send({ kind: 'selection', url: location.href, title: clean(document.title).slice(0, 200), selection: text.slice(0, MAX_SELECTION) });
    }, 600);
  });
})();
