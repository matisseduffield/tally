// The website as a home screen app: a service worker for opening with no signal,
// and a one-time hint on iPhones. The Android app bundles this file too, so it
// does nothing there: no service worker in the WebView, and no hint.
(function (root) {
  const SEEN = 'tally.installHint';

  // Safari itself on an iPhone. Other iOS browsers say Safari as well, so they
  // go by name, and browsers inside other apps have no Version/ in the string.
  const iphoneSafari = ua => /iPhone|iPod/.test(ua) && /Version\/[\d.]+.* Safari\//.test(ua)
    && !/CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|DuckDuckGo|Brave|YaBrowser/.test(ua);

  function showHint(hint) {
    try {
      if (localStorage.getItem(SEEN)) return;
      localStorage.setItem(SEEN, '1');
    } catch { return; }
    hint.hidden = false;
    hint.querySelector('button').addEventListener('click', () => { hint.hidden = true; });
  }

  const doc = root.document;
  if (doc && root.location.hostname !== 'appassets.androidplatform.net') {
    const nav = root.navigator;
    if ('serviceWorker' in nav) nav.serviceWorker.register(new URL('sw.js', doc.currentScript.src).href).catch(() => {});
    const hint = doc.getElementById('installHint');
    const installed = nav.standalone === true || root.matchMedia('(display-mode: standalone)').matches;
    if (hint && !installed && iphoneSafari(nav.userAgent)) showHint(hint);
  }

  if (typeof module === 'object' && module.exports) module.exports = { iphoneSafari };
})(globalThis);
