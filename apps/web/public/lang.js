/* global window, document, URLSearchParams */
// Same-origin and tiny: shows one language when the URL says ?lang=en or ?lang=he (the shape the mobile app links, T-0062). Without
// this file, or without JavaScript, the page shows both languages, one after the other.
(function () {
  var lang = new URLSearchParams(window.location.search).get('lang');
  if (lang !== 'en' && lang !== 'he') return;
  var root = document.documentElement;
  root.setAttribute('lang', lang);
  root.setAttribute('dir', lang === 'he' ? 'rtl' : 'ltr');
  root.setAttribute('data-lang', lang);
})();
