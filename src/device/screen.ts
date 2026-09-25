// Device-level effects driven by what the page reports (see the playback +
// fullscreen reporting section of src/injection/bootstrap.ts). Every call is
// fire-and-forget: a wake lock or orientation failure must never interrupt
// browsing, so nothing here throws or returns a promise to await.
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as ScreenOrientation from 'expo-screen-orientation';

// A single tag, so an activation and its release always pair up — each tag
// holds its own lock and has to be deactivated individually.
const KEEP_AWAKE_TAG = 'video-playback';

// LANDSCAPE maps to SCREEN_ORIENTATION_SENSOR_LANDSCAPE on Android, so the
// user can still flip between the two landscape directions while watching.
const LANDSCAPE = ScreenOrientation.OrientationLock.LANDSCAPE;
// PORTRAIT_UP rather than unlockAsync(): unlock resets to UNSPECIFIED, which
// would leave the app free-rotating afterwards. Outside fullscreen this app is
// portrait-only, matching app.json's "orientation": "portrait".
const PORTRAIT = ScreenOrientation.OrientationLock.PORTRAIT_UP;

/** Holds the screen on while a video is playing. */
export function setKeepAwake(on: boolean): void {
  const done = on ? activateKeepAwakeAsync(KEEP_AWAKE_TAG) : deactivateKeepAwake(KEEP_AWAKE_TAG);
  done.catch(() => {});
}

let fullscreen = false;

function lock(orientation: ScreenOrientation.OrientationLock): void {
  ScreenOrientation.lockAsync(orientation).catch(() => {});
}

/**
 * Landscape while a video is fullscreen, portrait otherwise. Forcing it this
 * way is what makes fullscreen fill the screen even with the phone's
 * auto-rotate switch off — react-native-webview only sets the activity to
 * SCREEN_ORIENTATION_UNSPECIFIED, which obeys that switch.
 */
export function setFullscreenOrientation(on: boolean): void {
  fullscreen = on;
  lock(on ? LANDSCAPE : PORTRAIT);
  // That same UNSPECIFIED write (RNCWebViewManagerImpl.onShowCustomView) races
  // this one over the activity's requested orientation. Re-assert once so
  // landscape wins regardless of which lands first — but only if fullscreen is
  // still on, or a quick exit would be overridden back to landscape.
  if (on) {
    setTimeout(() => {
      if (fullscreen) lock(LANDSCAPE);
    }, 300);
  }
}
