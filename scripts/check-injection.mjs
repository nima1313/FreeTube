// Local verification of everything testable without a device:
//  1. Transpiles the filter/injection/navigation modules to CJS
//  2. Syntax-checks the generated bootstrap + apply scripts
//  3. Runs the bootstrap inside jsdom and asserts: style injected, rule CSS
//     applied, SPA pushState re-applies path-scoped CSS, __unhook.apply()
//     re-injection works, Shorts click interception blocks navigation
//  4. Unit-tests the shouldLoad navigation policy
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
const { buildBootstrap, buildApplyCall, buildDebugCall } = require(join(out, 'src/filters/buildInjection.js'));
const { shouldLoad } = require(join(out, 'src/webview/navigation.js'));

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log('  ok  ' + name);
  } catch (e) {
    failures++;
    console.error('FAIL  ' + name + ': ' + e.message);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

console.log('\n-- script generation --');
const bootstrap = buildBootstrap(youtubeProfile, {});
check('bootstrap script is valid JS', () => new Function(bootstrap));
check('apply call is valid JS', () => new Function(buildApplyCall(youtubeProfile, { 'hide-comments': true })));
check('debug call is valid JS', () => new Function(buildDebugCall(true)));
check('rules were substituted', () => assert(!bootstrap.includes('__RULES__'), 'placeholder left in script'));

console.log('\n-- bootstrap behavior in jsdom --');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<html><head></head><body><a id="short" href="/shorts/abc123">short</a></body></html>', {
  url: 'https://m.youtube.com/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;
const posted = [];
window.ReactNativeWebView = { postMessage: (s) => posted.push(JSON.parse(s)) };
window.eval(bootstrap);

check('posts ready message', () => assert(posted.some((m) => m.type === 'ready'), JSON.stringify(posted)));
check('style element installed', () => assert(window.document.getElementById('__unhook_css'), 'missing style'));
check('shorts CSS applied on home', () =>
  assert(window.document.getElementById('__unhook_css').textContent.includes('ytm-reel-shelf-renderer'), 'no shorts css'));
check('home-feed CSS applied on / (pathScope ^/$)', () =>
  assert(window.document.getElementById('__unhook_css').textContent.includes('ytm-rich-grid-renderer'), 'no home css'));
check('watch-scoped CSS absent on /', () =>
  assert(!window.document.getElementById('__unhook_css').textContent.includes('related-items'), 'watch css leaked to home'));

check('pushState to /watch applies watch-scoped CSS', () => {
  window.eval(buildApplyCall(youtubeProfile, { 'hide-related': true }));
  window.history.pushState({}, '', '/watch?v=xyz');
  const css = window.document.getElementById('__unhook_css').textContent;
  assert(css.includes('related-items'), 'related css missing on /watch');
  assert(!css.includes('ytm-rich-grid-renderer'), 'home css leaked to /watch');
});

check('re-apply disables a rule live', () => {
  window.eval(buildApplyCall(youtubeProfile, { 'hide-related': true, 'hide-shorts': false }));
  const css = window.document.getElementById('__unhook_css').textContent;
  assert(!css.includes('ytm-reel-shelf-renderer'), 'shorts css still present after disable');
});

check('style element resurrected after removal', async () => {
  // MutationObserver fires async; force a mutation then flush microtasks
  window.document.getElementById('__unhook_css').remove();
  window.document.body.appendChild(window.document.createElement('div'));
  return new Promise((resolve, reject) =>
    setTimeout(() => {
      window.document.getElementById('__unhook_css')
        ? resolve()
        : reject(new Error('style not re-created'));
    }, 50)
  );
});

check('shorts click intercepted when enabled', () => {
  window.eval(buildApplyCall(youtubeProfile, {})); // defaults: hide-shorts on
  const a = window.document.getElementById('short');
  const ev = new window.MouseEvent('click', { bubbles: true, cancelable: true });
  a.dispatchEvent(ev);
  assert(ev.defaultPrevented, 'click not prevented');
  assert(posted.some((m) => m.type === 'blocked' && m.what === 'shorts-link'), 'no blocked message');
});

console.log('\n-- shouldLoad navigation policy --');
const policy = { allowedHosts: youtubeProfile.allowedHosts, blockShorts: true };
const cases = [
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
for (const [url, expected] of cases) {
  check(`shouldLoad(${url}) === ${expected}`, () =>
    assert(shouldLoad({ url }, policy) === expected, `got ${shouldLoad({ url }, policy)}`));
}
check('shorts allowed when blockShorts off', () =>
  assert(shouldLoad({ url: 'https://m.youtube.com/shorts/abc' }, { ...policy, blockShorts: false }) === true, 'blocked'));

setTimeout(() => {
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}, 200);
