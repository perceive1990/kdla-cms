/* KDLA Case Management — small progressive enhancements (no inline scripts, CSP-friendly) */
(function () {
  'use strict';

  var root = document.documentElement;
  var csrfMeta = document.querySelector('meta[name="csrf-token"]');
  var csrf = csrfMeta ? csrfMeta.getAttribute('content') : '';

  function saveTheme(fields) {
    if (!csrf || !window.fetch) return;
    fetch('/account/appearance', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'X-CSRF-Token': csrf },
      body: new URLSearchParams(fields).toString(),
    }).catch(function () {});
  }

  // Light / dark toggle in the top bar
  var toggle = document.getElementById('theme-toggle');
  function syncToggleIcon() {
    if (!toggle) return;
    var dark = root.getAttribute('data-bs-theme') === 'dark';
    var icon = toggle.querySelector('i');
    if (icon) icon.className = dark ? 'bi bi-sun' : 'bi bi-moon-stars';
    toggle.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    toggle.setAttribute('aria-pressed', dark ? 'true' : 'false');
  }
  syncToggleIcon();
  if (toggle) {
    toggle.addEventListener('click', function () {
      var next = root.getAttribute('data-bs-theme') === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme-mode', next);
      if (window.kdlaTheme) window.kdlaTheme.apply();
      syncToggleIcon();
      saveTheme({ mode: next });
    });
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      var onMq = function () { setTimeout(syncToggleIcon, 0); };
      if (mq.addEventListener) mq.addEventListener('change', onMq);
    }
  }

  // Appearance page: preview choices immediately
  document.querySelectorAll('[data-live]').forEach(function (input) {
    input.addEventListener('change', function () {
      var key = input.getAttribute('data-live');
      if (key === 'mode') {
        root.setAttribute('data-theme-mode', input.value);
        if (window.kdlaTheme) window.kdlaTheme.apply();
        syncToggleIcon();
      }
      if (key === 'accent') root.setAttribute('data-accent', input.value);
      if (key === 'textSize') root.setAttribute('data-text-size', input.value);
    });
  });

  // Filter boxes above long checkbox lists
  document.querySelectorAll('[data-filter-list]').forEach(function (input) {
    var list = document.getElementById(input.getAttribute('data-filter-list'));
    if (!list) return;
    input.addEventListener('input', function () {
      var t = input.value.trim().toLowerCase();
      list.querySelectorAll('[data-filter-item]').forEach(function (row) {
        var box = row.querySelector('input');
        var checked = box && box.checked;
        row.style.display = !t || checked || row.textContent.toLowerCase().indexOf(t) !== -1 ? '' : 'none';
      });
    });
  });

  // Case form: show the outcome fields only when the status is a concluded one
  var outcome = document.getElementById('outcome-section');
  var status = document.getElementById('status');
  if (outcome && status) {
    var prefix = outcome.getAttribute('data-show-when-status');
    var syncOutcome = function () {
      var show = status.value.indexOf(prefix) === 0;
      outcome.hidden = !show;
      outcome.querySelectorAll('select, input, textarea').forEach(function (el) { el.disabled = !show; });
    };
    status.addEventListener('change', syncOutcome);
    syncOutcome();
  }

  // Attendance register: add more rows
  var addRows = document.getElementById('add-rows');
  var bulk = document.getElementById('bulk-table');
  if (addRows && bulk) {
    addRows.classList.remove('d-none');
    addRows.addEventListener('click', function () {
      var body = bulk.querySelector('tbody');
      var rows = body.querySelectorAll('[data-row]');
      var template = rows[rows.length - 1];
      for (var n = 0; n < 10; n += 1) {
        var index = body.querySelectorAll('[data-row]').length;
        var clone = template.cloneNode(true);
        clone.querySelectorAll('input, select').forEach(function (el) {
          el.name = el.name.replace(/rows\[\d+\]/, 'rows[' + index + ']');
          el.classList.remove('is-invalid');
          if (el.tagName === 'INPUT') el.value = '';
          if (el.tagName === 'SELECT') el.selectedIndex = 0;
          var label = el.getAttribute('aria-label');
          if (label) el.setAttribute('aria-label', label.replace(/row \d+/, 'row ' + (index + 1)));
        });
        var num = clone.querySelector('[data-row-num]');
        if (num) num.textContent = String(index + 1);
        body.appendChild(clone);
      }
      if (body.querySelectorAll('[data-row]').length >= 200) addRows.disabled = true;
    });
  }

  // Confirm before destructive actions
  document.querySelectorAll('form[data-confirm]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      if (!window.confirm(form.getAttribute('data-confirm'))) e.preventDefault();
    });
  });

  // Auto-submit filter selects
  document.querySelectorAll('[data-autosubmit]').forEach(function (el) {
    el.addEventListener('change', function () { el.form.submit(); });
  });

  // Print buttons
  document.querySelectorAll('[data-print]').forEach(function (btn) {
    btn.addEventListener('click', function () { window.print(); });
  });

  // Copy buttons: data-copy="id of the element whose text is copied"
  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var source = document.getElementById(btn.getAttribute('data-copy'));
      if (!source || !navigator.clipboard) return;
      navigator.clipboard.writeText(source.textContent.trim()).then(function () {
        var label = btn.innerHTML;
        btn.textContent = 'Copied';
        setTimeout(function () { btn.innerHTML = label; }, 2000);
      });
    });
  });

  // Prevent double submits
  document.querySelectorAll('form[method="post"]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      var btn = form.querySelector('button[type="submit"]:not([data-keep])');
      if (btn) setTimeout(function () { if (!e.defaultPrevented) btn.disabled = true; }, 0);
    });
  });

  // Live chat
  var chat = document.getElementById('chat');
  if (chat) {
    var feed = chat.getAttribute('data-feed');
    var last = chat.getAttribute('data-last') || '';
    var form = document.getElementById('chat-form');
    var box = document.getElementById('content');
    var empty = document.getElementById('chat-empty');

    var scrollDown = function () { chat.scrollTop = chat.scrollHeight; };
    scrollDown();

    var render = function (m) {
      if (document.getElementById('m-' + m.id)) return;
      if (empty) { empty.remove(); empty = null; }
      var wrap = document.createElement('div');
      wrap.className = 'msg' + (m.mine ? ' mine' : '');
      wrap.id = 'm-' + m.id;
      var meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = (m.mine ? 'You' : m.sender) + ' · ' + m.when;
      var bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.textContent = m.content;
      wrap.appendChild(meta); wrap.appendChild(bubble);
      chat.appendChild(wrap);
    };

    var poll = function () {
      fetch(feed + '?after=' + encodeURIComponent(last), { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
        .then(function (r) {
          if (r.status === 401) { window.location.href = '/login?expired=1'; return []; }
          return r.ok ? r.json() : [];
        })
        .then(function (list) {
          if (!list.length) return;
          var nearBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
          list.forEach(render);
          last = list[list.length - 1].createdAt;
          if (nearBottom) scrollDown();
        })
        .catch(function () {});
    };
    setInterval(function () { if (!document.hidden) poll(); }, 5000);

    if (form && window.fetch) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var text = box.value.trim();
        if (!text) return;
        var btn = form.querySelector('button[type="submit"]');
        btn.disabled = true;
        fetch(form.action, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(new FormData(form)).toString(),
        }).then(function (r) {
          if (!r.ok) throw new Error('send failed');
          box.value = '';
          poll();
          setTimeout(scrollDown, 300);
        }).catch(function () {
          form.submit();
        }).finally(function () { btn.disabled = false; box.focus(); });
      });
      box.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) form.requestSubmit();
      });
    }
  }
})();
