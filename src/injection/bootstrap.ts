// The script injected via injectedJavaScriptBeforeContentLoaded. It runs before
// YouTube's own JS, installs the filter <style> immediately (no flash of hidden
// content), and survives SPA navigation. "__RULES__" is replaced with a JSON
// array of InjectedRule by buildInjection.ts.
//
// Constraints on this code: it must be plain ES5-ish JS (runs inside the page,
// not through Metro), contain no backticks or "${", and end with "true;".
export const BOOTSTRAP_TEMPLATE = `
(function () {
  var RULES = __RULES__;

  if (window.__unhook) {
    window.__unhook.apply(RULES);
    return;
  }

  var STYLE_ID = '__unhook_css';
  var state = { rules: RULES, debug: false };

  function post(msg) {
    try {
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify(msg));
      }
    } catch (e) {}
  }

  function enabled(id) {
    for (var i = 0; i < state.rules.length; i++) {
      if (state.rules[i].id === id) return !!state.rules[i].enabled;
    }
    return false;
  }

  function ensureStyle() {
    var el = document.getElementById(STYLE_ID);
    if (!el) {
      el = document.createElement('style');
      el.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(el);
    }
    return el;
  }

  function activeSelectors() {
    var path = location.pathname;
    var sels = [];
    for (var i = 0; i < state.rules.length; i++) {
      var r = state.rules[i];
      if (!r.enabled || !r.css) continue;
      if (r.pathScope) {
        try {
          if (!new RegExp(r.pathScope).test(path)) continue;
        } catch (e) { continue; }
      }
      sels = sels.concat(r.css);
    }
    return sels;
  }

  function applyCss() {
    var sels = activeSelectors();
    var decl = state.debug
      ? ' { outline: 2px solid red !important; outline-offset: -2px; }'
      : ' { display: none !important; }';
    ensureStyle().textContent = sels.length ? sels.join(',\\n') + decl : '';
  }

  function reportMatches() {
    var counts = {};
    var sels = activeSelectors();
    for (var i = 0; i < sels.length; i++) {
      try {
        counts[sels[i]] = document.querySelectorAll(sels[i]).length;
      } catch (e) {
        counts[sels[i]] = 'invalid selector';
      }
    }
    post({ type: 'debug', url: location.href, matches: counts });
  }

  // --- Behavioral filters -------------------------------------------------
  // Listeners are installed once and consult the live rule state at event
  // time, so toggling in Settings works without reinstalling them.

  // Capture-phase interceptor: swallow taps on anything linking to Shorts.
  document.addEventListener('click', function (e) {
    if (!enabled('hide-shorts')) return;
    var el = e.target;
    while (el && el !== document.documentElement) {
      if (el.tagName === 'A' && el.href && el.href.indexOf('/shorts/') !== -1) {
        e.preventDefault();
        e.stopImmediatePropagation();
        post({ type: 'blocked', what: 'shorts-link', href: el.href });
        return;
      }
      el = el.parentElement;
    }
  }, true);

  // YouTube re-enables autonav server-side sometimes; keep clicking it off.
  setInterval(function () {
    if (!enabled('disable-autoplay')) return;
    if (!/^\\/watch/.test(location.pathname)) return;
    var btn = document.querySelector(
      '.ytm-autonav-toggle-button-container, button[aria-label*="utoplay"]'
    );
    if (!btn) return;
    var pressed = btn.getAttribute('aria-pressed') || btn.getAttribute('aria-checked');
    if (pressed === 'true') {
      btn.click();
      post({ type: 'action', what: 'autoplay-off' });
    }
  }, 1500);

  // --- SPA survival ---------------------------------------------------------

  new MutationObserver(function () {
    if (!document.getElementById(STYLE_ID)) applyCss();
  }).observe(document.documentElement, { childList: true, subtree: true });

  function onUrlChange() {
    applyCss();
    post({ type: 'nav', url: location.href });
  }
  var origPush = history.pushState;
  history.pushState = function () {
    var r = origPush.apply(this, arguments);
    onUrlChange();
    return r;
  };
  var origReplace = history.replaceState;
  history.replaceState = function () {
    var r = origReplace.apply(this, arguments);
    onUrlChange();
    return r;
  };
  window.addEventListener('popstate', onUrlChange);

  // --- Public handle for re-injection from React Native --------------------

  window.__unhook = {
    apply: function (rules) {
      state.rules = rules;
      applyCss();
    },
    debug: function (on) {
      state.debug = !!on;
      applyCss();
      if (on) reportMatches();
    },
  };

  applyCss();
  post({ type: 'ready', url: location.href });
})();
true;
`;
