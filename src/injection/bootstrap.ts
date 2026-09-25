// The script injected via injectedJavaScriptBeforeContentLoaded. It runs before
// the site's own JS, installs the filter <style> immediately (no flash of hidden
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
  var HIDE_ATTR = 'data-unhook-hide';
  var state = { rules: RULES, debug: false };

  // jsAction name -> has it reported success yet this page load. Read by the
  // deferUntil interlock in activeSelectors().
  var succeeded = {};

  function ruleFor(action) {
    for (var i = 0; i < state.rules.length; i++) {
      if (state.rules[i].jsAction === action) return state.rules[i];
    }
    return null;
  }

  function actionEnabled(action) {
    var r = ruleFor(action);
    return !!(r && r.enabled);
  }

  function actionParam(action) {
    var r = ruleFor(action);
    return (r && r.param) || '';
  }

  function post(msg) {
    try {
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify(msg));
      }
    } catch (e) {}
  }

  function inScope(rule) {
    if (!rule.pathScope) return true;
    try {
      return new RegExp(rule.pathScope).test(location.pathname);
    } catch (e) {
      return false;
    }
  }

  // May legitimately return null: when injected before content loaded there is
  // not always a document element yet to hang the style off. Callers retry.
  function ensureStyle() {
    var el = document.getElementById(STYLE_ID);
    if (!el) {
      var host = document.head || document.documentElement;
      if (!host) return null;
      el = document.createElement('style');
      el.id = STYLE_ID;
      host.appendChild(el);
    }
    return el;
  }

  function activeSelectors() {
    var sels = [];
    for (var i = 0; i < state.rules.length; i++) {
      var r = state.rules[i];
      if (!r.enabled || !r.css) continue;
      if (!inScope(r)) continue;
      // deferUntil: hold this rule's CSS back until the jsAction it depends on
      // has succeeded. Hiding Telegram's folder tabs before the focus-folder
      // click lands would make the click impossible. Once the action is
      // disabled entirely there is nothing to wait for, so the rule applies.
      if (r.deferUntil && actionEnabled(r.deferUntil) && !succeeded[r.deferUntil]) continue;
      sels = sels.concat(r.css);
    }
    // Text-matched nodes ride the same stylesheet, so debug outlining and
    // live re-apply work on them for free.
    sels.push('[' + HIDE_ATTR + '="1"]');
    return sels;
  }

  function applyCss() {
    var el = ensureStyle();
    if (!el) return;
    var sels = activeSelectors();
    var decl = state.debug
      ? ' { outline: 2px solid red !important; outline-offset: -2px; }'
      : ' { display: none !important; }';
    el.textContent = sels.join(',\\n') + decl;
  }

  // --- Redirects ------------------------------------------------------------
  // Runs before anything else on each navigation: if the page is going away
  // there is no point styling it. Returns true when a redirect was issued.

  function applyRedirects() {
    for (var i = 0; i < state.rules.length; i++) {
      var r = state.rules[i];
      if (!r.enabled || !r.redirect) continue;
      try {
        var from = new RegExp(r.redirect.from);
        if (!from.test(location.pathname)) continue;
        // Guard against a rule that would bounce its own destination forever.
        if (from.test(r.redirect.to)) continue;
      } catch (e) {
        continue;
      }
      post({ type: 'redirect', rule: r.id, from: location.pathname, to: r.redirect.to });
      try {
        location.replace(r.redirect.to);
      } catch (e) {}
      return true;
    }
    return false;
  }

  // --- Text-content filters -----------------------------------------------
  // Instagram has no stable class names, so "Suggested for you" posts can only
  // be found by their text. Matches are marked with an attribute rather than
  // hidden inline, so clearing them is a single query.

  function clearTextHides() {
    var marked = document.querySelectorAll('[' + HIDE_ATTR + ']');
    for (var i = 0; i < marked.length; i++) {
      marked[i].removeAttribute(HIDE_ATTR);
    }
  }

  // hideClosest walks UP the tree, so an over-broad selector can resolve to the
  // app shell and blank the entire site. Nothing a text filter matches is ever
  // worth hiding the whole page for, so refuse those outright and say so.
  function tooBigToHide(el) {
    if (!el || el === document.body || el === document.documentElement) return true;
    if (!el.contains) return false;
    // Telegram Web has no <main> or landmark roles at all, so its column ids
    // are listed too — without them the guard would have nothing to anchor on.
    var anchors = document.querySelectorAll(
      'main, [role="main"], [role="navigation"],' +
        '#column-left, #column-center, #LeftColumn, #MiddleColumn'
    );
    for (var i = 0; i < anchors.length; i++) {
      if (el !== anchors[i] && el.contains(anchors[i])) return true;
    }
    return false;
  }

  function scanText() {
    for (var i = 0; i < state.rules.length; i++) {
      var r = state.rules[i];
      if (!r.enabled || !r.textFilters) continue;
      if (!inScope(r)) continue;
      for (var j = 0; j < r.textFilters.length; j++) {
        var f = r.textFilters[j];
        var nodes;
        try {
          nodes = document.querySelectorAll(f.match);
        } catch (e) {
          continue;
        }
        for (var k = 0; k < nodes.length; k++) {
          var node = nodes[k];
          var text = (node.textContent || '').toLowerCase();
          var hit = false;
          for (var t = 0; t < f.anyText.length; t++) {
            if (text.indexOf(f.anyText[t]) !== -1) { hit = true; break; }
          }
          if (!hit) continue;
          var target = node;
          if (f.hideClosest) {
            target = node.closest ? node.closest(f.hideClosest) : null;
            if (!target) continue;
          }
          if (tooBigToHide(target)) {
            post({ type: 'refused', rule: r.id, reason: 'would hide the page shell', match: f.match });
            continue;
          }
          target.setAttribute(HIDE_ATTR, '1');
        }
      }
    }
  }

  // Infinite feeds mutate constantly — coalesce bursts into one scan.
  var scanPending = false;
  function scheduleScan() {
    if (scanPending) return;
    scanPending = true;
    setTimeout(function () {
      scanPending = false;
      scanText();
      // Rides the same debounce rather than adding a timer: the guard needs to
      // re-evaluate on exactly the same mutations, and it is cheap when off.
      applyGuard();
    }, 150);
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
    for (var r = 0; r < state.rules.length; r++) {
      var rule = state.rules[r];
      if (!rule.enabled || !rule.textFilters || !inScope(rule)) continue;
      for (var f = 0; f < rule.textFilters.length; f++) {
        var sel = rule.textFilters[f].match;
        try {
          counts['text:' + sel] = document.querySelectorAll(sel).length;
        } catch (e) {
          counts['text:' + sel] = 'invalid selector';
        }
      }
    }
    post({ type: 'debug', url: location.href, matches: counts });
  }

  // --- Behavioral filters -------------------------------------------------
  // Listeners are installed once and consult the live rule state at event
  // time, so toggling in Settings works without reinstalling them.

  // Capture-phase interceptor: swallow taps on links into blocked paths.
  // Mirrors the shouldLoad policy for SPA navigation, which never reaches it.
  function blockedRuleFor(path) {
    for (var i = 0; i < state.rules.length; i++) {
      var r = state.rules[i];
      if (!r.enabled || !r.blockPathPattern) continue;
      try {
        if (new RegExp(r.blockPathPattern).test(path)) return r.id;
      } catch (e) {}
    }
    return null;
  }

  document.addEventListener('click', function (e) {
    var el = e.target;
    while (el && el !== document.documentElement) {
      if (el.tagName === 'A' && el.href) {
        var ruleId = blockedRuleFor(el.pathname || el.href);
        if (ruleId) {
          e.preventDefault();
          e.stopImmediatePropagation();
          post({ type: 'blocked', rule: ruleId, href: el.href });
          return;
        }
      }
      el = el.parentElement;
    }
  }, true);

  // YouTube re-enables autonav server-side sometimes; keep clicking it off.
  setInterval(function () {
    if (!actionEnabled('disableAutoplay')) return;
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

  // --- Focus folder ---------------------------------------------------------
  // Telegram's own folders are the only dependable way to curate a chat list:
  // the dialog list is virtualized, so filtering it in the DOM can never see
  // more than what happens to be rendered. Instead we click the user's folder
  // tab for them on load and let Telegram filter server-side.

  var FOLDER_TAB_SELECTORS =
    '.folders-tabs-scrollable .menu-horizontal-div-item,' +
    '#folders-container .menu-horizontal-div-item,' +
    '.menu-horizontal-div-item,' +
    '.ChatFolders .Tab, .TabList .Tab, .Tab, [role="tab"]';

  function normLabel(s) {
    return String(s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
  }

  // Folder tabs carry a trailing unread count ("focus mode 3"), which is not
  // part of the name the user typed.
  function baseLabel(s) {
    return normLabel(s).replace(/\\s*\\d+$/, '').trim();
  }

  function findFocusTab(name) {
    var matches = [];
    var nodes = document.querySelectorAll(FOLDER_TAB_SELECTORS);
    for (var i = 0; i < nodes.length; i++) {
      if (baseLabel(nodes[i].textContent) === name) matches.push(nodes[i]);
    }
    if (!matches.length) {
      // Fallback for a renamed tab class: any small element carrying the label.
      // The size cap excludes wrappers — a container holding the whole tab bar
      // also "contains" the text, and clicking it does nothing.
      var all = document.querySelectorAll('div,span,a,li,button');
      for (var j = 0; j < all.length; j++) {
        if (all[j].getElementsByTagName('*').length > 8) continue;
        if (baseLabel(all[j].textContent) === name) matches.push(all[j]);
      }
    }
    if (!matches.length) return null;

    // Smallest match is the tab itself rather than something wrapping it.
    var best = null;
    var bestArea = Infinity;
    for (var k = 0; k < matches.length; k++) {
      var r = matches[k].getBoundingClientRect();
      if (!r || !r.width || !r.height) continue;
      if (r.width * r.height < bestArea) {
        best = matches[k];
        bestArea = r.width * r.height;
      }
    }
    // Every candidate reported a zero rect. That happens for real — a tab
    // inside a content-visibility container measures as zero — so fall back to
    // the first match instead of giving up on the feature entirely.
    return best || matches[0];
  }

  // Some builds switch folders on pointer/mouse events rather than a bare
  // click(), so send the whole sequence.
  function fireClick(el) {
    var types = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    for (var i = 0; i < types.length; i++) {
      var Ctor =
        types[i].indexOf('pointer') === 0 && window.PointerEvent
          ? window.PointerEvent
          : window.MouseEvent;
      try {
        el.dispatchEvent(new Ctor(types[i], { bubbles: true, cancelable: true, view: window }));
      } catch (e) {}
    }
  }

  // React puts the handler on an ancestor, not on the text node that carries
  // the label.
  function clickableAncestor(el) {
    var node = el;
    for (var i = 0; i < 6 && node; i++) {
      if (node.tagName === 'A' || node.tagName === 'BUTTON') return node;
      if (node.getAttribute && node.getAttribute('role') === 'tab') return node;
      try {
        if (window.getComputedStyle(node).cursor === 'pointer') return node;
      } catch (e) {}
      node = node.parentElement;
    }
    return el;
  }

  var focusTimer = null;

  function startFocusRetries() {
    if (focusTimer) {
      clearTimeout(focusTimer);
      focusTimer = null;
    }
    // Re-opening the folder means letting the tab bar back onto the screen
    // first, or there would be nothing left to click.
    succeeded.focusFolder = false;
    applyCss();
    if (!actionEnabled('focusFolder')) return;

    var name = baseLabel(actionParam('focusFolder'));
    if (!name) return;

    var attempts = 0;
    var clicked = 0;

    function tick() {
      focusTimer = null;
      // Bail if the rule was switched off or the name edited mid-flight — a
      // stale loop would fight the folder the user has since chosen.
      if (!actionEnabled('focusFolder')) return;
      if (baseLabel(actionParam('focusFolder')) !== name) return;

      var tab = findFocusTab(name);
      if (tab) {
        fireClick(clickableAncestor(tab));
        clicked++;
      }
      attempts++;

      // Two races to beat: the client not having attached its handlers yet, and
      // Telegram restoring the last-open folder a beat after the first click.
      // Keep going until several land, or give up after ~9s.
      if (clicked < 4 && attempts < 20) {
        focusTimer = setTimeout(tick, 450);
        return;
      }
      if (clicked > 0) {
        succeeded.focusFolder = true;
        applyCss();
        post({ type: 'action', what: 'focus-folder', name: name, clicks: clicked });
      } else {
        post({ type: 'action', what: 'focus-folder-missing', name: name });
      }
    }

    tick();
  }

  // Restart the loop only when the folder actually changes: the bootstrap is
  // injected at three points and apply() runs on every unrelated toggle, and
  // neither should re-fight the current folder.
  var lastFocusKey;
  function syncFocus() {
    var key = actionEnabled('focusFolder') ? baseLabel(actionParam('focusFolder')) : null;
    if (key === lastFocusKey) return;
    lastFocusKey = key;
    startFocusRetries();
  }

  // --- Focus lock -----------------------------------------------------------
  // Hiding entries in the chat list does not stop Telegram opening ANY chat in
  // response to a link inside a message, which is the main way a curated view
  // springs a leak. With the lock on, the title of the open chat is checked
  // against what the list offered and covered over if it does not belong.

  var GUARD_ID = '__unhook_guard';
  var CHAT_ITEM_SELECTORS =
    'a.chatlist-chat, .chatlist-chat, li.chatlist-chat, .ListItem.Chat, .chat-item-clickable';
  var CHAT_TITLE_SELECTORS =
    '.peer-title, .user-title, .info .title, .ChatInfo .title, .title span';
  var OPEN_TITLE_SELECTORS =
    '.chat-info .peer-title, .sidebar-header .peer-title, .topbar .peer-title,' +
    '.MiddleHeader .info .title, .ChatInfo .info .title, .ChatInfo .title';

  // offsetParent is the usual visibility test, but WebK hides the inactive
  // folder's list with display:none on a container, which this reads directly.
  // It is also the only one of the two that jsdom implements.
  //
  // getComputedStyle forces a style recalc and WebK keeps every folder's list
  // in the DOM at once, so walking each row's ancestors unconditionally would
  // mean hundreds of recalcs per scan. Rows in a list share ancestors, so the
  // optional cache collapses a whole list down to one walk.
  function isHidden(el, cache) {
    var chain = [];
    var node = el;
    var hidden = false;
    while (node && node.nodeType === 1) {
      var seen = cache ? cache.get(node) : undefined;
      if (seen !== undefined) {
        hidden = seen;
        break;
      }
      var s = null;
      try {
        s = window.getComputedStyle(node);
      } catch (e) {}
      if (s && (s.display === 'none' || s.visibility === 'hidden')) {
        hidden = true;
        break;
      }
      chain.push(node);
      node = node.parentElement;
    }
    // Everything below the node that decided it inherits the same answer.
    if (cache) {
      for (var i = 0; i < chain.length; i++) cache.set(chain[i], hidden);
    }
    return hidden;
  }

  function chatTitle(item) {
    var el = item.querySelector(CHAT_TITLE_SELECTORS);
    return normLabel(el ? el.textContent : item.textContent);
  }

  // Titles from the last time a populated chat list was on screen. A snapshot
  // rather than a live read because Telegram is single-column on a phone:
  // opening a chat takes the list away, so reading it live would come back
  // empty at exactly the moment the lock has a decision to make.
  var lastKnownTitles = null;

  function refreshKnownTitles() {
    var items = document.querySelectorAll(CHAT_ITEM_SELECTORS);
    // Deliberately unbounded: an incomplete set would block chats the user is
    // allowed to read, which is a worse failure than the scan costing more.
    var cache = typeof Map === 'function' ? new Map() : null;
    var seen = [];
    for (var i = 0; i < items.length; i++) {
      if (isHidden(items[i], cache)) continue;
      var t = chatTitle(items[i]);
      if (t) seen.push(t);
    }
    if (seen.length) lastKnownTitles = seen;
  }

  function openChatTitle() {
    // document.title is the one unambiguous signal both Telegram clients set,
    // so it beats guessing at header markup that differs between them. The
    // prefix is an unread count, as in "(3) Family".
    var dt = String(document.title || '').replace(/^\\(\\d+\\)\\s*/, '').trim();
    if (dt && dt.toLowerCase() !== 'telegram') return dt;

    var nodes = document.querySelectorAll(OPEN_TITLE_SELECTORS);
    for (var i = 0; i < nodes.length; i++) {
      if (isHidden(nodes[i])) continue;
      var t = String(nodes[i].textContent || '').trim();
      if (t) return t;
    }
    return '';
  }

  function isChatAllowed(title) {
    var name = normLabel(title);
    if (!name) return true;
    var titles = lastKnownTitles || [];
    for (var i = 0; i < titles.length; i++) {
      // Either direction counts: the list truncates long names and the header
      // adds status suffixes, so neither side is reliably the whole string.
      if (titles[i] && (name.indexOf(titles[i]) !== -1 || titles[i].indexOf(name) !== -1)) {
        return true;
      }
    }
    return false;
  }

  function removeGuard() {
    var ov = document.getElementById(GUARD_ID);
    if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
  }

  function buildGuard() {
    var host = document.body || document.documentElement;
    if (!host) return null;

    var ov = document.createElement('div');
    ov.id = GUARD_ID;
    // Covers the viewport rather than just the conversation column: on a phone
    // Telegram is single-column, so there is no "rest of the app" to leave
    // usable behind it.
    ov.setAttribute(
      'style',
      'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483000;' +
        'display:flex;align-items:center;justify-content:center;' +
        'background:rgba(24,34,45,0.94);color:#fff;' +
        'font:15px/1.5 system-ui,-apple-system,sans-serif;'
    );

    var box = document.createElement('div');
    box.setAttribute('style', 'max-width:320px;text-align:center;padding:24px;');

    var icon = document.createElement('div');
    icon.textContent = '\\uD83D\\uDD12';
    icon.setAttribute('style', 'font-size:34px;margin-bottom:10px;');

    var heading = document.createElement('div');
    heading.textContent = 'Hidden by Focus Mode';
    heading.setAttribute('style', 'font-weight:600;margin-bottom:6px;');

    var sub = document.createElement('div');
    sub.textContent = "This chat isn't in your focus list.";
    sub.setAttribute('style', 'opacity:0.75;margin-bottom:16px;');

    var btn = document.createElement('button');
    btn.textContent = '\\u2190 Back to focus';
    btn.setAttribute(
      'style',
      'background:#3390ec;color:#fff;border:none;border-radius:20px;' +
        'padding:10px 18px;font:14px system-ui,sans-serif;'
    );
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      removeGuard();
      try {
        history.back();
      } catch (e2) {}
    });

    box.appendChild(icon);
    box.appendChild(heading);
    box.appendChild(sub);
    box.appendChild(btn);
    ov.appendChild(box);
    host.appendChild(ov);
    return ov;
  }

  function applyGuard() {
    if (!actionEnabled('focusLock')) {
      removeGuard();
      return;
    }
    refreshKnownTitles();
    // No chat list has ever been seen, so there is no basis for a decision.
    // Fail open: an overlay with nothing behind it and no way past is far worse
    // than letting one chat through.
    if (!lastKnownTitles) {
      removeGuard();
      return;
    }
    var open = openChatTitle();
    if (!open || isChatAllowed(open)) {
      removeGuard();
      return;
    }
    // Already up — re-posting on every scan would drown the log.
    if (document.getElementById(GUARD_ID)) return;
    if (buildGuard()) post({ type: 'action', what: 'focus-lock', chat: open });
  }

  // --- Playback + fullscreen reporting -------------------------------------
  // Not filtering: these two drive device state on the native side — a wake
  // lock while a video plays (an embedded WebView, unlike Chrome, does not set
  // FLAG_KEEP_SCREEN_ON itself) and a landscape lock while it is fullscreen.
  // Both reports are edge-triggered, so a steady state posts nothing.

  var lastPlaying = null;
  var lastFullscreen = null;

  function anyVideoPlaying() {
    var vids = document.getElementsByTagName('video');
    for (var i = 0; i < vids.length; i++) {
      if (!vids[i].paused && !vids[i].ended) return true;
    }
    return false;
  }

  function reportPlayback(playing) {
    if (playing === lastPlaying) return;
    lastPlaying = playing;
    post({ type: 'playback', playing: playing });
  }

  function reportFullscreen() {
    var on = !!(document.fullscreenElement || document.webkitFullscreenElement);
    if (on === lastFullscreen) return;
    lastFullscreen = on;
    post({ type: 'fullscreen', on: on });
  }

  // Media events do not bubble, but they do reach capture-phase listeners on
  // document. "play" asserts the state rather than re-deriving it: the
  // element's own flags are not always settled by the time it fires.
  document.addEventListener('play', function () { reportPlayback(true); }, true);
  document.addEventListener('pause', function () { reportPlayback(anyVideoPlaying()); }, true);
  document.addEventListener('ended', function () { reportPlayback(anyVideoPlaying()); }, true);
  document.addEventListener('fullscreenchange', reportFullscreen);
  document.addEventListener('webkitfullscreenchange', reportFullscreen);

  // Safety net: the site swaps its <video> element across SPA navigation, and
  // the Android WebView drops the occasional fullscreen event. A missed event
  // would otherwise strand the screen on (or the app in landscape) until the
  // next one.
  setInterval(function () {
    reportPlayback(anyVideoPlaying());
    reportFullscreen();
  }, 2000);

  // --- SPA survival ---------------------------------------------------------

  // The observer needs a root element, which does not always exist yet at
  // before-content-loaded time — so installing it is retried from boot().
  var observerInstalled = false;
  function installObserver() {
    if (observerInstalled || !document.documentElement) return;
    observerInstalled = true;
    new MutationObserver(function () {
      if (!document.getElementById(STYLE_ID)) applyCss();
      scheduleScan();
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  function onUrlChange() {
    // Catches SPA navigation — tapping Home pushState's to "/" without ever
    // hitting the native navigation policy.
    if (applyRedirects()) return;
    applyCss();
    // pathScope may have changed, so stale marks must go before rescanning.
    clearTextHides();
    scanText();
    applyGuard();
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
  // Telegram Web routes entirely through the hash (/k/#-1001234), so this is
  // its main navigation signal. onUrlChange is idempotent, so overlapping with
  // popstate costs nothing.
  window.addEventListener('hashchange', onUrlChange);

  // --- Public handle for re-injection from React Native --------------------

  window.__unhook = {
    apply: function (rules) {
      state.rules = rules;
      applyCss();
      // Without the clear, disabling a rule would leave its matches hidden.
      clearTextHides();
      scanText();
      syncFocus();
      applyGuard();
    },
    debug: function (on) {
      state.debug = !!on;
      applyCss();
      if (on) reportMatches();
    },
  };

  function boot() {
    if (applyRedirects()) return;
    installObserver();
    applyCss();
    scanText();
    // Both are idempotent, which matters: boot() runs up to five times per page
    // load. syncFocus only restarts the retry loop when the folder changed.
    syncFocus();
    applyGuard();
  }

  boot();
  // If the first pass ran before the document existed it did nothing, and on a
  // slow load the page may not be parsed yet. Each of these re-runs an
  // idempotent boot(), so whichever fires first makes the filters stick.
  document.addEventListener('DOMContentLoaded', boot);
  window.addEventListener('load', boot);
  setTimeout(boot, 300);
  setTimeout(boot, 1200);
  post({ type: 'ready', url: location.href });
})();
true;
`;
