'use strict';
/** Tab wiring for the two-panel page, then hand each panel to DDXUi. */
(function () {
  const tabs = [
    { btn: document.getElementById('tab-send'), panel: document.getElementById('panel-send') },
    { btn: document.getElementById('tab-recv'), panel: document.getElementById('panel-recv') },
  ];

  function select(i) {
    tabs.forEach((tab, n) => {
      tab.btn.setAttribute('aria-selected', String(n === i));
      tab.panel.classList.toggle('hidden', n !== i);
    });
  }
  tabs.forEach((tab, i) => tab.btn.addEventListener('click', () => select(i)));

  window.DDXUi.mountSend(document);
  window.DDXUi.mountReceive(document, null);

  // ?recv, or a code pasted as ?code=ABCD-EFGH, opens straight into Receive —
  // the tab a person arriving from someone else's message actually wants.
  const q = new URLSearchParams(location.search);
  if (q.has('recv') || q.has('code')) {
    select(1);
    const code = (q.get('code') || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
    if (code) {
      const el = document.getElementById('recv-code');
      el.value = code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
    }
  }
})();
