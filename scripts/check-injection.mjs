// Local verification of everything testable without a device:
//  1. Transpiles the filter/injection/navigation modules to CJS
//  2. Syntax-checks the generated bootstrap + apply scripts
//  3. Runs the bootstrap inside jsdom for both profiles and asserts: style
//     injected, rule CSS applied, SPA pushState re-applies path-scoped CSS,
//     __unhook.apply() re-injection works, blocked-path clicks intercepted,
//     text filters hide suggested posts without false-positiving on captions
//  4. Unit-tests the shouldLoad navigation policy
//  5. Checks the build-variant switch in src/filters/profiles/index.ts
// Run: node scripts/check-injection.mjs
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const root = join(dirname(new URL(import.meta.url).pathname), '..');
const out = '/tmp/unhook-check';

const files = [
  'src/filters/types.ts',
  'src/filters/profiles/youtube.ts',
  'src/filters/profiles/instagram.ts',
  'src/filters/profiles/telegram.ts',
  'src/filters/profiles/index.ts',
  'src/filters/buildInjection.ts',
  'src/injection/bootstrap.ts',
  'src/webview/constants.ts',
  'src/webview/navigation.ts',
];
for (const f of files) {
  const js = ts.transpileModule(readFileSync(join(root, f), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const dest = join(out, f.replace(/\.ts$/, '.js'));
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, js);
}

const { youtubeProfile } = require(join(out, 'src/filters/profiles/youtube.js'));
const { instagramProfile } = require(join(out, 'src/filters/profiles/instagram.js'));
const { telegramProfile } = require(join(out, 'src/filters/profiles/telegram.js'));
const { buildBootstrap, buildApplyCall, buildDebugCall, activeBlockedPaths } = require(
  join(out, 'src/filters/buildInjection.js')
);
const { shouldLoad } = require(join(out, 'src/webview/navigation.js'));

let failures = 0;
// Promise-returning checks used to be fire-and-forget: a rejection surfaced as
// an unhandled rejection rather than a FAIL, so an async assertion could not
// actually fail the run. They are collected here and awaited before the summary.
const pending = [];
function fail(name, e) {
  failures++;
  console.error('FAIL  ' + name + ': ' + e.message);
}
function check(name, fn) {
  let result;
  try {
    result = fn();
  } catch (e) {
    fail(name, e);
    return;
  }
  if (result && typeof result.then === 'function') {
    pending.push(
      result.then(
        () => console.log('  ok  ' + name),
        (e) => fail(name, e)
      )
    );
    return;
  }
  console.log('  ok  ' + name);
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
// Telegram's focus-folder retry loop settles over ~1.4s of real time, so those
// assertions have to wait for it rather than run inline.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { JSDOM } = require('jsdom');
function boot(html, url, profile, enabledMap = {}, paramMap = {}) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const posted = [];
  window.ReactNativeWebView = { postMessage: (s) => posted.push(JSON.parse(s)) };
  window.eval(buildBootstrap(profile, enabledMap, paramMap));
  const css = () => window.document.getElementById('__unhook_css').textContent;
  return { window, posted, css };
}

console.log('\n-- script generation --');
const bootstrap = buildBootstrap(youtubeProfile, {});
check('bootstrap script is valid JS', () => new Function(bootstrap));
check('apply call is valid JS', () => new Function(buildApplyCall(youtubeProfile, { 'hide-comments': true })));
check('debug call is valid JS', () => new Function(buildDebugCall(true)));
check('rules were substituted', () => assert(!bootstrap.includes('__RULES__'), 'placeholder left in script'));
check('instagram bootstrap is valid JS', () => new Function(buildBootstrap(instagramProfile, {})));

console.log('\n-- youtube bootstrap behavior in jsdom --');
// Boots on Subscriptions because that is now the landing page — booting on /
// would (correctly) redirect away before any filtering runs.
const yt = boot(
  '<html><head></head><body><a id="short" href="/shorts/abc123">short</a></body></html>',
  'https://m.youtube.com/feed/subscriptions',
  youtubeProfile
);

check('posts ready message', () => assert(yt.posted.some((m) => m.type === 'ready'), JSON.stringify(yt.posted)));
check('style element installed', () => assert(yt.window.document.getElementById('__unhook_css'), 'missing style'));
check('shorts CSS applied on subscriptions', () =>
  assert(yt.css().includes('ytm-reel-shelf-renderer'), 'no shorts css'));
check('home-scoped CSS absent on subscriptions (pathScope ^/$)', () =>
  assert(!yt.css().includes('ytm-rich-grid-renderer'), 'home css leaked to subscriptions'));
check('watch-scoped CSS absent on subscriptions', () =>
  assert(!yt.css().includes('related-items'), 'watch css leaked'));
check('text-hide attribute selector always present', () =>
  assert(yt.css().includes('[data-unhook-hide="1"]'), 'attribute selector missing'));

check('pushState to /watch applies watch-scoped CSS', () => {
  yt.window.eval(buildApplyCall(youtubeProfile, { 'hide-related': true }));
  yt.window.history.pushState({}, '', '/watch?v=xyz');
  assert(yt.css().includes('related-items'), 'related css missing on /watch');
  assert(!yt.css().includes('ytm-rich-grid-renderer'), 'home css leaked to /watch');
});

check('re-apply disables a rule live', () => {
  yt.window.eval(buildApplyCall(youtubeProfile, { 'hide-related': true, 'hide-shorts': false }));
  assert(!yt.css().includes('ytm-reel-shelf-renderer'), 'shorts css still present after disable');
});

check('style element resurrected after removal', async () => {
  // MutationObserver fires async; force a mutation then flush microtasks
  yt.window.document.getElementById('__unhook_css').remove();
  yt.window.document.body.appendChild(yt.window.document.createElement('div'));
  return new Promise((resolve, reject) =>
    setTimeout(() => {
      yt.window.document.getElementById('__unhook_css')
        ? resolve()
        : reject(new Error('style not re-created'));
    }, 50)
  );
});

check('shorts click intercepted via blockPathPattern', () => {
  yt.window.eval(buildApplyCall(youtubeProfile, {})); // defaults: hide-shorts on
  const a = yt.window.document.getElementById('short');
  const ev = new yt.window.MouseEvent('click', { bubbles: true, cancelable: true });
  a.dispatchEvent(ev);
  assert(ev.defaultPrevented, 'click not prevented');
  assert(yt.posted.some((m) => m.type === 'blocked' && m.rule === 'hide-shorts'), 'no blocked message');
});

check('shorts click allowed when rule disabled', () => {
  yt.window.eval(buildApplyCall(youtubeProfile, { 'hide-shorts': false }));
  const a = yt.window.document.getElementById('short');
  const ev = new yt.window.MouseEvent('click', { bubbles: true, cancelable: true });
  a.dispatchEvent(ev);
  assert(!ev.defaultPrevented, 'click prevented while rule disabled');
});

console.log('\n-- remove-home redirect --');
check('youtube starts on subscriptions, not home', () =>
  assert(youtubeProfile.startUrl === 'https://m.youtube.com/feed/subscriptions',
    `startUrl is ${youtubeProfile.startUrl}`));

check('landing on / redirects to subscriptions', () => {
  const home = boot('<html><head></head><body></body></html>', 'https://m.youtube.com/', youtubeProfile);
  const hit = home.posted.find((m) => m.type === 'redirect');
  assert(hit, 'no redirect posted: ' + JSON.stringify(home.posted));
  assert(hit.rule === 'remove-home' && hit.to === '/feed/subscriptions', JSON.stringify(hit));
});

check('subscriptions itself is not redirected (no loop)', () => {
  const subs = boot(
    '<html><head></head><body></body></html>',
    'https://m.youtube.com/feed/subscriptions',
    youtubeProfile
  );
  assert(!subs.posted.some((m) => m.type === 'redirect'), 'redirected away from its own destination');
  assert(subs.css().includes('ytm-reel-shelf-renderer'), 'filters did not apply on subscriptions');
});

check('a self-matching redirect is refused rather than looping', () => {
  const looping = {
    ...youtubeProfile,
    rules: [{ id: 'loop', label: 'loop', enabledByDefault: true, redirect: { from: '/', to: '/anything' } }],
  };
  const dom = boot('<html><head></head><body></body></html>', 'https://m.youtube.com/', looping);
  assert(!dom.posted.some((m) => m.type === 'redirect'), 'loop guard did not fire');
});

check('disabling remove-home stops the redirect', () => {
  const home = boot(
    '<html><head></head><body></body></html>',
    'https://m.youtube.com/',
    youtubeProfile,
    { 'remove-home': false }
  );
  assert(!home.posted.some((m) => m.type === 'redirect'), 'redirected while rule disabled');
  assert(home.css().includes('ytm-rich-grid-renderer'), 'home-feed blanking missing as fallback');
});

console.log('\n-- instagram bootstrap behavior in jsdom --');
const IG_HTML = `<html><head></head><body><main>
  <article id="followed">
    <header><span>realfriend</span><time>2h</time></header>
    <div class="caption">this cafe was suggested for you know who</div>
  </article>
  <article id="suggested">
    <header><span>somebrand</span><span>Suggested for you</span></header>
    <div class="caption">buy stuff</div>
  </article>
  <a id="navreels" href="/reels/">Reels</a>
  <a id="dmreel" href="/reel/xyz123/">a reel someone sent</a>
</main></body></html>`;

const ig = boot(IG_HTML, 'https://www.instagram.com/', instagramProfile);

check('posts ready message', () => assert(ig.posted.some((m) => m.type === 'ready'), JSON.stringify(ig.posted)));
check('reels CSS applied', () => assert(ig.css().includes('a[href^="/reels/"]'), 'no reels css'));
check('suggested post is marked hidden', () =>
  assert(ig.window.document.getElementById('suggested').hasAttribute('data-unhook-hide'), 'not marked'));
check('followed post with "suggested for you" in the CAPTION is not hidden', () =>
  assert(!ig.window.document.getElementById('followed').hasAttribute('data-unhook-hide'),
    'false positive: caption text leaked into the match'));
check('explore CSS absent on /', () =>
  assert(!ig.css().includes('main a[href^="/p/"]'), 'explore css leaked to home'));

check('disabling following-only-feed clears the mark', () => {
  ig.window.eval(buildApplyCall(instagramProfile, { 'following-only-feed': false }));
  assert(!ig.window.document.getElementById('suggested').hasAttribute('data-unhook-hide'),
    'stale mark left behind after disabling the rule');
});

check('re-enabling re-marks it', () => {
  ig.window.eval(buildApplyCall(instagramProfile, {}));
  assert(ig.window.document.getElementById('suggested').hasAttribute('data-unhook-hide'), 'not re-marked');
});

check('pushState to /explore/ applies grid CSS and drops feed scope', () => {
  ig.window.history.pushState({}, '', '/explore/');
  assert(ig.css().includes('main a[href^="/p/"]'), 'explore css missing on /explore/');
  assert(!ig.window.document.getElementById('suggested').hasAttribute('data-unhook-hide'),
    'home-scoped text mark survived navigation off /');
});

check('search results page keeps the grid CSS OFF', () => {
  ig.window.history.pushState({}, '', '/explore/search/keyword/?q=cats');
  assert(!ig.css().includes('main a[href^="/p/"]'),
    'explore grid css leaked onto the search results page');
});

check('DM reel link is NOT click-intercepted', () => {
  ig.window.history.pushState({}, '', '/direct/inbox/');
  const a = ig.window.document.getElementById('dmreel');
  const ev = new ig.window.MouseEvent('click', { bubbles: true, cancelable: true });
  a.dispatchEvent(ev);
  assert(!ev.defaultPrevented, 'DM reel click was blocked — DM reels must still play');
});

console.log('\n-- shell-hiding guard --');
// Regression: hide-app-banner shipped with hideClosest reaching "body > div >
// div", which is Instagram's app shell. closest() walked up from an "Open app"
// button and display:none'd the entire site — a black screen after login.
check('a text filter that resolves to the app shell is refused', () => {
  const shellProfile = {
    ...instagramProfile,
    rules: [
      {
        id: 'greedy',
        label: 'greedy',
        enabledByDefault: true,
        textFilters: [
          {
            match: 'button',
            anyText: ['open in app'],
            hideClosest: 'body > div > div',
          },
        ],
      },
    ],
  };
  const dom = boot(
    '<html><head></head><body><div id="mount"><div id="shell">' +
      '<main><article>post</article></main>' +
      '<button>Open in app</button>' +
      '</div></div></body></html>',
    'https://www.instagram.com/',
    shellProfile
  );
  const shell = dom.window.document.getElementById('shell');
  assert(!shell.hasAttribute('data-unhook-hide'), 'app shell was hidden — black screen bug is back');
  assert(dom.posted.some((m) => m.type === 'refused'), 'no refusal reported: ' + JSON.stringify(dom.posted));
});

check('the guard still allows hiding an individual post', () => {
  // Fresh fixture: `ig` has been navigated off "/" by the tests above, where
  // following-only-feed's ^/$ scope no longer applies.
  const fresh = boot(IG_HTML, 'https://www.instagram.com/', instagramProfile);
  assert(fresh.window.document.getElementById('suggested').hasAttribute('data-unhook-hide'),
    'guard is too aggressive — real matches stopped working');
  assert(!fresh.window.document.querySelector('main').hasAttribute('data-unhook-hide'),
    'main was hidden');
});

check('hide-app-banner ships disabled', () => {
  const rule = instagramProfile.rules.find((r) => r.id === 'hide-app-banner');
  assert(rule && rule.enabledByDefault === false, 'unverified banner rule is on by default again');
});

console.log('\n-- repeat injection (3 injection points) --');
// BrowserScreen injects the same bootstrap via
// injectedJavaScriptBeforeContentLoaded, injectedJavaScript and onLoadEnd,
// because the before-content-loaded hook is unreliable on Android. Landing more
// than once must be harmless.
const rep = boot(IG_HTML, 'https://www.instagram.com/', instagramProfile);
check('re-injecting does not duplicate the style element', () => {
  rep.window.eval(buildBootstrap(instagramProfile, {}));
  rep.window.eval(buildBootstrap(instagramProfile, {}));
  const n = rep.window.document.querySelectorAll('style#__unhook_css').length;
  assert(n === 1, `expected 1 style element, got ${n}`);
});
check('re-injecting keeps filters applied', () => {
  assert(rep.css().includes('a[href^="/reels/"]'), 'css lost after re-injection');
  assert(rep.window.document.getElementById('suggested').hasAttribute('data-unhook-hide'),
    'text mark lost after re-injection');
  assert(!rep.window.document.getElementById('followed').hasAttribute('data-unhook-hide'),
    'false positive appeared after re-injection');
});
check('late boot re-applies after the style element is destroyed', () => {
  // Simulates the site wiping the head during a slow/hydrating load.
  rep.window.document.getElementById('__unhook_css').remove();
  rep.window.eval(buildBootstrap(instagramProfile, {}));
  assert(rep.window.document.getElementById('__unhook_css'), 'style not recreated');
  assert(rep.css().includes('a[href^="/reels/"]'), 'css not restored');
});

console.log('\n-- playback + fullscreen reporting --');
// These two message types are not diagnostics: BrowserScreen turns them into
// the wake lock and the fullscreen landscape lock, in release builds too.
const media = boot(
  '<html><head></head><body><video id="v"></video></body></html>',
  'https://m.youtube.com/watch?v=abc',
  youtubeProfile
);
const playbackMsgs = () => media.posted.filter((m) => m.type === 'playback');
const fullscreenMsgs = () => media.posted.filter((m) => m.type === 'fullscreen');
function fire(window, target, type) {
  target.dispatchEvent(new window.Event(type));
}

check('play posts playing:true', () => {
  // jsdom never sets video.paused = false, which is exactly why the "play"
  // handler asserts the state instead of re-deriving it from the element.
  fire(media.window, media.window.document.getElementById('v'), 'play');
  const last = playbackMsgs().pop();
  assert(last && last.playing === true, JSON.stringify(media.posted));
});

check('a second play does not post a duplicate', () => {
  const before = playbackMsgs().length;
  fire(media.window, media.window.document.getElementById('v'), 'play');
  assert(playbackMsgs().length === before, 'playback report is not edge-triggered');
});

check('pause posts playing:false', () => {
  fire(media.window, media.window.document.getElementById('v'), 'pause');
  const last = playbackMsgs().pop();
  assert(last && last.playing === false, JSON.stringify(playbackMsgs()));
});

check('entering fullscreen posts on:true', () => {
  Object.defineProperty(media.window.document, 'webkitFullscreenElement', {
    value: media.window.document.getElementById('v'),
    configurable: true,
  });
  fire(media.window, media.window.document, 'webkitfullscreenchange');
  const last = fullscreenMsgs().pop();
  assert(last && last.on === true, JSON.stringify(media.posted));
});

check('leaving fullscreen posts on:false', () => {
  Object.defineProperty(media.window.document, 'webkitFullscreenElement', {
    value: null,
    configurable: true,
  });
  fire(media.window, media.window.document, 'webkitfullscreenchange');
  const last = fullscreenMsgs().pop();
  assert(last && last.on === false, JSON.stringify(fullscreenMsgs()));
});

check('re-injecting does not duplicate the media listeners', () => {
  // All three injection points land on a real page; doubled listeners would
  // double every report (and, with the wake lock, unbalance it).
  const dup = boot(
    '<html><head></head><body><video id="v"></video></body></html>',
    'https://m.youtube.com/watch?v=abc',
    youtubeProfile
  );
  dup.window.eval(buildBootstrap(youtubeProfile, {}));
  fire(dup.window, dup.window.document.getElementById('v'), 'play');
  const n = dup.posted.filter((m) => m.type === 'playback').length;
  assert(n === 1, `expected 1 playback message, got ${n}`);
});

console.log('\n-- rule params --');
check('a paramMap is inert for profiles that declare no params', () =>
  assert(
    buildBootstrap(youtubeProfile, {}) === buildBootstrap(youtubeProfile, {}, { 'hide-shorts': 'x' }) &&
      !buildBootstrap(instagramProfile, {}).includes('"param"'),
    'param plumbing leaked into a profile that has none'
  ));
check('focus-folder ships its default, and a stored value overrides it', () => {
  assert(buildBootstrap(telegramProfile, {}).includes('"param":"focus mode"'), 'default missing');
  assert(
    buildBootstrap(telegramProfile, {}, { 'focus-folder': 'work only' }).includes('"param":"work only"'),
    'stored value ignored'
  );
});

console.log('\n-- telegram bootstrap behavior in jsdom --');
// Telegram Web is hash-routed, so pathname is always "/k/" and every path-based
// mechanism in the codebase is inert here. These fixtures use WebK markup.
const TG_CHATS =
  '<div id="folders-container">' +
  '<div class="menu-horizontal-div-item" id="tab-all">All</div>' +
  // Trailing unread count: baseLabel has to strip it or nothing matches.
  '<div class="menu-horizontal-div-item" id="tab-focus">focus mode 3</div>' +
  '</div>' +
  '<ul class="chatlist">' +
  '<a class="chatlist-chat" id="c1"><span class="peer-title">Family</span></a>' +
  '<a class="chatlist-chat" id="c2"><span class="peer-title">Work</span></a>' +
  '</ul>';
const tgHtml = (title, body) =>
  '<html><head><title>' + title + '</title></head><body>' +
  '<div id="column-left">' + body + '</div><div id="column-center"></div>' +
  '</body></html>';

const TG_URL = 'https://web.telegram.org/k/';

const tg = boot(tgHtml('Telegram', TG_CHATS), TG_URL, telegramProfile, {
  'focus-folder': true,
  'hide-folder-tabs': true,
});
// Attached after boot, so it misses the first (synchronous) click and sees the
// rest — enough to prove the loop targets the right tab.
const tgClicks = { focus: 0, all: 0 };
tg.window.document.getElementById('tab-focus').addEventListener('click', () => tgClicks.focus++);
tg.window.document.getElementById('tab-all').addEventListener('click', () => tgClicks.all++);

check('folder-tab CSS is deferred while the focus click is still landing', () =>
  assert(!tg.css().includes('#folders-container'),
    'tab bar hidden before the click landed — the click can never work'));

await sleep(2400);

check('focus folder reports success', () => {
  const hit = tg.posted.find((m) => m.what === 'focus-folder');
  assert(hit, 'no success posted: ' + JSON.stringify(tg.posted));
  assert(hit.name === 'focus mode', 'unread count not stripped from the tab label: ' + hit.name);
});
check('the focus tab was clicked and All was left alone', () =>
  assert(tgClicks.focus > 0 && tgClicks.all === 0, JSON.stringify(tgClicks)));
check('folder-tab CSS applies once the click has landed', () =>
  assert(tg.css().includes('#folders-container'), 'tab bar never hidden after the click'));

check('disabling focus-folder releases the deferred CSS immediately', () => {
  const off = boot(tgHtml('Telegram', TG_CHATS), TG_URL, telegramProfile, {
    'focus-folder': false,
    'hide-folder-tabs': true,
  });
  assert(off.css().includes('#folders-container'),
    'tab bar still deferred with nothing left to wait for');
});

// A folder that cannot be found keeps retrying for the full ~9s budget before
// giving up, which is too slow to assert on directly. The consequence that
// matters is testable immediately, and it is the right failure mode: if the
// folder never appears, the tab bar stays put so the user can still navigate.
check('a folder that is never found leaves the tab bar alone', async () => {
  const miss = boot(tgHtml('Telegram', TG_CHATS), TG_URL, telegramProfile,
    { 'focus-folder': true, 'hide-folder-tabs': true }, { 'focus-folder': 'no such folder' });
  await sleep(600);
  assert(!miss.css().includes('#folders-container'),
    'tab bar hidden even though the folder was never opened');
  assert(!miss.posted.some((m) => m.what === 'focus-folder'),
    'reported success without finding the folder');
});

console.log('\n-- telegram focus lock --');
const LOCK_ON = { 'focus-lock': true };
const guard = (d) => d.window.document.getElementById('__unhook_guard');

check('a chat the list never offered is covered', () => {
  const d = boot(tgHtml('Spam Channel', TG_CHATS), TG_URL, telegramProfile, LOCK_ON);
  assert(guard(d), 'no overlay: ' + JSON.stringify(d.posted));
});

check('a chat that is in the list is left alone', () => {
  const d = boot(tgHtml('Family', TG_CHATS), TG_URL, telegramProfile, LOCK_ON);
  assert(!guard(d), 'overlay covered an allowed chat');
});

check('the unread-count prefix is stripped from the open chat title', () => {
  const d = boot(tgHtml('(3) Family', TG_CHATS), TG_URL, telegramProfile, LOCK_ON);
  assert(!guard(d), 'an allowed chat was blocked because of its unread badge');
});

// The regression the desktop extension has: it reads the allowed set live from
// the visible chat list. On a phone Telegram is single-column, so opening a
// chat takes that list away and the lock fails open exactly when it matters.
check('the allowed set survives the chat list leaving the DOM', () => {
  const d = boot(tgHtml('Family', TG_CHATS), TG_URL, telegramProfile, LOCK_ON);
  assert(!guard(d), 'setup: allowed chat should not be covered');
  d.window.document.querySelector('.chatlist').remove();
  d.window.document.title = 'Spam Channel';
  d.window.eval(buildApplyCall(telegramProfile, LOCK_ON));
  assert(guard(d), 'lock failed open once the list was off-screen');
});

check('fails open when no chat list has ever been seen', () => {
  const d = boot(tgHtml('Spam Channel', ''), TG_URL, telegramProfile, LOCK_ON);
  assert(!guard(d), 'user trapped behind an overlay with no way to populate the list');
});

check('the overlay goes away when the lock is switched off', () => {
  const d = boot(tgHtml('Spam Channel', TG_CHATS), TG_URL, telegramProfile, LOCK_ON);
  assert(guard(d), 'setup: overlay should be up');
  d.window.eval(buildApplyCall(telegramProfile, { 'focus-lock': false }));
  assert(!guard(d), 'overlay survived the rule being disabled');
});

check('hash navigation re-evaluates the lock', async () => {
  const d = boot(tgHtml('Family', TG_CHATS), TG_URL, telegramProfile, LOCK_ON);
  d.window.document.title = 'Spam Channel';
  d.window.location.hash = '#-1001234';
  // hashchange is dispatched from a queued task, not synchronously.
  await sleep(50);
  assert(guard(d), 'hashchange did not re-run the guard — Telegram routes only by hash');
});

console.log('\n-- shouldLoad navigation policy --');
const ytPolicy = {
  allowedHosts: youtubeProfile.allowedHosts,
  blockedPathPatterns: activeBlockedPaths(youtubeProfile, {}),
  blockedSchemes: youtubeProfile.blockedSchemes,
};
const ytCases = [
  ['https://m.youtube.com/', true],
  ['https://m.youtube.com/watch?v=abc', true],
  ['https://accounts.google.com/signin', true],
  ['https://accounts.youtube.com/x', true],
  ['https://m.youtube.com/shorts/abc', false],
  ['intent://m.youtube.com/#Intent;package=com.google.android.youtube;end', false],
  ['vnd.youtube:abc123', false],
  ['market://details?id=com.google.android.youtube', false],
  ['https://example.com/', false],
  ['https://evilyoutube.com/', false],
  ['about:blank', true],
];
for (const [url, expected] of ytCases) {
  check(`yt shouldLoad(${url}) === ${expected}`, () =>
    assert(shouldLoad({ url }, ytPolicy) === expected, `got ${shouldLoad({ url }, ytPolicy)}`));
}
check('shorts allowed when hide-shorts is off', () =>
  assert(
    shouldLoad(
      { url: 'https://m.youtube.com/shorts/abc' },
      { ...ytPolicy, blockedPathPatterns: activeBlockedPaths(youtubeProfile, { 'hide-shorts': false }) }
    ) === true,
    'blocked'
  ));

const igPolicy = {
  allowedHosts: instagramProfile.allowedHosts,
  blockedPathPatterns: activeBlockedPaths(instagramProfile, {}),
  blockedSchemes: instagramProfile.blockedSchemes,
};
check('instagram blocks no paths (DM reels must open)', () =>
  assert(igPolicy.blockedPathPatterns.length === 0, `got ${JSON.stringify(igPolicy.blockedPathPatterns)}`));

const igCases = [
  ['https://www.instagram.com/', true],
  ['https://www.instagram.com/explore/', true],
  ['https://www.instagram.com/direct/inbox/', true],
  // The decision the user made: a reel sent in DMs still opens.
  ['https://www.instagram.com/reel/abc123/', true],
  ['https://www.instagram.com/reels/', true],
  ['https://accountscenter.instagram.com/', true],
  ['https://www.facebook.com/checkpoint/', true],
  ['intent://instagram.com/#Intent;package=com.instagram.android;end', false],
  ['instagram://media?id=123', false],
  ['market://details?id=com.instagram.android', false],
  ['https://example.com/', false],
  ['https://evilinstagram.com/', false],
];
for (const [url, expected] of igCases) {
  check(`ig shouldLoad(${url}) === ${expected}`, () =>
    assert(shouldLoad({ url }, igPolicy) === expected, `got ${shouldLoad({ url }, igPolicy)}`));
}

const tgPolicy = {
  allowedHosts: telegramProfile.allowedHosts,
  blockedPathPatterns: activeBlockedPaths(telegramProfile, {}),
  blockedSchemes: telegramProfile.blockedSchemes,
};
// Not an oversight: Telegram routes through the hash, so pathname is always
// "/k/" and a path pattern could only ever match everything or nothing.
check('telegram blocks no paths (hash routing makes them meaningless)', () =>
  assert(tgPolicy.blockedPathPatterns.length === 0, `got ${JSON.stringify(tgPolicy.blockedPathPatterns)}`));

const tgCases = [
  ['https://web.telegram.org/k/', true],
  ['https://web.telegram.org/k/#-1001234', true],
  ['https://telegram.org/', true],
  ['https://t.me/somechannel', true],
  ['tg://resolve?domain=somechannel', false],
  ['intent://t.me/x#Intent;package=org.telegram.messenger;end', false],
  ['market://details?id=org.telegram.messenger', false],
  ['https://example.com/', false],
  ['https://eviltelegram.org/', false],
];
for (const [url, expected] of tgCases) {
  check(`tg shouldLoad(${url}) === ${expected}`, () =>
    assert(shouldLoad({ url }, tgPolicy) === expected, `got ${shouldLoad({ url }, tgPolicy)}`));
}

console.log('\n-- build-variant switch --');
const indexPath = join(out, 'src/filters/profiles/index.js');
function loadActiveProfile(value) {
  delete require.cache[indexPath];
  if (value === undefined) delete process.env.EXPO_PUBLIC_APP_PROFILE;
  else process.env.EXPO_PUBLIC_APP_PROFILE = value;
  return require(indexPath).activeProfile;
}
check('unset EXPO_PUBLIC_APP_PROFILE defaults to youtube', () =>
  assert(loadActiveProfile(undefined).id === 'youtube', 'wrong default'));
check('EXPO_PUBLIC_APP_PROFILE=instagram selects instagram', () =>
  assert(loadActiveProfile('instagram').id === 'instagram', 'variable ignored'));
check('EXPO_PUBLIC_APP_PROFILE=telegram selects telegram', () =>
  assert(loadActiveProfile('telegram').id === 'telegram', 'variable ignored'));
check('unknown value falls back to youtube', () =>
  assert(loadActiveProfile('nope').id === 'youtube', 'no fallback'));

await sleep(200);
await Promise.all(pending);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
