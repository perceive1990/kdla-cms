// Offline drafts: activity reports and case notes written without internet, kept in this browser's
// IndexedDB until they are sent. Only the drafts' author can send them, and only when signed in.
(function () {
  'use strict';
  var root = document.querySelector('[data-drafts]');
  if (!root) return;
  var USER = root.getAttribute('data-user');
  var FLAG = 'kdla-offline-drafts';
  var listEl = root.querySelector('[data-draft-list]');
  var netEl = document.querySelector('[data-net-status]');
  var sendAllBtn = root.querySelector('[data-send-all]');
  var forms = { report: root.querySelector('[data-draft-form="report"]'), note: root.querySelector('[data-draft-form="note"]') };
  var editing = null;
  var notices = []; // results of this visit: sent drafts with links
  var sending = false;

  // ---------- Storage ----------
  function open() {
    return new Promise(function (resolve, reject) {
      var req;
      try { req = indexedDB.open('kdla-drafts', 1); } catch (e) { reject(e); return; }
      req.onupgradeneeded = function () { req.result.createObjectStore('drafts', { keyPath: 'id' }); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function tx(mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction('drafts', mode);
        var out = fn(t.objectStore('drafts'));
        t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
        t.onerror = function () { reject(t.error); };
      });
    });
  }
  function all() { return tx('readonly', function (s) { return s.getAll(); }).then(function (rows) { return (rows || []).filter(function (d) { return d.userId === USER; }); }); }
  function put(d) { return tx('readwrite', function (s) { s.put(d); }); }
  function del(id) { return tx('readwrite', function (s) { s.delete(id); }); }
  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'd-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
  function localToday() {
    var d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 10);
  }
  function text(tag, cls, s) { var el = document.createElement(tag); if (cls) el.className = cls; if (s !== undefined) el.textContent = s; return el; }

  // ---------- Connection status ----------
  function showNet() {
    if (!netEl) return;
    var on = navigator.onLine;
    netEl.textContent = on ? 'Online' : 'Offline: drafts are kept on this computer';
    netEl.className = 'tag ' + (on ? 'tag-done' : 'tag-warn');
  }

  // ---------- Switch ----------
  var sw = root.querySelector('[data-offline-switch]');
  function tellWorker(type) {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.ready.then(function (reg) { if (reg.active) reg.active.postMessage({ type: type }); });
  }
  function readFlag() { try { return localStorage.getItem(FLAG) === USER; } catch (e) { return false; } }
  if (sw) {
    sw.checked = readFlag();
    sw.addEventListener('change', function () {
      try {
        if (sw.checked) { localStorage.setItem(FLAG, USER); tellWorker('drafts-on'); } else { localStorage.removeItem(FLAG); tellWorker('drafts-off'); }
      } catch (e) { sw.checked = false; }
    });
    if (sw.checked && navigator.onLine) tellWorker('drafts-on');
  }

  // ---------- List ----------
  function titleOf(d) {
    if (d.kind === 'note') return 'Case note for ' + (d.data.caseNumber || 'a case');
    return d.data.heading || 'Untitled activity report';
  }
  function render() {
    return all().then(function (rows) {
      rows.sort(function (a, b) { return String(b.savedAt).localeCompare(String(a.savedAt)); });
      listEl.textContent = '';
      notices.forEach(function (n) {
        var p = text('div', 'alert alert-success small py-2 mb-2');
        p.appendChild(document.createTextNode(n.message + ' '));
        var a = text('a', '', 'Open it'); a.href = n.url; p.appendChild(a);
        listEl.appendChild(p);
      });
      if (!rows.length) { listEl.appendChild(text('p', 'text-body-secondary mb-0', notices.length ? 'No drafts waiting.' : 'No drafts.')); }
      if (sendAllBtn) sendAllBtn.hidden = !rows.length || !navigator.onLine;
      rows.forEach(function (d) {
        var item = text('div', 'draft-item');
        var head = text('div', 'd-flex flex-wrap align-items-center gap-2');
        head.appendChild(text('span', 'tag ' + (d.kind === 'note' ? '' : 'tag-muted'), d.kind === 'note' ? 'Case note' : 'Activity report'));
        head.appendChild(text('strong', '', titleOf(d)));
        head.appendChild(text('span', 'small text-body-secondary', 'saved ' + new Date(d.savedAt).toLocaleString()));
        var actions = text('span', 'ms-auto d-flex gap-1');
        var edit = text('button', 'btn btn-sm btn-outline-secondary', 'Edit'); edit.type = 'button';
        edit.addEventListener('click', function () { show(d.kind, d); });
        var remove = text('button', 'btn btn-sm btn-outline-danger', 'Delete'); remove.type = 'button';
        remove.addEventListener('click', function () {
          if (remove.getAttribute('data-sure')) { del(d.id).then(render); return; }
          remove.setAttribute('data-sure', '1'); remove.textContent = 'Delete for good?';
        });
        actions.appendChild(edit); actions.appendChild(remove);
        head.appendChild(actions);
        item.appendChild(head);
        var state = d.error ? text('div', 'small text-danger mt-1', 'Not sent: ' + d.error + ' Edit the draft and save it to try again.')
          : text('div', 'small text-body-secondary mt-1', navigator.onLine ? 'Waiting to send.' : 'Will be sent when the connection returns.');
        item.appendChild(state);
        listEl.appendChild(item);
      });
    }).catch(function () {
      var warn = root.querySelector('[data-no-storage]');
      if (warn) warn.hidden = false;
    });
  }

  // ---------- Forms ----------
  function show(kind, draft) {
    Object.keys(forms).forEach(function (k) { forms[k].hidden = k !== kind; });
    var f = forms[kind];
    f.reset();
    editing = draft || null;
    var data = draft ? draft.data : {};
    Array.prototype.forEach.call(f.elements, function (el) {
      if (!el.name) return;
      if (el.type === 'checkbox') el.checked = data[el.name] === undefined ? el.defaultChecked : Boolean(data[el.name]);
      else if (data[el.name] !== undefined) el.value = data[el.name];
    });
    if (!draft) {
      var date = f.querySelector('[name="date"]'); if (date) date.value = localToday();
      var office = f.querySelector('[name="office"]'); var def = root.getAttribute('data-default-office');
      if (office && def) office.value = def;
    }
    f.scrollIntoView({ behavior: 'smooth', block: 'start' });
    var first = f.querySelector('input:not([type=hidden]), select, textarea'); if (first) first.focus();
  }
  root.querySelectorAll('[data-new-draft]').forEach(function (b) {
    b.addEventListener('click', function () { show(b.getAttribute('data-new-draft'), null); });
  });
  Object.keys(forms).forEach(function (kind) {
    var f = forms[kind];
    f.querySelector('[data-cancel-draft]').addEventListener('click', function () { f.hidden = true; editing = null; });
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var missing = Array.prototype.filter.call(f.querySelectorAll('[required]'), function (el) { return !String(el.value).trim(); });
      f.querySelectorAll('.is-invalid').forEach(function (el) { el.classList.remove('is-invalid'); });
      if (missing.length) { missing.forEach(function (el) { el.classList.add('is-invalid'); }); missing[0].focus(); return; }
      var data = {};
      Array.prototype.forEach.call(f.elements, function (el) {
        if (!el.name) return;
        data[el.name] = el.type === 'checkbox' ? el.checked : el.value;
      });
      var d = { id: editing ? editing.id : newId(), kind: kind, userId: USER, data: data, savedAt: new Date().toISOString(), error: '' };
      put(d).then(function () { f.hidden = true; editing = null; return render(); }).then(sendAll);
    });
  });

  // ---------- Sending ----------
  function sendAll() {
    if (sending || !navigator.onLine) return Promise.resolve();
    sending = true;
    var token;
    return fetch('/drafts/token', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (res) {
        var json = res.ok && /json/.test(res.headers.get('content-type') || '');
        if (!json) throw new Error('signin');
        return res.json();
      })
      .then(function (t) {
        if (t.userId !== USER) throw new Error('signin');
        token = t.csrf;
        return all();
      })
      .then(function (rows) {
        return rows.reduce(function (p, d) {
          return p.then(function () {
            return fetch('/drafts/sync', {
              method: 'POST', credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-csrf-token': token },
              body: JSON.stringify({ kind: d.kind, offlineId: d.id, data: d.data }),
            }).then(function (res) {
              return res.json().catch(function () { return {}; }).then(function (body) {
                if (res.ok && body.ok) { notices.push({ message: body.message, url: body.url }); return del(d.id); }
                d.error = body.error || 'The server refused it.';
                return put(d);
              });
            });
          });
        }, Promise.resolve());
      })
      .catch(function (e) {
        if (e && e.message === 'signin') {
          var box = root.querySelector('[data-signin-note]');
          if (!box) {
            box = text('div', 'alert alert-warning small');
            box.setAttribute('data-signin-note', '');
            box.textContent = 'Sign in to send your drafts. They stay on this computer until then.';
            listEl.parentNode.insertBefore(box, listEl);
          }
        }
      })
      .then(function () { sending = false; return render(); });
  }
  if (sendAllBtn) sendAllBtn.addEventListener('click', sendAll);

  window.addEventListener('online', function () { showNet(); sendAll(); });
  window.addEventListener('offline', function () { showNet(); render(); });
  showNet();
  render().then(sendAll);
}());
