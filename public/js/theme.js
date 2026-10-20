/* Applies light or dark mode before the page is drawn (loaded in <head>, CSP-friendly). */
(function () {
  'use strict';
  var root = document.documentElement;
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function effective(mode) {
    if (mode === 'dark' || mode === 'light') return mode;
    return media && media.matches ? 'dark' : 'light';
  }

  function apply() {
    root.setAttribute('data-bs-theme', effective(root.getAttribute('data-theme-mode') || 'auto'));
  }

  apply();
  if (media) {
    var onChange = function () { if ((root.getAttribute('data-theme-mode') || 'auto') === 'auto') apply(); };
    if (media.addEventListener) media.addEventListener('change', onChange);
    else if (media.addListener) media.addListener(onChange);
  }

  // Always print in light mode
  var before = null;
  window.addEventListener('beforeprint', function () {
    before = root.getAttribute('data-bs-theme');
    root.setAttribute('data-bs-theme', 'light');
  });
  window.addEventListener('afterprint', function () { if (before) root.setAttribute('data-bs-theme', before); });

  window.kdlaTheme = { apply: apply, effective: effective };
})();
