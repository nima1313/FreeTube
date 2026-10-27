# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

# Build variants

One codebase, two apps. `EXPO_PUBLIC_APP_PROFILE` selects the variant in two
places: `app.config.ts` (name, slug, `android.package`, adaptive-icon colour)
and `src/filters/profiles/index.ts` (which `SiteProfile` gets injected).

| variant | app | package | site |
|---|---|---|---|
| `youtube` (default) | FreeTube | `com.nima.freetube` | m.youtube.com |
| `instagram` | FreeGram | `com.nima.freegram` | www.instagram.com |
| `telegram` | FreeTele | `com.nima.freetele` | web.telegram.org/k/ |

```
npm run android:youtube
npm run android:instagram
npm run android:telegram
```

**The variants have different `android.package` values, and `/android` is
gitignored and regenerated.** You cannot build more than one from a single
prebuild — run `npm run prebuild:telegram` (or `:youtube`, `:instagram`) to
switch. The `--clean` flag is already in those scripts.

Metro only inlines `EXPO_PUBLIC_*` vars that are referenced as a literal
`process.env.NAME` dot access. Don't destructure or use bracket access.

# Icons

All three apps share one design: a close-up of the Statue of Liberty's torch
with the site's own logo as the flame. `scripts/make-icons.mjs` draws it (SVG
on Android's 108-unit adaptive-icon grid) and renders, per variant,
`assets/icons/<site>/{icon,foreground,monochrome}.png` with headless Chrome
(`node scripts/make-icons.mjs`). `app.config.ts` picks the folder and sets the
background colour, which has to match `ICON_BACKGROUNDS` in the script. Keep
anything that matters within ~34 units of the centre: launchers show only
the middle 72 units, cropped to their own shape.

# Telegram (FreeTele)

**Telegram Web K only** (`/k/`), ported from the unhookTelegram extension
(`~/Desktop/unhookTelegram`), whose selectors were verified against the live
WebK DOM. WebA (`/a/`) has different markup and none of the internals below,
so the `stay-on-webk` rule redirects `/a/` → `/k/` (e.g. after WebK's "Switch
to A version").

**Telegram Web is hash-routed** (`/k/#-1001234`), so inside the app
`location.pathname` is always `/k/`. `pathScope`, `blockPathPattern` and
`shouldLoad`'s `blockedPathPatterns` are inert for this profile; the `/a/`
redirect is the one path mechanism that fires, because `/a/` is a real path.

**WebK's chat list is virtual** — only on-screen rows are mounted, each
absolutely positioned — so nothing that needs the whole list can work from the
DOM. The name filters and the focus lock work on WebK's own globals instead
(`appDialogsManager`, `apiManagerProxy`, `appImManager`, `rootScope`). If a
Telegram update renames those, they stop working (failing open) while the CSS
rules carry on:

- **Show only / hide chats by name** (`chatWhitelist` / `chatBlacklist`,
  comma-separated params) wrap `dialogsFetcher` and `canUpdateDialog` on the
  dialog-list base class. The fetcher scans a folder's whole list once (cap
  3000, cached 30s) and serves pages out of the matches, so Telegram renders a
  gap-free list. `"saved messages"` matches your own chat. While waiting for
  the patch, `<html data-unhook-tg-loading>` hides the unfiltered list (8s max).
- **Open a folder on launch** (`focusFolder`) taps the tab in `#folders-tabs`
  whose `.text-super` label matches, until it has been `.active` for 3 ticks
  (400ms, gives up after 20s) — Telegram restores the last-open folder a beat
  after load. WebK listens for taps on `mousedown` on touch devices (so
  `.click()` alone does nothing in the app) and on `click` elsewhere; the tap
  sends both. A hidden tab still switches, so `hide-folder-tabs` needs no
  special handling. WebK only lists folder chats whose dialogs are already in
  its local cache and never fetches the rest, so once per page load the
  folder's explicit chats (`pinned_peers` + `include_peers` from
  `filtersStorage.getFilter`) that `getDialogOnly` doesn't know are loaded
  with `appMessagesManager.reloadConversation`; WebK then adds them to the
  list itself. A name-filtered list is rebuilt afterwards.
- **Block other chats** (`focusLock`) checks the open chat every 100ms:
  allowed if it is in the focus folder (on the folder's explicit chat list, or
  a member via its dialog index key) or matches a "show only" name, and never if it matches a
  "hide" name. On a phone-width layout WebK closes a chat by sliding back to
  the list **without clearing `appImManager.chat.peerId`**, so "open chat"
  means `appImManager.tabId >= 1` (0 = list, 1 = chat, 2 = profile) *and* that
  peer. The overlay covers only the message area below `.topbar` (`.bubbles`
  runs behind the header), so Telegram's own back arrow stays usable; its
  button calls `appImManager.setPeer({peerId: 0})`. Unknown folder or internal
  error → fail open. Never trap the user behind an overlay.
  With a focus folder set, any *other* folder tab gets a second overlay
  (`__unhook_folder_guard`) over its chat list, starting below the tabs so
  switching back stays possible. It stays off while the launch switch to the
  focus folder is still running, during search (`.is-search-active`), while a
  WebK menu is open (`.btn-menu.active`), and whenever `elementsFromPoint` says
  something else (settings, a popup, an open chat) is over the list.
  **Unlock for 1 minute** is a button in Settings, under Block other chats
  (not on the overlays). For that minute `App` hands the page
  `pausedEnabledMap` — every rule off except redirects — so hidden tabs,
  search and chats all come back; the user's own choices are untouched and
  go back in when it ends (on a timer, re-checked when the app returns to the
  foreground), which also reopens the focus folder. `__unhook.focusBreak(until)`
  draws the countdown pill (`__unhook_break`, `pointer-events:none`) and keeps
  both locks off; `BrowserScreen` re-sends it on `onLoadEnd`, and a reload
  during the break injects the paused rules, so a reload doesn't end it.
- **Hide the menu button** must not hide `.animated-menu-icon.state-back`: the
  same element draws the back arrow that closes search, and with the search
  bar also hidden, search mode is otherwise a blank column with no way out.

**Links** to other sites do nothing inside the WebView (`shouldLoad` refuses
them), so with `openExternalLinks` on the profile (Telegram only)
`BrowserScreen` hands them to Android instead: `externalTarget` in
`src/webview/navigation.ts` allows http(s) off the allowed hosts plus
`mailto:`/`tel:`/`sms:`/`geo:`, never a blocked scheme and never a page of the
site itself (that would undo a blocked path). A location message is a
`maps.google.com/maps?q=lat,lng` link; it becomes `geo:lat,lng?q=lat,lng` so
any maps app can take it, falling back to the https link if none does.

Session state lives in **IndexedDB + localStorage**, not cookies, so the
`CookieManager` flushing in `BrowserScreen` does nothing here; persistence comes
from `domStorageEnabled` + `incognito={false}`, which are already set.
**QR login cannot work** (you would be scanning the screen you are holding) —
sign in with phone number + code. Web push does not exist in a WebView, so
FreeTele is silent by design.

**Voice/video messages** need mic + camera. react-native-webview's
`onPermissionRequest` already turns `getUserMedia` into an Android runtime
prompt, but Android silently denies anything the manifest doesn't declare, so
the `permissions` list on the telegram/instagram variants in `app.config.ts`
is what makes the dialog appear. Changing it needs a `prebuild --clean`.

# Downloads

WebK saves a file by streaming it through its service worker: it sets a
hidden iframe to `d/<id>`, and the SW answers with the file as an attachment.
Left alone, that response goes to react-native-webview's `DownloadListener`,
which gives the **URL** to Android's DownloadManager (the "Downloading" toast).
DownloadManager requests `/k/d/<id>` from outside the WebView, where there is
no SW, so it fails, and the WebView drops the stream after a few MB.
DownloadManager can't fetch `blob:` URLs either.

So the bootstrap's Downloads section intercepts both paths: iframe `src`
matching same-origin `/d/<digits>`, and clicks on `a[download]` with a `blob:`
or `data:` href. It `fetch()`es the URL in the page (the SW serves page
fetches too) and posts `{type:'download', phase:'start'|'chunk'|'end'|'error'}`
with ~512 KB base64 chunks. `src/device/downloads.ts` queues these, in order,
into the local Expo module `modules/downloads`, which writes into the public
Downloads folder through MediaStore (no permission needed; the file stays
`IS_PENDING` until it's complete). Telegram often types files as
`application/octet-stream`; the module swaps a generic type for the one the
extension implies (when saving and when opening), or Android offers random
apps instead of e.g. the installer for an `.apk`. **The `download` message type is
load-bearing in release builds**, like playback/fullscreen.

Tapping a saved file opens it, like the Telegram app (there is no "saved"
toast). The bootstrap wraps `appDownloadManager.downloadToDisc` to learn which
document each `d/<id>` belongs to and sends its id along; the module remembers
document id → MediaStore uri (SharedPreferences, API 29+ only).
`BrowserScreen` pushes the live list into the page with
`window.__unhook.savedDocs(ids, add)` on load, on returning to the app, and
after each finished download; `saved()` forgets files deleted since. A
mousedown/click on a saved `.document[data-doc-id]` is taken over (phase
`open`) and native fires `ACTION_VIEW`. Saved documents get
`data-unhook-saved`, which hides WebK's download arrow (it puts it back on
files over 20 MB after every download). FreeTele declares
`REQUEST_INSTALL_PACKAGES` because Android's installer rejects APKs opened from
an app without it.

What WebK downloads *inside* a chat (music, files and videos up to 20 MB) is
a different thing: it lives in WebK's own CacheStorage, which its service
worker prunes by age — "Clear cache older than" in Settings > Data and
Storage, **1 week by default**. That is why played/downloaded music kept
vanishing. The bootstrap raises an untouched 1-week setting to 1 year (the
longest WebK offers) through `managers.appStateManager.setByKey
('settings.cacheTTL', …)`, leaving any other value alone.

# Share target (FreeTele)

FreeTele is in Android's share sheet: `shareTarget` on the telegram variant in
`app.config.ts` adds `SEND` / `SEND_MULTIPLE` intent filters for `*/*` (a
`prebuild --clean` picks them up). The local module `modules/share` takes the
intent — as the launch intent (JS calls `take()` on mount), as a new intent
to the running singleTask activity, or on a recreated activity (both fire
`onShare`) — and marks it taken so it is never shared twice.
`src/device/share.ts` streams each file into the page as base64 chunks
(1.5 MB, each acked with `{type:'share', phase:'ack'}` before the next, the
next read overlapping the ack; **load-bearing in release builds**). Most of
the cost per chunk is the round trip: 60 MB takes ~6s on the emulator, so
shares over 4 MB show a "Getting the file ready… N%" pill.

The page doesn't need its own share UI: WebK is a share target as a web app
(manifest `share_target` → POST `./share/` → its service worker), and the
service worker only puts `{files, title, text, url}` on
`apiManagerProxy.share` for `appImManager.checkForShare()`. The bootstrap
does the same, waiting up to 60s for Telegram to load (a cold start from the
share sheet). Files get Telegram's chat picker, then the caption popup; text
goes into the chosen chat as a draft. Should WebK rename those globals, the
bootstrap falls back to submitting that POST itself (reloads the page).

# Voice messages (FreeTele)

WebK records voice notes through WebAudio (an AudioWorklet) into a WebCodecs
`AudioEncoder`, which sounds noisy in the Android WebView; video notes go
through `MediaRecorder` and are clean. WebK uses its WebCodecs recorder only
when `AudioEncoder` exists, else `new window.Recorder(config)`. So on
web.telegram.org the bootstrap hides `AudioEncoder` and makes `window.Recorder`
an accessor returning its own MediaRecorder-based recorder (assignments are
ignored). MediaRecorder only writes WebM, so `webmToOgg` re-wraps the Opus
packets (no re-encoding) into the Ogg Opus Telegram expects. Voice notes record
at 64 kbps with `NOTE_AUDIO` constraints: echo cancellation off (on Android it
switches the mic to its narrowband phone-call mode) and gain control off; noise
suppression stays. Video notes are WebK's own recorder, so the bootstrap wraps
`getUserMedia` and applies `NOTE_AUDIO` to requests with a square camera
(ideal width === height, as WebK's round-video recorder asks); calls ask for
16:9 and keep their call processing. The cost: WebK's
media editor sees no `AudioEncoder`, so edited videos can't keep their sound.

WebK has no camera switch for video notes, so the same wrapper hands WebK a
stream whose video track is a 720px square canvas fed from the real camera
(`videoNoteStream`); a flip button (`__unhook_cam_flip`) beside
`.video-recording-stage--recording .video-recording-circle` swaps the camera
behind it (old one stopped first — phones can't open two) and WebK records
on undisturbed. WebK always mirrors the preview, so
`html[data-unhook-cam="environment"]` turns that off for the back camera.
The button flips on `pointerup` (and on `click`, deduped): WebK's recorder
eats the touch otherwise, and `preventDefault` on `touchstart` would cancel
the click.

# File uploads

`patches/react-native-webview+13.16.1.patch` replaces the file chooser. Upstream
wraps the picker in `ACTION_CHOOSER` with camera/camcorder intents whenever the
app holds CAMERA (FreeTele/FreeGram do, for video messages), which puts a slow
"choose an app" sheet before every upload. Patched: image/video-only inputs
open Android's photo picker (`ACTION_PICK_IMAGES`, API 33+), anything else
`ACTION_GET_CONTENT`; the page's callback is always answered. The camera is no
longer offered from the attach menu (video notes don't need it).

Before the "Send Photo" popup appears, WebK scales a photo to 2560px and
encodes it as JPEG at quality 1 (~8 MB for a phone photo), finds it over its
6 MB limit, and decodes and encodes it all over again at 0.9. The bootstrap
caps big (>= 1280px) JPEG `canvas.toBlob` calls on web.telegram.org at 0.9,
so that happens once: on the emulator a 12 MP photo went from 2.1s to 1.3s.

# Device behavior (screen wake + rotation)

The app is portrait-only (`app.json`); a video going fullscreen forces
landscape and exiting restores portrait, and the screen is kept awake only
while a video is actually playing. Both are driven from the page: the injected
bootstrap posts `{type:'playback'}` / `{type:'fullscreen'}`, and
`BrowserScreen`'s `onMessage` turns them into the calls in
`src/device/screen.ts`. **Those two message types are load-bearing in release
builds** — unlike the other `post()` messages they are not debug logging, so
don't move them back behind the `__DEV__` guard.

Fullscreen has to force landscape rather than unlock rotation:
react-native-webview only sets the activity to `SCREEN_ORIENTATION_UNSPECIFIED`,
which obeys the phone's auto-rotate switch and does nothing when it is off.

# Debugging a release build

`EXPO_PUBLIC_WEBVIEW_DEBUG=1` at build time turns on WebView debugging
(`chrome://inspect`) in a release APK; dev builds always have it.

# Verification without a device

- `npm run typecheck`
- `npm run check` — transpiles the filter/injection/navigation modules and
  exercises them in jsdom (all three profiles, Telegram against a fake of the
  WebK internals), plus unit-tests `shouldLoad`.

Instagram and Telegram selectors need on-device tuning: enable **Debug: outline
matches** in Settings and read the per-selector counts in Metro via
`chrome://inspect`.
