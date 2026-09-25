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

# Telegram (FreeTele)

**Telegram Web is hash-routed** (`/k/#-1001234`), so `location.pathname` is
always `/k/`. Every path-based mechanism in this codebase — `pathScope`,
`redirect`, `blockPathPattern`, and `shouldLoad`'s `blockedPathPatterns` — is
inert for this profile by construction. Telegram rules are CSS and `jsAction`
only. Reaching for a redirect there will silently do nothing.

Pinned to **WebK** (`/k/`), which has the stabler hooks (`#column-left`,
`.chatlist-chat`, `#folders-container`). WebA (`/a/`) selectors ride along as
harmless fallbacks.

Two rules are more than CSS:

- **Open a folder on launch** (`focusFolder`) clicks the user's folder tab on
  every load, letting Telegram filter the chat list server-side. DOM-side
  filtering cannot work — the dialog list is virtualized, so it can only ever
  see what happens to be rendered. The retry loop (~450ms × 20) is beating two
  races: the client not having attached handlers yet, and Telegram restoring
  the last-open folder a beat after the first click.
- **Block chats outside that folder** (`focusLock`) covers any open chat whose
  title the chat list never offered. It reads from a **snapshot** of the last
  populated list, not a live query: Telegram is single-column on a phone, so
  opening a chat takes the list off-screen and a live read would come back
  empty exactly when the lock has a decision to make. It fails open when no
  list has ever been seen — never trap the user behind an overlay.

`hide-folder-tabs` carries `deferUntil: 'focusFolder'` because a `display:none`
tab cannot be clicked; its CSS is withheld until the focus click lands. That is
the only reason `deferUntil` exists.

Session state lives in **IndexedDB + localStorage**, not cookies, so the
`CookieManager` flushing in `BrowserScreen` does nothing here; persistence comes
from `domStorageEnabled` + `incognito={false}`, which are already set.
**QR login cannot work** (you would be scanning the screen you are holding) —
sign in with phone number + code. Web push does not exist in a WebView, so
FreeTele is silent by design.

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

# Verification without a device

- `npm run typecheck`
- `npm run check` — transpiles the filter/injection/navigation modules and
  exercises them in jsdom (all three profiles), plus unit-tests `shouldLoad`.

Instagram and Telegram selectors need on-device tuning: enable **Debug: outline
matches** in Settings and read the per-selector counts in Metro via
`chrome://inspect`.
