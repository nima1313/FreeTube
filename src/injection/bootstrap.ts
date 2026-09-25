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
    // The chat filter's page flags ride along, and outside the debug swap:
    // they toggle state rather than hide a filtered element.
    var extra = ruleFor('chatWhitelist') || ruleFor('chatBlacklist') ? CHAT_FILTER_CSS : '';
    el.textContent = sels.join(',\\n') + decl + extra;
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
    // Telegram Web K has no <main> or landmark roles at all, so its column
    // ids are listed too — without them the guard would have nothing to anchor on.
    var anchors = document.querySelectorAll(
      'main, [role="main"], [role="navigation"], #column-left, #column-center'
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

  // --- Telegram Web K -------------------------------------------------------
  // Ported from the unhookTelegram extension. WebK's chat list is virtual —
  // only the on-screen rows are mounted — so anything that must see the whole
  // list works on WebK's own data through the globals it exposes
  // (appDialogsManager, apiManagerProxy, appImManager, rootScope). Every entry
  // point below is a no-op until those exist, and on the other profiles.

  function normLabel(s) {
    return String(s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
  }

  // A rule's comma-separated param as lowercase terms; empty while it is off.
  function terms(action) {
    if (!actionEnabled(action)) return [];
    var parts = actionParam(action).split(',');
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var t = normLabel(parts[i]);
      if (t) out.push(t);
    }
    return out;
  }

  function anyHit(title, list) {
    for (var i = 0; i < list.length; i++) {
      if (title.indexOf(list[i]) !== -1) return true;
    }
    return false;
  }

  // --- Focus folder ---------------------------------------------------------
  // Telegram's own folders are the dependable way to curate a chat list, so
  // this just opens the user's folder tab on load. WebK switches folders even
  // when a hidden tab is clicked, so hide-folder-tabs can stay on throughout.

  // Compares the .text-super label only; the unread badge is a sibling of it.
  function findFocusTab(name) {
    var tabs = document.querySelectorAll('#folders-tabs .menu-horizontal-div-item');
    for (var i = 0; i < tabs.length; i++) {
      var label = tabs[i].querySelector('.text-super');
      if (label && normLabel(label.textContent) === name) return tabs[i];
    }
    return null;
  }

  // WebK listens for taps on mousedown on touch devices and on click
  // elsewhere, so send both; each platform ignores the other.
  function tapTab(tab) {
    tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    tab.click();
  }

  var FOCUS_TICK_MS = 400;
  var FOCUS_GIVE_UP_MS = 20000;
  // Active this many ticks in a row counts as settled.
  var FOCUS_STABLE_TICKS = 3;
  var focusTimer = null;

  function startFocusRetries() {
    if (focusTimer) {
      clearTimeout(focusTimer);
      focusTimer = null;
    }
    if (!actionEnabled('focusFolder')) return;
    var name = normLabel(actionParam('focusFolder'));
    if (!name) return;

    var started = Date.now();
    var stable = 0;
    var clicks = 0;
    var seen = false;

    // Keeps checking after the first click lands: Telegram restores the
    // last-open folder a beat after load, which can undo an early click.
    function tick() {
      focusTimer = null;
      // Bail if the rule was switched off or the name edited mid-flight — a
      // stale loop would fight the folder the user has since chosen.
      if (!actionEnabled('focusFolder')) return;
      if (normLabel(actionParam('focusFolder')) !== name) return;

      var tab = findFocusTab(name);
      if (tab) seen = true;
      if (tab && tab.classList.contains('active')) {
        if (++stable >= FOCUS_STABLE_TICKS) {
          post({ type: 'action', what: 'focus-folder', name: name, clicks: clicks });
          return;
        }
      } else {
        stable = 0;
        if (tab) {
          tapTab(tab);
          clicks++;
        }
      }
      if (Date.now() - started < FOCUS_GIVE_UP_MS) {
        focusTimer = setTimeout(tick, FOCUS_TICK_MS);
        return;
      }
      post({ type: 'action', what: seen ? 'focus-folder-stuck' : 'focus-folder-missing', name: name });
    }

    tick();
  }

  // Restart the loop only when the folder actually changes: the bootstrap is
  // injected at three points and apply() runs on every unrelated toggle, and
  // neither should re-fight the current folder.
  var lastFocusKey;
  function syncFocus() {
    var key = actionEnabled('focusFolder') ? normLabel(actionParam('focusFolder')) : null;
    if (key === lastFocusKey) return;
    lastFocusKey = key;
    startFocusRetries();
  }

  // --- Chat-name filter -----------------------------------------------------
  // Hiding rows of a virtual list leaves gaps and never reaches rows that are
  // not mounted, so this filters the data behind it instead. Every folder list
  // pulls pages through dialogsFetcher(offset, limit) and takes live updates
  // through canUpdateDialog(dialog). While a filter is active the fetcher scans
  // the folder's whole list once and serves its pages out of the matches, so
  // Telegram itself renders a normal, gap-free list.

  var CHAT_PAGE_SIZE = 100;
  // Stop scanning huge accounts after this many dialogs.
  var CHAT_SCAN_CAP = 3000;
  // One scan serves every page of a list. Dialog order shifts as messages
  // arrive, hence the short lifetime.
  var CHAT_CACHE_MS = 30000;
  // Never keep the list hidden longer than this.
  var CHAT_LOADING_MAX_MS = 8000;
  var FILTERING_ATTR = 'data-unhook-tg-filtering';
  var LOADING_ATTR = 'data-unhook-tg-loading';
  var CHAT_FILTER_CSS =
    '\\nhtml[' + FILTERING_ATTR + '] #column-left .sidebar-left-contacts-section' +
    ' { display: none !important; }' +
    '\\nhtml[' + LOADING_ATTR + '] #folders-container { visibility: hidden !important; }';

  var chatFilter = { allow: [], block: [] };
  var chatFilterKey = JSON.stringify(chatFilter);
  var chatPatched = false;
  var chatLoading = false;
  var chatLoadingTimer = null;

  function chatFiltering() {
    return chatFilter.allow.length > 0 || chatFilter.block.length > 0;
  }

  function peerTitle(peerId) {
    var proxy = window.apiManagerProxy;
    var peer = null;
    try {
      peer = proxy && proxy.getPeer ? proxy.getPeer(peerId) : null;
    } catch (e) {}
    var title = '';
    if (peer) {
      title = peer.title || [peer.first_name, peer.last_name].filter(Boolean).join(' ');
    }
    var myId = window.rootScope && window.rootScope.myId;
    if (myId !== undefined && String(peerId) === String(myId)) title += ' saved messages';
    return title.toLowerCase();
  }

  function chatAllowed(peerId) {
    if (!chatFiltering()) return true;
    var title = peerTitle(peerId);
    if (chatFilter.allow.length && !anyHit(title, chatFilter.allow)) return false;
    return !anyHit(title, chatFilter.block);
  }

  // The prototype deepest in the chain that owns name — the base class, so
  // every folder list subclass (and its super calls) goes through the wrap.
  function baseOwner(obj, name) {
    var owner = null;
    for (var p = Object.getPrototypeOf(obj); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
      if (Object.prototype.hasOwnProperty.call(p, name)) owner = p;
    }
    return owner;
  }

  // The folder's whole dialog list (up to the cap), keeping only matches, in
  // Telegram's order (index descending).
  function scanMatches(list, origFetch) {
    var matches = [];
    var scanned = 0;
    function step(cursor) {
      return Promise.resolve(origFetch.call(list, cursor, CHAT_PAGE_SIZE)).then(function (res) {
        var page = (res && res.dialogs) || [];
        scanned += page.length;
        var next = Infinity;
        for (var i = 0; i < page.length; i++) {
          if (chatAllowed(page[i].peerId)) matches.push(page[i]);
          var v = page[i][list.indexKey];
          if (v !== undefined && v < next) next = v;
        }
        if (!res || res.isEnd || !page.length || scanned >= CHAT_SCAN_CAP) return matches;
        if (!isFinite(next) || next === cursor) return matches;
        return step(next);
      });
    }
    return step(undefined);
  }

  // The virtual list drops far-away rows and re-fetches them by cursor, so
  // every page must be a slice of the same filtered list.
  var chatScans = new WeakMap();

  function filteredDialogs(list, origFetch) {
    var hit = chatScans.get(list);
    if (hit && hit.key === chatFilterKey && Date.now() - hit.at < CHAT_CACHE_MS) {
      return hit.promise;
    }
    var promise = scanMatches(list, origFetch);
    var entry = { key: chatFilterKey, at: Date.now(), promise: promise };
    chatScans.set(list, entry);
    promise.catch(function () {
      if (chatScans.get(list) === entry) chatScans.delete(list);
    });
    return promise;
  }

  function patchDialogs(xd) {
    var fetchOwner = baseOwner(xd, 'dialogsFetcher');
    var updateOwner = baseOwner(xd, 'canUpdateDialog');
    if (!fetchOwner || !updateOwner) return false;

    var origFetch = fetchOwner.dialogsFetcher;
    fetchOwner.dialogsFetcher = function (offsetIndex, limit) {
      if (!chatFiltering()) return Promise.resolve(origFetch.call(this, offsetIndex, limit));
      // A normal page (dialogs after the cursor), but cut from the filtered
      // list and with its size as the total — so the virtual list sizes and
      // paginates exactly as if only the matches existed.
      var self = this;
      return filteredDialogs(self, origFetch).then(function (all) {
        var from = 0;
        if (offsetIndex != null) {
          from = all.length;
          for (var i = 0; i < all.length; i++) {
            if (all[i][self.indexKey] < offsetIndex) {
              from = i;
              break;
            }
          }
        }
        var to = from + (limit || CHAT_PAGE_SIZE);
        return {
          dialogs: all.slice(from, to),
          count: all.length,
          isTopEnd: from === 0,
          isEnd: to >= all.length,
        };
      });
    };

    var origCanUpdate = updateOwner.canUpdateDialog;
    updateOwner.canUpdateDialog = function (dialog) {
      if (dialog && !chatAllowed(dialog.peerId)) return false;
      return origCanUpdate.call(this, dialog);
    };
    return true;
  }

  // Both flags live on <html>, which may not exist yet on the first call, so
  // boot() re-applies them.
  function syncChatFlags() {
    var root = document.documentElement;
    if (!root) return;
    if (chatFiltering()) root.setAttribute(FILTERING_ATTR, '1');
    else root.removeAttribute(FILTERING_ATTR);
    if (chatLoading) root.setAttribute(LOADING_ATTR, '1');
    else root.removeAttribute(LOADING_ATTR);
  }

  function setChatLoading(on) {
    clearTimeout(chatLoadingTimer);
    chatLoading = on;
    if (on) {
      chatLoadingTimer = setTimeout(function () {
        setChatLoading(false);
      }, CHAT_LOADING_MAX_MS);
    }
    syncChatFlags();
  }

  // Rebuild the lists with the current filter. The visible one reloads now;
  // the others are just cleared and reload when their tab opens.
  function refreshLists() {
    var dm = window.appDialogsManager;
    if (!dm || !dm.xds) return;
    for (var id in dm.xds) {
      var xd = dm.xds[id];
      if (!xd || xd === dm.xd) continue;
      try {
        xd.reset();
        xd.clear();
      } catch (e) {
        console.warn('[unhook] could not clear a chat list', e);
      }
    }
    if (!dm.xd) return;
    Promise.resolve()
      .then(function () {
        return dm.xd.fullReset();
      })
      .catch(function (e) {
        console.warn('[unhook] chat list reload failed', e);
      })
      .then(function () {
        setChatLoading(false);
      });
  }

  function syncChatFilter() {
    var next = { allow: terms('chatWhitelist'), block: terms('chatBlacklist') };
    var key = JSON.stringify(next);
    if (key === chatFilterKey) return;
    var was = chatFiltering();
    chatFilter = next;
    chatFilterKey = key;
    syncChatFlags();
    if (!was && !chatFiltering()) return;
    if (chatPatched) refreshLists();
    // Keep the unfiltered list off screen until the patch lands and reloads it.
    else if (chatFiltering()) setChatLoading(true);
  }

  // Patched even while both filters are off (the wrap passes straight
  // through), so switching one on later needs no reload.
  if (ruleFor('chatWhitelist') || ruleFor('chatBlacklist')) {
    var chatPollStarted = Date.now();
    var chatPoll = setInterval(function () {
      var dm = window.appDialogsManager;
      if (dm && dm.xd && window.apiManagerProxy) {
        clearInterval(chatPoll);
        chatPatched = patchDialogs(dm.xd);
        if (!chatPatched) {
          console.warn('[unhook] WebK internals changed; chat-name filtering is unavailable');
          post({ type: 'action', what: 'chat-filter-unavailable' });
          setChatLoading(false);
          return;
        }
        if (chatFiltering()) refreshLists();
      } else if (Date.now() - chatPollStarted > 60000) {
        clearInterval(chatPoll);
        setChatLoading(false);
      }
    }, 50);
  }

  // --- Focus folder: load all of its chats ----------------------------------
  // WebK lists a folder's chats only if their dialogs are already in its local
  // cache, and never fetches the rest — so older chats added to the folder
  // silently never show up. Load those dialogs explicitly; WebK then adds them
  // to the folder list by itself.

  // The folder whose tab label is name: its filter (explicit chat list) and
  // dialog index key (e.g. "index_5" — a dialog belongs to the folder exactly
  // when it has a value under that key). Null if there is no such tab yet.
  function findFolder(name) {
    var tab = findFocusTab(name);
    var dm = window.appDialogsManager;
    if (!tab || !dm || !dm.managers) return Promise.resolve(null);
    var id = Number(tab.getAttribute('data-filter-id'));
    return Promise.resolve(dm.managers.filtersStorage.getFilter(id)).then(function (f) {
      if (!f || f.localId === undefined) return null;
      return { filter: f, key: 'index_' + f.localId };
    });
  }

  // Pinned and included chats, as peer ids and as input peers, index-aligned.
  function folderPeerIds(filter) {
    return (filter.pinnedPeerIds || []).concat(filter.includePeerIds || []);
  }

  function folderInputPeers(filter) {
    return (filter.pinned_peers || []).concat(filter.include_peers || []);
  }

  function hydrateFolder(name) {
    return findFolder(name).then(function (folder) {
      // Tabs not rendered yet — retry on the next tick.
      if (!folder) return null;
      var mm = window.appDialogsManager.managers.appMessagesManager;
      var ids = folderPeerIds(folder.filter);
      var inputs = folderInputPeers(folder.filter);
      return Promise.all(
        ids.map(function (id, i) {
          if (!inputs[i]) return null;
          return Promise.resolve(mm.getDialogOnly(id)).then(function (dialog) {
            return dialog ? null : inputs[i];
          });
        })
      ).then(function (found) {
        var missing = found.filter(Boolean);
        // The input peers carry access hashes, so this works even for chats
        // WebK has never seen.
        return Promise.all(
          missing.map(function (p) {
            return Promise.resolve(mm.reloadConversation(p)).catch(function () {});
          })
        ).then(function () {
          return { loaded: missing.length };
        });
      });
    });
  }

  // Folder name already loaded this page session.
  var hydrated = '';
  var hydrating = false;

  function maybeHydrate() {
    var name = actionEnabled('focusFolder') ? normLabel(actionParam('focusFolder')) : '';
    if (!name || name === hydrated || hydrating || !window.appDialogsManager) return;
    hydrating = true;
    Promise.resolve()
      .then(function () {
        return hydrateFolder(name);
      })
      .then(function (done) {
        if (!done) return;
        hydrated = name;
        post({ type: 'action', what: 'focus-folder-loaded', name: name, loaded: done.loaded });
        // A name-filtered list serves a cached scan — rebuild it to include
        // the chats that were just loaded.
        if (done.loaded && chatPatched && chatFiltering()) {
          chatScans = new WeakMap();
          refreshLists();
        }
      })
      .catch(function (e) {
        console.warn('[unhook] could not load folder chats', e);
      })
      .then(function () {
        hydrating = false;
      });
  }

  if (ruleFor('focusFolder')) setInterval(maybeHydrate, 500);

  // --- Focus lock -----------------------------------------------------------
  // The filters only shape the chat list; Telegram still opens any chat reached
  // another way (a channel link in a message, a mention). With the lock on, the
  // open chat is checked against Telegram's own data and covered unless it is
  // in the focus set:
  //   - in the focus folder (when focus-folder is on), or
  //   - matching a "show only" name (when that rule is on),
  //   - and never matching a "hide" name.
  // With neither a folder nor a "show only" list, only hidden names are blocked.

  var GUARD_ID = '__unhook_guard';
  var GUARD_TICK_MS = 100;
  // The peer the current verdict is for, and a token that discards stale
  // async verdicts.
  var guardPeer = null;
  var guardToken = 0;

  // The chat on screen, or 0. On a phone-width layout WebK closes a chat by
  // sliding back to the list without clearing chat.peerId, so the peer alone
  // would keep judging a chat the user already left. tabId (0 = chat list,
  // 1 = chat, 2 = profile) tracks what is actually showing.
  function openPeerId() {
    var im = window.appImManager;
    if (!im || !im.chat) return 0;
    if (im.tabId !== undefined && im.tabId < 1) return 0;
    return im.chat.peerId || 0;
  }

  function guardAllows(peerId) {
    var title = peerTitle(peerId);
    if (anyHit(title, terms('chatBlacklist'))) return false;
    var allow = terms('chatWhitelist');
    var folder = actionEnabled('focusFolder') ? normLabel(actionParam('focusFolder')) : '';
    if (allow.length && anyHit(title, allow)) return true;
    if (!folder) return !allow.length;
    return findFolder(folder).then(function (found) {
      // Folder not found (renamed, or not loaded yet): fail open.
      if (!found) return true;
      // The explicit list covers chats WebK has not cached yet.
      var listed = folderPeerIds(found.filter);
      for (var i = 0; i < listed.length; i++) {
        if (String(listed[i]) === String(peerId)) return true;
      }
      return Promise.resolve(
        window.appDialogsManager.managers.appMessagesManager.getDialogOnly(peerId)
      ).then(function (dialog) {
        return !!dialog && dialog[found.key] != null;
      });
    });
  }

  function removeGuard() {
    var ov = document.getElementById(GUARD_ID);
    if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
  }

  // Covers the open chat's message area only, which leaves Telegram's own
  // header — and its back arrow — usable. .bubbles runs the full height of the
  // chat behind the header, so the overlay starts below the header instead.
  // Falls back to the whole viewport.
  function positionGuard(ov) {
    var chat = document.querySelector('#column-center .chat.active');
    var target = chat && chat.querySelector('.bubbles');
    var r = target
      ? target.getBoundingClientRect()
      : { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight };
    var top = r.top;
    var bar = target && chat.querySelector('.topbar');
    if (bar) top = Math.max(top, bar.getBoundingClientRect().bottom);
    ov.style.top = top + 'px';
    ov.style.left = r.left + 'px';
    ov.style.width = r.width + 'px';
    ov.style.height = Math.max(0, r.top + r.height - top) + 'px';
  }

  function closeChat() {
    try {
      window.appImManager.setPeer({ peerId: 0 });
      return;
    } catch (e) {}
    try {
      history.back();
    } catch (e2) {}
  }

  function buildGuard() {
    var host = document.body || document.documentElement;
    if (!host) return null;

    var ov = document.createElement('div');
    ov.id = GUARD_ID;
    ov.setAttribute(
      'style',
      'position:fixed;z-index:2147483000;' +
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
      e.stopPropagation();
      removeGuard();
      closeChat();
    });

    box.appendChild(icon);
    box.appendChild(heading);
    box.appendChild(sub);
    box.appendChild(btn);
    ov.appendChild(box);
    host.appendChild(ov);
    return ov;
  }

  // Re-evaluates when the open chat changes, or always when force is set
  // (after a settings change).
  function checkGuard(force) {
    var peerId = actionEnabled('focusLock') ? openPeerId() : 0;
    if (!peerId) {
      guardPeer = null;
      guardToken++;
      removeGuard();
      return;
    }
    if (!force && peerId === guardPeer) {
      var up = document.getElementById(GUARD_ID);
      // Follow layout changes (rotation, the keyboard opening).
      if (up) positionGuard(up);
      return;
    }
    guardPeer = peerId;
    var token = ++guardToken;
    Promise.resolve()
      .then(function () {
        return guardAllows(peerId);
      })
      // On internal errors, never trap the user behind the overlay.
      .catch(function () {
        return true;
      })
      .then(function (ok) {
        if (token !== guardToken) return;
        if (ok) {
          removeGuard();
          return;
        }
        var ov = document.getElementById(GUARD_ID);
        if (!ov) {
          ov = buildGuard();
          if (!ov) return;
          post({ type: 'action', what: 'focus-lock', peer: String(peerId) });
        }
        positionGuard(ov);
      });
  }

  if (ruleFor('focusLock')) {
    setInterval(function () {
      if (actionEnabled('focusLock') && window.appImManager) checkGuard(false);
    }, GUARD_TICK_MS);
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

  // --- Downloads -------------------------------------------------------------
  // Not filtering either: this is what makes "Download" work at all. Telegram
  // Web K streams a file to disk through its service worker — it points a
  // hidden iframe at d/<id> and the SW answers with the file as an attachment.
  // In the WebView that response goes to react-native-webview's
  // DownloadListener, which hands the URL to Android's DownloadManager, and
  // that re-requests d/<id> from outside the WebView, where there is no SW:
  // the download fails after a few MB. So the URL is fetched here instead
  // (the SW serves page fetches too) and the bytes go to native as base64
  // chunks — see src/device/downloads.ts. Blob downloads get the same
  // treatment: DownloadManager cannot fetch blob: URLs either.

  var DL_CHUNK = 512 * 1024;
  var dlCount = 0;

  function isSwDownload(value) {
    try {
      var u = new URL(String(value), location.href);
      return u.origin === location.origin && /\\/d\\/\\d+$/.test(u.pathname) ? u.href : null;
    } catch (e) {
      return null;
    }
  }

  function dispositionName(header) {
    if (!header) return '';
    var m = /filename\\*\\s*=\\s*UTF-8''([^;]+)/i.exec(header);
    if (m) {
      try {
        return decodeURIComponent(m[1].trim());
      } catch (e) {}
    }
    m = /filename\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"/i.exec(header) || /filename\\s*=\\s*([^;]+)/i.exec(header);
    return m ? m[1].replace(/\\\\(.)/g, '$1').trim() : '';
  }

  function toBase64(parts) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () {
        var s = String(fr.result);
        resolve(s.slice(s.indexOf(',') + 1));
      };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsDataURL(new Blob(parts));
    });
  }

  function saveUrl(url, fallbackName) {
    var id = 'dl' + ++dlCount + '-' + Date.now();
    var started = false;
    fetch(url)
      .then(function (res) {
        if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
        var h = res.headers;
        post({
          type: 'download',
          phase: 'start',
          id: id,
          name: dispositionName(h.get('content-disposition')) || fallbackName || 'download',
          mime: (h.get('content-type') || 'application/octet-stream').split(';')[0].trim(),
          size: +h.get('content-length') || 0,
        });
        started = true;
        var reader = res.body.getReader();
        var parts = [];
        var buffered = 0;
        function flush() {
          if (!buffered) return Promise.resolve();
          var batch = parts;
          parts = [];
          buffered = 0;
          return toBase64(batch).then(function (data) {
            post({ type: 'download', phase: 'chunk', id: id, data: data });
          });
        }
        function pump() {
          return reader.read().then(function (r) {
            if (r.done) return flush();
            parts.push(r.value);
            buffered += r.value.byteLength;
            return (buffered >= DL_CHUNK ? flush() : Promise.resolve()).then(pump);
          });
        }
        return pump();
      })
      .then(function () {
        post({ type: 'download', phase: 'end', id: id });
      })
      .catch(function (e) {
        // Cancelling in Telegram errors the SW stream, which lands here too.
        post({
          type: 'download',
          phase: 'error',
          id: id,
          started: started,
          name: fallbackName || '',
          reason: String((e && e.message) || e),
        });
      });
  }

  (function () {
    var proto = window.HTMLIFrameElement && HTMLIFrameElement.prototype;
    var desc = proto && Object.getOwnPropertyDescriptor(proto, 'src');
    if (desc && desc.set && desc.configurable) {
      Object.defineProperty(proto, 'src', {
        configurable: true,
        enumerable: desc.enumerable,
        get: desc.get,
        set: function (v) {
          var dl = isSwDownload(v);
          // Leaving src unset means no navigation, so the DownloadListener
          // (and its doomed DownloadManager request) never fires.
          if (dl) saveUrl(dl);
          else desc.set.call(this, v);
        },
      });
    }
    var origSetAttr = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      if (this instanceof HTMLIFrameElement && String(name).toLowerCase() === 'src') {
        var dl = isSwDownload(value);
        if (dl) {
          saveUrl(dl);
          return;
        }
      }
      return origSetAttr.apply(this, arguments);
    };
  })();

  // WebK's fallback (and anything else saving a blob) clicks a detached
  // <a download href="blob:..."> and revokes the URL 100ms later; fetch() is
  // called synchronously here, which resolves the blob before that.
  window.addEventListener(
    'click',
    function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[download]') : null;
      if (!a || !/^(blob|data):/i.test(a.href)) return;
      e.preventDefault();
      saveUrl(a.href, a.getAttribute('download') || '');
    },
    true
  );

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
  // its only navigation signal. onUrlChange is idempotent, so overlapping with
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
      syncChatFilter();
      checkGuard(true);
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
    // All idempotent, which matters: boot() runs up to five times per page
    // load. syncFocus and syncChatFilter only act when their settings changed.
    syncFocus();
    syncChatFilter();
    syncChatFlags();
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
