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
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
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
const { buildBootstrap, buildApplyCall, buildDebugCall, buildFocusBreakCall, pausedEnabledMap, activeBlockedPaths } = require(
  join(out, 'src/filters/buildInjection.js')
);
const { shouldLoad, externalTarget } = require(join(out, 'src/webview/navigation.js'));

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
// Telegram's focus-folder loop, chat-filter patch and focus lock all run on
// timers, so those assertions have to wait for them rather than run inline.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { JSDOM } = require('jsdom');
// setup(window) runs before the bootstrap, for fixtures that must already be
// in place when it boots (Telegram's fake internals, click listeners).
function boot(html, url, profile, enabledMap = {}, paramMap = {}, setup) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const posted = [];
  window.ReactNativeWebView = { postMessage: (s) => posted.push(JSON.parse(s)) };
  if (setup) setup(window);
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

console.log('\n-- downloads --');
// WebK streams a download through its service worker at d/<id>. The bootstrap
// must fetch that URL itself (never let the iframe navigate, which hands it to
// Android's DownloadManager) and post the bytes as ordered base64 chunks.
function dlBoot(respond) {
  const fetched = [];
  const b = boot('<html><head></head><body></body></html>', 'https://web.telegram.org/k/', telegramProfile, {}, {}, (w) => {
    w.fetch = (url) => {
      fetched.push(String(url));
      return Promise.resolve(respond(String(url)));
    };
  });
  const msgs = () => b.posted.filter((m) => m.type === 'download');
  return { ...b, fetched, msgs };
}
function streamOf(chunks, { failAfter } = {}) {
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (failAfter !== undefined && i === failAfter) return c.error(new Error('DOWNLOAD_CANCELED'));
      if (i < chunks.length) c.enqueue(chunks[i++]);
      else c.close();
    },
  });
}
const waitFor = async (cond, ms = 2000) => {
  for (let t = 0; t < ms && !cond(); t += 10) await sleep(10);
};

check('WebK d/<id> iframe is fetched in-page and never navigates', async () => {
  // 1.3 MB in uneven parts, so the 512 KB batching has to split and join.
  const bytes = new Uint8Array(1300 * 1024).map((_, i) => (i * 31) & 255);
  const parts = [bytes.subarray(0, 700000), bytes.subarray(700000, 700001), bytes.subarray(700001)];
  const dl = dlBoot(
    () =>
      new Response(streamOf(parts), {
        headers: {
          'Content-Type': 'application/vnd.android.package-archive',
          'Content-Disposition': `attachment; filename="_.apk"; filename*=UTF-8''${encodeURIComponent('برنامه.apk')}`,
          'Content-Length': String(bytes.length),
        },
      })
  );
  const iframe = dl.window.document.createElement('iframe');
  iframe.src = 'd/12345';
  dl.window.document.body.append(iframe);
  assert(!iframe.getAttribute('src'), 'iframe was allowed to navigate to ' + iframe.getAttribute('src'));
  assert(dl.fetched[0] === 'https://web.telegram.org/k/d/12345', 'fetched ' + JSON.stringify(dl.fetched));
  await waitFor(() => dl.msgs().some((m) => m.phase === 'end' || m.phase === 'error'));
  const m = dl.msgs();
  const start = m[0];
  assert(start.phase === 'start', JSON.stringify(m.map((x) => x.phase)));
  assert(start.name === 'برنامه.apk', 'name ' + start.name);
  assert(start.mime === 'application/vnd.android.package-archive', 'mime ' + start.mime);
  assert(start.size === bytes.length, 'size ' + start.size);
  assert(m[m.length - 1].phase === 'end', 'last phase ' + m[m.length - 1].phase);
  const chunks = m.filter((x) => x.phase === 'chunk');
  assert(chunks.length >= 2 && chunks.every((x) => x.id === start.id), 'chunks ' + chunks.length);
  const got = Buffer.concat(chunks.map((x) => Buffer.from(x.data, 'base64')));
  assert(got.equals(Buffer.from(bytes)), `bytes differ (${got.length} vs ${bytes.length})`);
});

check('setAttribute("src", d/<id>) is caught too', () => {
  const dl = dlBoot(() => new Response(streamOf([new Uint8Array([1])])));
  const iframe = dl.window.document.createElement('iframe');
  iframe.setAttribute('src', '/k/d/777');
  assert(!iframe.getAttribute('src'), 'navigated');
  assert(dl.fetched[0] === 'https://web.telegram.org/k/d/777', JSON.stringify(dl.fetched));
});

check('ordinary iframe src passes through untouched', () => {
  const dl = dlBoot(() => new Response(''));
  const a = dl.window.document.createElement('iframe');
  a.src = 'https://web.telegram.org/k/embed/1';
  const b = dl.window.document.createElement('iframe');
  b.setAttribute('src', 'https://example.com/d/12');
  assert(a.src === 'https://web.telegram.org/k/embed/1', 'src was ' + a.src);
  assert(b.getAttribute('src') === 'https://example.com/d/12', 'cross-origin d/ swallowed');
  assert(dl.fetched.length === 0, 'fetched ' + JSON.stringify(dl.fetched));
});

check('a stream cancelled mid-download posts error', async () => {
  const dl = dlBoot(() => new Response(streamOf([new Uint8Array(10)], { failAfter: 1 })));
  dl.window.document.createElement('iframe').src = 'd/9';
  await waitFor(() => dl.msgs().some((m) => m.phase === 'error' || m.phase === 'end'));
  const last = dl.msgs().pop();
  assert(last.phase === 'error' && last.started === true, JSON.stringify(last));
});

check('blob: anchor download is intercepted and saved under its download name', async () => {
  const dl = dlBoot(() => new Response(streamOf([new Uint8Array([7, 8, 9])])));
  const a = dl.window.document.createElement('a');
  a.href = 'blob:https://web.telegram.org/0000-1111';
  a.download = 'photo.jpg';
  dl.window.document.body.append(a);
  const ev = new dl.window.MouseEvent('click', { bubbles: true, cancelable: true });
  a.dispatchEvent(ev);
  assert(ev.defaultPrevented, 'default navigation not prevented');
  assert(dl.fetched[0] === 'blob:https://web.telegram.org/0000-1111', JSON.stringify(dl.fetched));
  await waitFor(() => dl.msgs().some((m) => m.phase === 'end'));
  assert(dl.msgs()[0].name === 'photo.jpg', 'name ' + dl.msgs()[0].name);
});

check('a WebK document download carries its document id', async () => {
  const dl = dlBoot(() => new Response(streamOf([new Uint8Array([1, 2])])));
  const w = dl.window;
  w.appDownloadManager = {
    downloadToDisc(options) {
      // Like WebK: the id is set synchronously, the iframe after a SW ping.
      options.downloadId = '555';
      setTimeout(() => (w.document.createElement('iframe').src = 'd/555'), 0);
      return Promise.resolve();
    },
  };
  await sleep(600);
  w.appDownloadManager.downloadToDisc({ media: { _: 'document', id: '9001' } });
  await waitFor(() => dl.msgs().some((m) => m.phase === 'end'));
  assert(dl.msgs()[0].doc === '9001', 'start message: ' + JSON.stringify(dl.msgs()[0]));
});

check('tapping a saved document opens it instead of downloading again', () => {
  const dl = dlBoot(() => new Response(''));
  const doc = dl.window.document;
  doc.body.innerHTML =
    '<div class="document ext-apk" data-doc-id="42"><div class="document-ico"><div class="preloader-container"></div></div></div>' +
    '<div class="document ext-zip" data-doc-id="43"></div>' +
    '<div class="bubbles is-selecting"><div class="document" data-doc-id="44"></div></div>';
  const reached = [];
  for (const el of doc.querySelectorAll('.document')) {
    el.addEventListener('mousedown', () => reached.push(el.dataset.docId));
    el.addEventListener('click', () => reached.push(el.dataset.docId));
  }
  dl.window.__unhook.savedDocs(['42', '44']);
  const saved = doc.querySelector('[data-doc-id="42"]');
  assert(saved.hasAttribute('data-unhook-saved'), 'saved document not marked');
  assert(dl.css().includes('[data-unhook-saved] .preloader-container'), 'no style for saved documents');
  const tap = (el) => {
    const down = new dl.window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
    el.dispatchEvent(down);
    el.dispatchEvent(new dl.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    return down;
  };
  const down = tap(saved.querySelector('.preloader-container'));
  assert(down.defaultPrevented, 'tap not taken over');
  const opens = dl.msgs().filter((m) => m.phase === 'open');
  assert(opens.length === 1 && opens[0].doc === '42', 'open messages: ' + JSON.stringify(opens));
  tap(doc.querySelector('[data-doc-id="43"]'));
  tap(doc.querySelector('[data-doc-id="44"]'));
  assert(JSON.stringify(reached) === '["43","43","44","44"]', 'WebK saw: ' + JSON.stringify(reached));
  assert(dl.msgs().filter((m) => m.phase === 'open').length === 1, 'unsaved or selecting tap opened a file');
  dl.window.__unhook.savedDocs(['43'], true);
  assert(doc.querySelector('[data-doc-id="43"]').hasAttribute('data-unhook-saved'), 'add did not mark');
  dl.window.__unhook.savedDocs([]);
  assert(!doc.querySelector('[data-unhook-saved]'), 'replace with nothing left marks behind');
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
// Telegram Web is hash-routed, so pathname is always "/k/" inside the app.
// These fixtures use WebK markup, and fakeWebK stands in for the internals the
// chat filter and focus lock read (appDialogsManager, apiManagerProxy,
// appImManager, rootScope).
const TG_URL = 'https://web.telegram.org/k/';
const TG_TABS =
  '<div class="folders-tabs-scrollable"><nav id="folders-tabs">' +
  '<div class="menu-horizontal-div-item active" data-filter-id="0" id="tab-all">' +
  '<span class="text-super">All</span></div>' +
  // The unread badge is a sibling of the label, so it must not break matching.
  '<div class="menu-horizontal-div-item" data-filter-id="5" id="tab-focus">' +
  '<span class="text-super">Focus Mode</span><div class="badge">3</div></div>' +
  '</nav></div>';
const TG_HTML =
  '<html><head></head><body>' +
  '<div id="column-left">' + TG_TABS + '<div id="folders-container"></div></div>' +
  '<div id="column-center"><div class="chat active">' +
  '<div class="sidebar-header topbar"></div><div class="bubbles"></div></div></div>' +
  '</body></html>';

// Folder tabs switch like WebK's: the tapped one becomes .active. On touch
// devices WebK listens for mousedown instead of click.
function wireTabs(window, clicks, { touch = false } = {}) {
  const tabs = window.document.querySelectorAll('.menu-horizontal-div-item');
  for (const tab of tabs) {
    tab.addEventListener(touch ? 'mousedown' : 'click', () => {
      clicks[tab.id] = (clicks[tab.id] || 0) + 1;
      for (const t of tabs) t.classList.toggle('active', t === tab);
    });
  }
}

// Dialogs are numbered 1..n in list order, with WebK's descending index keys:
// index_0 for All, index_5 for the "focus mode" folder's members.
// mobile: closing a chat only slides back to the list (tabId 0) and keeps
// chat.peerId, as WebK does on a phone-width layout.
// uncached: folder members WebK has no dialog for yet (they are on the
// folder's explicit list, but getDialogOnly returns nothing until
// reloadConversation loads them).
function fakeWebK(window, { names, folder = [], uncached = [], myId, openPeer = 0, mobile = false }) {
  const all = names.map((name, i) => {
    const d = { peerId: i + 1, index_0: 100000 - i };
    if (folder.includes(name) || uncached.includes(name)) d.index_5 = 100000 - i;
    return d;
  });
  const dialogs = all.filter((d) => !uncached.includes(names[d.peerId - 1]));
  const members = folder.concat(uncached).map((n) => names.indexOf(n) + 1);
  const filter5 = {
    localId: 5,
    includePeerIds: members,
    include_peers: members.map((id) => ({ _: 'inputPeerUser', user_id: id })),
  };
  const calls = { fetches: 0, fullResets: 0, otherResets: 0, setPeer: [], reloaded: [] };
  // Methods live on a base class, as in WebK, and the lists are a subclass:
  // the patch has to land on the base for every list to go through it.
  class BaseList {
    dialogsFetcher(offsetIndex, limit) {
      calls.fetches++;
      const own = dialogs.filter((d) => d[this.indexKey] !== undefined);
      let from = 0;
      if (offsetIndex != null) {
        from = own.findIndex((d) => d[this.indexKey] < offsetIndex);
        if (from === -1) from = own.length;
      }
      const page = own.slice(from, from + limit);
      return Promise.resolve({ dialogs: page, count: own.length, isEnd: from + limit >= own.length });
    }
    canUpdateDialog() {
      return true;
    }
  }
  // WebK's lists override the fetcher and call super, so wrapping the first
  // owner found would only catch this subclass; ArchiveList proves the base
  // was patched.
  class FolderList extends BaseList {
    dialogsFetcher(offsetIndex, limit) {
      return super.dialogsFetcher(offsetIndex, limit);
    }
  }
  class ArchiveList extends BaseList {}
  const xd = new FolderList();
  xd.indexKey = 'index_0';
  xd.fullReset = () => {
    calls.fullResets++;
    return Promise.resolve();
  };
  const other = new ArchiveList();
  other.indexKey = 'index_5';
  other.reset = () => calls.otherResets++;
  other.clear = () => {};
  window.appDialogsManager = {
    xd,
    xds: { 0: xd, 5: other },
    managers: {
      appMessagesManager: {
        getDialogOnly: (peerId) => Promise.resolve(dialogs.find((d) => d.peerId === peerId)),
        reloadConversation: (input) => {
          calls.reloaded.push(input.user_id);
          if (!dialogs.some((d) => d.peerId === input.user_id)) {
            dialogs.push(all.find((d) => d.peerId === input.user_id));
          }
          return Promise.resolve();
        },
      },
      filtersStorage: { getFilter: (id) => Promise.resolve(id === 5 ? filter5 : undefined) },
    },
  };
  window.apiManagerProxy = {
    getPeer: (peerId) => {
      const name = names[peerId - 1];
      return peerId === myId ? { first_name: name } : { title: name };
    },
  };
  window.rootScope = { myId };
  window.appImManager = {
    chat: { peerId: openPeer },
    tabId: openPeer ? 1 : 0,
    setPeer({ peerId }) {
      calls.setPeer.push(peerId);
      this.tabId = peerId ? 1 : 0;
      if (peerId || !mobile) this.chat.peerId = peerId;
    },
  };
  const id = (name) => names.indexOf(name) + 1;
  return { xd, other, dialogs, calls, id };
}

// Pages through the (possibly patched) fetcher the way WebK's list does.
async function listAll(xd, limit = 20) {
  const seen = [];
  let cursor;
  let first;
  for (;;) {
    const res = await xd.dialogsFetcher(cursor, limit);
    first = first || res;
    seen.push(...res.dialogs);
    if (res.isEnd || !res.dialogs.length) break;
    cursor = res.dialogs[res.dialogs.length - 1][xd.indexKey];
  }
  return { seen, count: first.count };
}

console.log('\n-- telegram focus folder --');
check('stay-on-webk sends WebA back to /k/', () => {
  const d = boot(TG_HTML, 'https://web.telegram.org/a/', telegramProfile);
  const hit = d.posted.find((m) => m.type === 'redirect');
  assert(hit && hit.rule === 'stay-on-webk' && hit.to === '/k/', JSON.stringify(d.posted));
});
check('/k/ itself is not redirected', () => {
  const d = boot(TG_HTML, TG_URL, telegramProfile);
  assert(!d.posted.some((m) => m.type === 'redirect'), JSON.stringify(d.posted));
});

check('folder-tab CSS applies right away, even with focus-folder on', () => {
  const d = boot(TG_HTML, TG_URL, telegramProfile, { 'focus-folder': true, 'hide-folder-tabs': true });
  assert(d.css().includes('.folders-tabs-scrollable'), 'tab bar CSS withheld');
});

check('the focus tab is clicked, settles, and reports success', async () => {
  const clicks = {};
  const d = boot(TG_HTML, TG_URL, telegramProfile,
    { 'focus-folder': true, 'hide-folder-tabs': true }, {}, (w) => wireTabs(w, clicks));
  // The first click lands at once, but success waits for three settled ticks
  // (~1.2s) — Telegram may still restore the previous folder before then.
  await sleep(700);
  assert(!d.posted.some((m) => m.what === 'focus-folder'), 'success reported before the folder settled');
  await sleep(1100);
  const hit = d.posted.find((m) => m.what === 'focus-folder');
  assert(hit && hit.name === 'focus mode', 'no success posted: ' + JSON.stringify(d.posted));
  assert(clicks['tab-focus'] >= 1 && !clicks['tab-all'], JSON.stringify(clicks));
  assert(d.window.document.getElementById('tab-focus').classList.contains('active'), 'folder not open');
});

check('the folder is re-opened when Telegram restores the last one', async () => {
  const clicks = {};
  const d = boot(TG_HTML, TG_URL, telegramProfile, { 'focus-folder': true }, {}, (w) => wireTabs(w, clicks));
  await sleep(100);
  // What Telegram does a beat after load: put the previously open folder back.
  d.window.document.getElementById('tab-all').click();
  await sleep(2000);
  assert(clicks['tab-focus'] >= 2, 'restored folder was not fought: ' + JSON.stringify(clicks));
  assert(d.window.document.getElementById('tab-focus').classList.contains('active'), 'folder not open');
});

check('the focus tab is tapped the way WebK listens on touch devices', async () => {
  const clicks = {};
  const d = boot(TG_HTML, TG_URL, telegramProfile, { 'focus-folder': true }, {},
    (w) => wireTabs(w, clicks, { touch: true }));
  await sleep(1800);
  assert(d.window.document.getElementById('tab-focus').classList.contains('active'),
    'folder not opened by mousedown: ' + JSON.stringify(clicks));
  assert(clicks['tab-focus'] === 1, 'kept tapping an open folder: ' + JSON.stringify(clicks));
});

check('a folder that does not exist is never faked', async () => {
  const clicks = {};
  const d = boot(TG_HTML, TG_URL, telegramProfile, { 'focus-folder': true },
    { 'focus-folder': 'no such folder' }, (w) => wireTabs(w, clicks));
  await sleep(600);
  assert(!Object.keys(clicks).length, 'clicked a tab: ' + JSON.stringify(clicks));
  assert(!d.posted.some((m) => m.what === 'focus-folder'), 'reported success without the folder');
});

console.log('\n-- telegram chat-name filter --');
// 250 chats, so a correct scan has to page past the first 100.
const NAMES = ['Family', 'Me'];
for (let i = 0; i < 250; i++) NAMES.push('Spam ' + i);
NAMES.splice(200, 0, 'Work chat');
const ME = NAMES.indexOf('Me') + 1;
const WHITELIST = { 'show-only-chats': true };

check('chat-name params default to empty', () => {
  const js = buildBootstrap(telegramProfile, {});
  assert(js.includes('"id":"show-only-chats"') && js.includes('"id":"hide-chats"'), 'rules missing');
  assert(js.includes('"param":"","enabled":false'), 'default not empty');
});

check('whitelist serves a gap-free list of only the matches', async () => {
  let wk;
  const d = boot(TG_HTML, TG_URL, telegramProfile, WHITELIST, { 'show-only-chats': 'family, WORK' },
    (w) => (wk = fakeWebK(w, { names: NAMES, myId: ME })));
  // Past the 300ms and 1200ms boot() re-runs, which must not reload the list.
  await sleep(1400);
  const { seen, count } = await listAll(wk.xd, 1);
  const titles = seen.map((x) => NAMES[x.peerId - 1]);
  assert(JSON.stringify(titles) === '["Family","Work chat"]', 'got ' + JSON.stringify(titles));
  assert(count === 2, 'count should be the filtered total, got ' + count);
  assert(wk.calls.fullResets === 1 && wk.calls.otherResets === 1, JSON.stringify(wk.calls));
  const root = d.window.document.documentElement;
  assert(root.hasAttribute('data-unhook-tg-filtering'), 'filtering flag missing');
  assert(!root.hasAttribute('data-unhook-tg-loading'), 'list left hidden after reload');
  assert(d.css().includes('html[data-unhook-tg-loading] #folders-container'), 'flag CSS missing');
});

check('every folder list is filtered, not just the open one', async () => {
  let wk;
  boot(TG_HTML, TG_URL, telegramProfile, WHITELIST, { 'show-only-chats': 'family' },
    (w) => (wk = fakeWebK(w, { names: NAMES, myId: ME, folder: ['Family', 'Spam 1'] })));
  await sleep(200);
  const { seen } = await listAll(wk.other);
  assert(seen.length === 1 && seen[0].peerId === wk.id('Family'), JSON.stringify(seen));
  assert(wk.other.canUpdateDialog({ peerId: wk.id('Spam 1') }) === false, 'live update got through');
});

check('the whole list is scanned once, not per page', async () => {
  let wk;
  boot(TG_HTML, TG_URL, telegramProfile, WHITELIST, { 'show-only-chats': 'work' },
    (w) => (wk = fakeWebK(w, { names: NAMES, myId: ME })));
  await sleep(200);
  await listAll(wk.xd, 1);
  const afterFirst = wk.calls.fetches;
  assert(afterFirst === 3, `expected 3 pages of 100 for 253 chats, got ${afterFirst}`);
  await listAll(wk.xd, 1);
  assert(wk.calls.fetches === afterFirst, `re-scanned: ${wk.calls.fetches - afterFirst} extra fetches`);
});

check('blacklist removes matches and blocks live updates', async () => {
  let wk;
  boot(TG_HTML, TG_URL, telegramProfile, { 'hide-chats': true }, { 'hide-chats': 'spam' },
    (w) => (wk = fakeWebK(w, { names: NAMES, myId: ME })));
  await sleep(200);
  const { seen, count } = await listAll(wk.xd, 50);
  assert(count === 3 && seen.length === 3, `expected Family, Me, Work chat; got ${count}`);
  assert(wk.xd.canUpdateDialog({ peerId: wk.id('Spam 3') }) === false, 'a hidden chat got a live update');
  assert(wk.xd.canUpdateDialog({ peerId: wk.id('Family') }) === true, 'an allowed chat was frozen');
});

check('"saved messages" matches your own chat', async () => {
  let wk;
  boot(TG_HTML, TG_URL, telegramProfile, WHITELIST, { 'show-only-chats': 'saved messages' },
    (w) => (wk = fakeWebK(w, { names: NAMES, myId: ME })));
  await sleep(200);
  const { seen } = await listAll(wk.xd);
  assert(seen.length === 1 && seen[0].peerId === ME, JSON.stringify(seen));
});

check('switching the filter off restores the full list', async () => {
  let wk;
  const d = boot(TG_HTML, TG_URL, telegramProfile, WHITELIST, { 'show-only-chats': 'family' },
    (w) => (wk = fakeWebK(w, { names: NAMES, myId: ME })));
  await sleep(200);
  d.window.eval(buildApplyCall(telegramProfile, {}, { 'show-only-chats': 'family' }));
  await sleep(50);
  const { count } = await listAll(wk.xd, 100);
  assert(count === NAMES.length, `expected ${NAMES.length}, got ${count}`);
  assert(wk.calls.fullResets === 2, 'list not reloaded on toggle: ' + wk.calls.fullResets);
  assert(!d.window.document.documentElement.hasAttribute('data-unhook-tg-filtering'), 'flag left on');
});

check('the list stays hidden until WebK is ready, then filters', async () => {
  const d = boot(TG_HTML, TG_URL, telegramProfile, WHITELIST, { 'show-only-chats': 'family' });
  const root = d.window.document.documentElement;
  assert(root.hasAttribute('data-unhook-tg-loading'), 'unfiltered list shown before the patch');
  const wk = fakeWebK(d.window, { names: NAMES, myId: ME });
  await sleep(200);
  assert(!root.hasAttribute('data-unhook-tg-loading'), 'list never revealed');
  assert((await listAll(wk.xd)).count === 1, 'late patch did not filter');
});

check('hiding the menu button keeps the search back arrow', () => {
  const d = boot(TG_HTML, TG_URL, telegramProfile, { 'hide-menu-button': true });
  const doc = d.window.document;
  const burger = doc.createElement('div');
  burger.className = 'left-sidebar-burger';
  burger.innerHTML = '<div class="animated-menu-icon"></div>';
  doc.getElementById('column-left').appendChild(burger);
  const icon = burger.firstChild;
  const sels = telegramProfile.rules.find((r) => r.id === 'hide-menu-button').css;
  const hidden = () => sels.some((s) => icon.matches(s));
  assert(hidden(), 'hamburger icon not hidden');
  icon.classList.add('state-back');
  assert(!hidden(), 'back arrow hidden in search mode — no way out of search');
});

check('other profiles carry none of the chat filter', () =>
  assert(!buildBootstrap(youtubeProfile, {}).includes('"jsAction":"chatWhitelist"'), 'leaked'));

console.log('\n-- telegram focus folder: loading uncached chats --');
check('folder chats missing from the cache are loaded, once', async () => {
  let wk;
  const d = boot(TG_HTML, TG_URL, telegramProfile, { 'focus-folder': true }, {},
    (w) => (wk = fakeWebK(w, { names: NAMES, myId: ME, folder: ['Family'], uncached: ['Spam 3', 'Spam 9'] })));
  await sleep(1300);
  const got = wk.calls.reloaded.slice().sort((a, b) => a - b);
  assert(JSON.stringify(got) === JSON.stringify([wk.id('Spam 3'), wk.id('Spam 9')]),
    'reloaded ' + JSON.stringify(wk.calls.reloaded));
  const hit = d.posted.find((m) => m.what === 'focus-folder-loaded');
  assert(hit && hit.loaded === 2, JSON.stringify(d.posted));
});

check('loading folder chats rebuilds a name-filtered list', async () => {
  let wk;
  boot(TG_HTML, TG_URL, telegramProfile, { 'focus-folder': true, ...WHITELIST },
    { 'show-only-chats': 'work' },
    (w) => (wk = fakeWebK(w, { names: NAMES, myId: ME, uncached: ['Work chat'] })));
  await sleep(1300);
  assert(wk.calls.reloaded.length === 1, 'not loaded: ' + JSON.stringify(wk.calls));
  assert(wk.calls.fullResets === 2, 'list not rebuilt after loading: ' + wk.calls.fullResets);
  assert((await listAll(wk.xd)).count === 1, 'loaded chat missing from the filtered list');
});

check('nothing is loaded while focus-folder is off', async () => {
  let wk;
  boot(TG_HTML, TG_URL, telegramProfile, {}, {},
    (w) => (wk = fakeWebK(w, { names: NAMES, myId: ME, uncached: ['Spam 3'] })));
  await sleep(700);
  assert(!wk.calls.reloaded.length, 'loaded chats for a disabled rule');
});

console.log('\n-- telegram: keep downloaded media --');
function cacheBoot(cacheTTL) {
  const set = [];
  const d = boot(TG_HTML, TG_URL, telegramProfile, {}, {}, (w) => {
    fakeWebK(w, { names: NAMES, myId: ME });
    w.appDialogsManager.managers.appStateManager = {
      getState: () => Promise.resolve({ settings: { cacheTTL } }),
      setByKey: (key, value) => {
        set.push([key, value]);
        return Promise.resolve();
      },
    };
  });
  return { d, set };
}

check("WebK's 1-week media cache becomes a year; a user's own choice stays", async () => {
  const def = cacheBoot(7 * 86400);
  const own = cacheBoot(14 * 86400);
  await sleep(1300);
  assert(JSON.stringify(def.set) === JSON.stringify([['settings.cacheTTL', 365 * 86400]]), 'default kept: ' + JSON.stringify(def.set));
  assert(!own.set.length, "overrode the user's setting: " + JSON.stringify(own.set));
});

console.log('\n-- telegram focus lock --');
const guard = (d) => d.window.document.getElementById('__unhook_guard');
const LOCK = { 'focus-lock': true, 'focus-folder': true };
const FOLDER = ['Family', 'Work chat'];
function lockBoot(open, enabled = LOCK, params = {}, opts = {}) {
  let wk;
  const d = boot(TG_HTML, TG_URL, telegramProfile, enabled, params, (w) => {
    wk = fakeWebK(w, { names: NAMES, myId: ME, folder: FOLDER, ...opts });
    w.appImManager.chat.peerId = wk.id(open);
    w.appImManager.tabId = 1;
    if (opts.setup) opts.setup(w, wk);
  });
  return { d, wk };
}

check('a chat outside the focus folder is covered', async () => {
  const { d } = lockBoot('Spam 7');
  await sleep(250);
  assert(guard(d), 'no overlay: ' + JSON.stringify(d.posted));
  assert(d.posted.some((m) => m.what === 'focus-lock'), 'lock not reported');
});

check('a chat in the folder is left alone', async () => {
  const { d } = lockBoot('Work chat');
  await sleep(250);
  assert(!guard(d), 'overlay covered a folder chat');
});

check('membership falls back to filtersStorage for an unloaded folder', async () => {
  const { d } = lockBoot('Spam 7', LOCK, {}, { setup: (w) => delete w.appDialogsManager.xds[5] });
  await sleep(250);
  assert(guard(d), 'no overlay without a loaded folder list');
});

check('an uncached chat on the folder list is left alone', async () => {
  const { d } = lockBoot('Spam 7', LOCK, {}, {
    uncached: ['Spam 7'],
    // Keep it uncached so only the explicit list can vouch for it.
    setup: (w) => (w.appDialogsManager.managers.appMessagesManager.reloadConversation = () => Promise.resolve()),
  });
  await sleep(250);
  assert(!guard(d), 'covered a chat that is in the folder');
});

check('a hidden name is blocked even inside the folder', async () => {
  const { d } = lockBoot('Family', { ...LOCK, 'hide-chats': true }, { 'hide-chats': 'family' });
  await sleep(250);
  assert(guard(d), 'blacklisted folder chat got through');
});

check('without a folder, the "show only" list decides', async () => {
  const on = { 'focus-lock': true, 'show-only-chats': true };
  const ok = lockBoot('Work chat', on, { 'show-only-chats': 'work' });
  const bad = lockBoot('Spam 7', on, { 'show-only-chats': 'work' });
  await sleep(250);
  assert(!guard(ok.d), 'whitelisted chat covered');
  assert(guard(bad.d), 'non-whitelisted chat got through');
});

check('with no focus set at all, nothing is blocked', async () => {
  const { d } = lockBoot('Spam 7', { 'focus-lock': true });
  await sleep(250);
  assert(!guard(d), 'blocked a chat with nothing to compare against');
});

check('a folder that cannot be found fails open', async () => {
  const { d } = lockBoot('Spam 7', LOCK, { 'focus-folder': 'no such folder' });
  await sleep(250);
  assert(!guard(d), 'user trapped by a renamed folder');
});

check('broken internals fail open', async () => {
  const { d } = lockBoot('Spam 7', LOCK, {}, {
    setup: (w) => {
      w.appDialogsManager.managers.appMessagesManager.getDialogOnly = () => {
        throw new Error('changed');
      };
    },
  });
  await sleep(250);
  assert(!guard(d), 'user trapped by an internal error');
});

check('opening an allowed chat takes the overlay down', async () => {
  const { d, wk } = lockBoot('Spam 7');
  await sleep(250);
  assert(guard(d), 'setup: overlay should be up');
  d.window.appImManager.chat.peerId = wk.id('Family');
  await sleep(250);
  assert(!guard(d), 'overlay stayed over an allowed chat');
});

check('"Back to focus" closes the chat', async () => {
  const { d, wk } = lockBoot('Spam 7');
  await sleep(250);
  guard(d).querySelector('button').click();
  assert(!guard(d), 'overlay survived the button');
  assert(JSON.stringify(wk.calls.setPeer) === '[0]', 'chat not closed: ' + JSON.stringify(wk.calls.setPeer));
});

check('a chat left open behind the list is not judged (mobile)', async () => {
  const { d } = lockBoot('Spam 7', LOCK, {}, { mobile: true });
  await sleep(250);
  assert(guard(d), 'setup: overlay should be up');
  // Telegram's own back arrow on a phone: back to the list, peerId unchanged.
  d.window.appImManager.tabId = 0;
  await sleep(250);
  assert(!guard(d), 'overlay stayed over the chat list');
  // A settings change re-checks with force; the stale chat must stay ignored.
  d.window.eval(buildApplyCall(telegramProfile, { ...LOCK, 'hide-folder-tabs': true }));
  await sleep(250);
  assert(!guard(d), 'settings change put the overlay back over the list');
});

check('"Back to focus" does not trap the user on mobile', async () => {
  const { d, wk } = lockBoot('Spam 7', LOCK, {}, { mobile: true });
  await sleep(250);
  guard(d).querySelector('button').click();
  await sleep(300);
  assert(d.window.appImManager.chat.peerId === wk.id('Spam 7'), 'setup: fake should keep the peer');
  assert(!guard(d), 'overlay came back over the chat list');
});

check('reopening the same blocked chat is covered again', async () => {
  const { d } = lockBoot('Spam 7', LOCK, {}, { mobile: true });
  await sleep(250);
  d.window.appImManager.tabId = 0;
  await sleep(250);
  d.window.appImManager.tabId = 1;
  await sleep(250);
  assert(guard(d), 'blocked chat got through on the second visit');
});

check('the overlay starts below the chat header', async () => {
  const { d } = lockBoot('Spam 7', LOCK, {}, {
    setup: (w) => {
      const doc = w.document;
      const rect = (top, height) => () => ({ top, left: 0, width: 400, height, bottom: top + height });
      doc.querySelector('.bubbles').getBoundingClientRect = rect(0, 800);
      doc.querySelector('.topbar').getBoundingClientRect = rect(0, 56);
    },
  });
  await sleep(250);
  const s = guard(d).style;
  assert(s.top === '56px' && s.height === '744px', `covers the header: top ${s.top}, height ${s.height}`);
});

check('the overlay goes away when the lock is switched off', async () => {
  const { d } = lockBoot('Spam 7');
  await sleep(250);
  assert(guard(d), 'setup: overlay should be up');
  d.window.eval(buildApplyCall(telegramProfile, { 'focus-folder': true }));
  assert(!guard(d), 'overlay survived the rule being disabled');
});

// Moves the page's clock forward (the break is timed with Date.now).
function skipAhead(w, ms) {
  const now = w.Date.now.bind(w.Date);
  w.Date.now = () => now() + ms;
}
const breakPill = (d) => d.window.document.getElementById('__unhook_break');
// What Settings' "Unlock for 1 minute" injects.
const startBreak = (d) => d.window.eval(buildFocusBreakCall(d.window.Date.now() + 60000));

check('the overlay only offers "Back to focus"', async () => {
  const { d } = lockBoot('Spam 7');
  await sleep(250);
  const buttons = [...guard(d).querySelectorAll('button')].map((b) => b.textContent);
  assert(buttons.length === 1, 'buttons: ' + JSON.stringify(buttons));
});

check('"Unlock for 1 minute" lifts the lock, then it comes back', async () => {
  const { d } = lockBoot('Spam 7');
  await sleep(250);
  startBreak(d);
  assert(!guard(d), 'overlay survived the break');
  await sleep(250);
  assert(!guard(d), 'overlay came back during the break');
  assert(/Focus Mode back in (1:00|0:[0-5]\d)$/.test(breakPill(d).textContent), 'countdown: ' + breakPill(d).textContent);
  assert(breakPill(d).style.pointerEvents === 'none', 'countdown blocks taps');
  assert(d.posted.some((m) => m.what === 'focus-break'), 'break not reported');
  skipAhead(d.window, 61000);
  await sleep(250);
  assert(guard(d), 'lock did not come back after a minute');
  assert(!breakPill(d), 'countdown outlived the break');
});

console.log('\n-- telegram focus lock: other folders --');
const folderGuard = (d) => d.window.document.getElementById('__unhook_folder_guard');
function folderBoot(enabled = LOCK, setup) {
  const clicks = {};
  const d = boot(TG_HTML, TG_URL, telegramProfile, enabled, {}, (w) => {
    fakeWebK(w, { names: NAMES, myId: ME, folder: FOLDER });
    wireTabs(w, clicks);
    const doc = w.document;
    const box = (top, height) => () => ({ top, left: 0, width: 400, height, right: 400, bottom: top + height });
    const list = doc.getElementById('folders-container');
    list.getBoundingClientRect = box(100, 600);
    doc.querySelector('.folders-tabs-scrollable').getBoundingClientRect = box(56, 48);
    doc.elementsFromPoint = () => [list];
    if (setup) setup(w);
  });
  const tab = (id) => d.window.document.getElementById(id);
  return { d, clicks, tab };
}
// The launch switch to the focus folder settles after 3 ticks of 400 ms.
const FOCUS_SETTLE_MS = 1700;

check('another folder is covered, the focus folder is not', async () => {
  const { d, tab } = folderBoot();
  await sleep(FOCUS_SETTLE_MS);
  assert(tab('tab-focus').classList.contains('active'), 'setup: focus folder should be open');
  assert(!folderGuard(d), 'covered the focus folder');
  tab('tab-all').click();
  await sleep(250);
  const ov = folderGuard(d);
  assert(ov, 'other folder left open');
  assert(ov.style.top === '104px' && ov.style.height === '596px', `covers the tabs: top ${ov.style.top}, height ${ov.style.height}`);
  assert(d.posted.some((m) => m.what === 'focus-lock-folder'), 'not reported');
  tab('tab-focus').click();
  await sleep(250);
  assert(!folderGuard(d), 'overlay stayed on the focus folder');
});

check('"Back to focus" on a folder switches to the focus folder', async () => {
  const { d, tab } = folderBoot();
  await sleep(FOCUS_SETTLE_MS);
  tab('tab-all').click();
  await sleep(250);
  folderGuard(d).querySelector('button').click();
  assert(tab('tab-focus').classList.contains('active'), 'focus folder not opened');
  await sleep(250);
  assert(!folderGuard(d), 'overlay survived the button');
});

check('the break lifts the folder lock too', async () => {
  const { d, tab } = folderBoot();
  await sleep(FOCUS_SETTLE_MS);
  tab('tab-all').click();
  await sleep(250);
  assert(folderGuard(d), 'setup: folder should be covered');
  startBreak(d);
  await sleep(250);
  assert(!folderGuard(d), 'other folder still covered during the break');
  assert(tab('tab-all').classList.contains('active'), 'break switched folders');
  skipAhead(d.window, 61000);
  await sleep(250);
  assert(folderGuard(d), 'folder lock did not come back');
});

check('a break pauses every filter except redirects', () => {
  const real = { ...LOCK, 'hide-folder-tabs': true, 'hide-search': true, 'stay-on-webk': true };
  const paused = pausedEnabledMap(telegramProfile, real);
  const on = Object.keys(paused).filter((id) => paused[id]);
  assert(JSON.stringify(on) === '["stay-on-webk"]', 'still on: ' + JSON.stringify(on));
  assert(Object.keys(paused).length === telegramProfile.rules.length, 'some rules left to their defaults');
});

check('during a break the filters come off, then come back and reopen the focus folder', async () => {
  const real = { ...LOCK, 'hide-folder-tabs': true };
  const { d, tab } = folderBoot(real);
  await sleep(FOCUS_SETTLE_MS);
  const css = () => d.window.document.getElementById('__unhook_css').textContent;
  assert(css().includes('folders-tabs-scrollable'), 'setup: tabs should be hidden');
  // What App does on "Unlock for 1 minute".
  d.window.eval(buildApplyCall(telegramProfile, pausedEnabledMap(telegramProfile, real)));
  startBreak(d);
  await sleep(250);
  assert(!css().includes('folders-tabs-scrollable'), 'tabs still hidden during the break');
  assert(/Focus Mode back in/.test((breakPill(d) || {}).textContent), 'no countdown while the lock rule is paused');
  tab('tab-all').click();
  await sleep(250);
  assert(!folderGuard(d) && tab('tab-all').classList.contains('active'), 'could not leave the focus folder');
  // ...and when it ends.
  skipAhead(d.window, 61000);
  d.window.eval(buildApplyCall(telegramProfile, real));
  await sleep(FOCUS_SETTLE_MS);
  assert(css().includes('folders-tabs-scrollable'), 'tabs not hidden again');
  assert(tab('tab-focus').classList.contains('active'), 'focus folder not reopened');
  assert(!breakPill(d), 'countdown outlived the break');
});

check('folders stay open without the lock, during search, and when the list is not showing', async () => {
  const off = folderBoot({ 'focus-folder': true });
  const search = folderBoot(LOCK, (w) => w.document.body.classList.add('is-search-active'));
  const behind = folderBoot(LOCK, (w) => (w.document.elementsFromPoint = () => [w.document.body]));
  await sleep(FOCUS_SETTLE_MS);
  for (const b of [off, search, behind]) b.tab('tab-all').click();
  await sleep(250);
  assert(!folderGuard(off.d), 'covered with the lock off');
  assert(!folderGuard(search.d), 'covered search results');
  assert(!folderGuard(behind.d), 'covered something that is over the list');
});

console.log('\n-- telegram voice recording --');
// WebK's own recorder (WebAudio + WebCodecs) is noisy in the WebView; the
// bootstrap swaps in a MediaRecorder one and re-wraps its WebM Opus as Ogg.
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
function ebml(idHex, payload, unknown = false) {
  const id = idHex.match(/../g).map((h) => parseInt(h, 16));
  const size = [0x01];
  for (let i = 6; i >= 0; i--) size.push(unknown ? 0xff : Math.floor(payload.length / 2 ** (8 * i)) & 255);
  return [...id, ...size, ...payload];
}
const OPUS_HEAD = [...ascii('OpusHead'), 1, 1, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0];
// TOC 0xf8: CELT 20 ms, one frame (960 samples). 0xfb + 0x03: three frames.
const VOICE_PACKETS = [
  [0xf8, ...new Array(80).fill(1)],
  [0xf8, ...new Array(299).fill(2)],
  [0xfb, 0x03, ...new Array(40).fill(3)],
  [0xf8, 4, 5, 6],
];
const VOICE_SAMPLES = 960 * 3 + 2880;
function voiceWebm() {
  const blocks = VOICE_PACKETS.map((p, i) => ebml('A3', [0x81, 0, i, 0x80, ...p]));
  const track = ebml('AE', [
    ...ebml('D7', [1]),
    ...ebml('86', ascii('A_OPUS')),
    ...ebml('63A2', OPUS_HEAD),
    ...ebml('E1', ebml('9F', [1])),
  ]);
  // Chrome writes Segment and Cluster with unknown sizes while recording.
  const segment = [
    ...ebml('1549A966', ebml('2AD7B1', [0x0f, 0x42, 0x40])),
    ...ebml('1654AE6B', track),
    ...ebml('1F43B675', [...ebml('E7', [0]), ...blocks.flat()], true),
  ];
  return new Uint8Array([...ebml('1A45DFA3', ebml('4282', ascii('webm'))), ...ebml('18538067', segment, true)]);
}
// An Ogg reader written independently of the bootstrap's writer, including
// a bit-by-bit CRC.
function crcBitwise(b) {
  let c = 0;
  for (const x of b) {
    c ^= x << 24;
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
  }
  return c >>> 0;
}
function readOgg(buf) {
  const b = Buffer.from(buf);
  const pages = [];
  const packets = [];
  let cur = [];
  let p = 0;
  while (p < b.length) {
    assert(b.toString('latin1', p, p + 4) === 'OggS', 'no capture pattern at ' + p);
    const nseg = b[p + 26];
    const lacing = [...b.subarray(p + 27, p + 27 + nseg)];
    const bodyLen = lacing.reduce((a, x) => a + x, 0);
    const page = Buffer.from(b.subarray(p, p + 27 + nseg + bodyLen));
    const crc = page.readUInt32LE(22);
    page.writeUInt32LE(0, 22);
    assert(crcBitwise(page) === crc, 'bad CRC on page ' + pages.length);
    pages.push({ flags: b[p + 5], granule: Number(b.readBigUInt64LE(p + 6)), seq: b.readUInt32LE(p + 18) });
    let q = p + 27 + nseg;
    for (const l of lacing) {
      cur.push(...b.subarray(q, q + l));
      q += l;
      if (l < 255) {
        packets.push(cur);
        cur = [];
      }
    }
    p = q;
  }
  return { pages, packets };
}
function voiceBoot(url = TG_URL, profile = telegramProfile) {
  const feed = [];
  const env = { stopped: 0, recorders: [], constraints: [] };
  const d = boot('<html><head></head><body></body></html>', url, profile, {}, {}, (w) => {
    w.AudioEncoder = function AudioEncoder() {};
    w.navigator.mediaDevices = {
      getUserMedia: (c) => {
        env.constraints.push(c.audio);
        if (c.audio.deviceId) return Promise.reject(Object.assign(new Error('gone'), { name: 'OverconstrainedError' }));
        return Promise.resolve({ getTracks: () => [{ stop: () => env.stopped++ }] });
      },
    };
    w.AudioContext = class {
      constructor() {
        this.state = 'running';
      }
      createMediaStreamSource() {
        return { context: this };
      }
      close() {
        this.state = 'closed';
        return Promise.resolve();
      }
    };
    w.MediaRecorder = class {
      static isTypeSupported(t) {
        return t === 'audio/webm;codecs=opus';
      }
      constructor(stream, opts) {
        this.opts = opts;
        this.state = 'inactive';
        env.recorders.push(this);
      }
      start() {
        this.state = 'recording';
      }
      pause() {
        this.state = 'paused';
      }
      resume() {
        this.state = 'recording';
      }
      emit() {
        const data = feed.shift() || new Uint8Array(0);
        setTimeout(() => this.ondataavailable({ data: new w.Blob([data]) }), 0);
      }
      requestData() {
        this.emit();
      }
      stop() {
        this.emit();
        this.state = 'inactive';
        setTimeout(() => this.onstop && this.onstop(), 0);
      }
    };
  });
  return { ...d, feed, env };
}

check('voice notes record through MediaRecorder and come out as valid Ogg Opus', async () => {
  const v = voiceBoot();
  const w = v.window;
  assert(typeof w.AudioEncoder === 'undefined', 'AudioEncoder still visible to WebK');
  const R = w.Recorder;
  w.Recorder = function Vendor() {};
  assert(w.Recorder === R && typeof R === 'function', 'WebK could replace the recorder');

  const webm = voiceWebm();
  // Cut mid-cluster, as a MediaRecorder timeslice would.
  const cut = webm.length - 30;
  v.feed.push(webm.subarray(0, cut), webm.subarray(cut));
  const rec = new R({ encoderSampleRate: 48000, numberOfChannels: 1 });
  const events = [];
  rec.onstart = () => events.push('start');
  rec.onpause = () => events.push('pause');
  rec.onstop = () => events.push('stop');
  let ogg;
  rec.ondataavailable = (b) => {
    events.push('data');
    ogg = b;
  };
  rec.setMicrophoneId('a-mic-that-was-unplugged');
  await rec.start();
  const [picked, fallback] = v.env.constraints;
  assert(v.env.constraints.length === 2 && picked.deviceId.exact === 'a-mic-that-was-unplugged' && !fallback.deviceId,
    'no fallback to the default mic: ' + JSON.stringify(v.env.constraints));
  // Call processing off: echo cancellation would put the mic in phone-call mode.
  for (const c of [picked, fallback]) {
    assert(c.echoCancellation === false && c.autoGainControl === false && c.channelCount === 1,
      'call processing left on: ' + JSON.stringify(c));
  }
  assert(v.env.recorders[0].opts.audioBitsPerSecond === 64000, 'bitrate ' + v.env.recorders[0].opts.audioBitsPerSecond);
  assert(rec.sourceNode && rec.sourceNode.context, 'no sourceNode for the waveform');
  assert(v.env.recorders[0].opts.mimeType === 'audio/webm;codecs=opus', 'mime ' + v.env.recorders[0].opts.mimeType);

  await rec.pause();
  const snap = readOgg(rec.getSnapshot());
  assert(snap.packets.length >= 3 && snap.packets.length < VOICE_PACKETS.length + 2,
    'snapshot packets ' + snap.packets.length);
  rec.resume();
  await rec.stop();
  assert(JSON.stringify(events) === '["start","pause","data","stop"]', 'events ' + JSON.stringify(events));
  assert(v.env.stopped === 1, 'mic left on');

  const { pages, packets } = readOgg(ogg);
  assert(pages[0].flags === 2 && pages[0].granule === 0, 'first page not BOS: ' + JSON.stringify(pages[0]));
  assert(JSON.stringify(packets[0]) === JSON.stringify(OPUS_HEAD), 'OpusHead not carried over');
  assert(Buffer.from(packets[1].slice(0, 8)).toString() === 'OpusTags', 'no OpusTags');
  const audio = packets.slice(2);
  assert(JSON.stringify(audio) === JSON.stringify(VOICE_PACKETS), 'audio packets changed');
  const last = pages[pages.length - 1];
  assert(last.flags === 4, 'last page not EOS');
  assert(last.granule === VOICE_SAMPLES, 'granule ' + last.granule + ' != ' + VOICE_SAMPLES);
  assert(pages.every((pg, i) => pg.seq === i), 'page sequence broken');
});

check('video notes get the same mic, calls keep call processing', async () => {
  const v = voiceBoot();
  const md = v.window.navigator.mediaDevices;
  // WebK's round-video recorder: a square camera.
  await md.getUserMedia({ video: { width: { ideal: 720 }, height: { ideal: 720 } }, audio: { deviceId: { exact: 'm' } } })
    .catch(() => {});
  // A video call: 16:9.
  await md.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: { deviceId: { exact: 'm' } } })
    .catch(() => {});
  const [note, call] = v.env.constraints;
  assert(note.echoCancellation === false && note.deviceId.exact === 'm', 'video note mic: ' + JSON.stringify(note));
  assert(!('echoCancellation' in call), 'call lost echo cancellation: ' + JSON.stringify(call));
});

check('other sites keep their recorder', () => {
  const v = voiceBoot('https://m.youtube.com/', youtubeProfile);
  assert(typeof v.window.AudioEncoder === 'function', 'AudioEncoder hidden on youtube');
  assert(v.window.Recorder === undefined, 'Recorder defined on youtube');
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

check('telegram hands refused links to other apps', () => assert(telegramProfile.openExternalLinks, 'flag off'));
const handoffCases = [
  ['https://example.com/page?x=1', 'https://example.com/page?x=1'],
  ['http://example.com/', 'http://example.com/'],
  // Location messages: coordinates go to whichever maps app is installed.
  ['https://maps.google.com/maps?q=35.6892,51.389', 'geo:35.6892,51.389?q=35.6892,51.389'],
  ['https://www.google.com/maps?q=-33.86,151.2', 'geo:-33.86,151.2?q=-33.86,151.2'],
  ['https://maps.google.com/maps?q=Tehran', 'https://maps.google.com/maps?q=Tehran'],
  ['mailto:a@b.c', 'mailto:a@b.c'],
  ['tel:+1234567', 'tel:+1234567'],
  // Never: the app-store / native-app handoffs, the site itself, junk.
  ['tg://resolve?domain=x', null],
  ['intent://t.me/x#Intent;end', null],
  ['market://details?id=org.telegram.messenger', null],
  ['https://web.telegram.org/k/', null],
  ['https://t.me/somechannel', null],
  ['javascript:alert(1)', null],
  ['file:///sdcard/x', null],
  ['not a url', null],
];
for (const [url, expected] of handoffCases) {
  check(`tg externalTarget(${url}) === ${expected}`, () => {
    const got = externalTarget(url, tgPolicy);
    assert(got === expected, `got ${got}`);
  });
}
check('a blocked YouTube path is never handed to the YouTube app', () => {
  const got = externalTarget('https://m.youtube.com/shorts/abc', ytPolicy);
  assert(got === null, `got ${got}`);
});

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
