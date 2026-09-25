import CookieManager from '@react-native-cookies/cookies';
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react';
import { AppState, BackHandler, StyleSheet, View } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import { setFullscreenOrientation, setKeepAwake } from '../device/screen';
import { activeBlockedPaths, buildApplyCall, buildBootstrap, buildDebugCall } from '../filters/buildInjection';
import { EnabledMap, ParamMap, SiteProfile } from '../filters/types';
import { USER_AGENT } from '../webview/constants';
import { shouldLoad } from '../webview/navigation';

export interface BrowserHandle {
  /** Returns true if the WebView consumed the back press. */
  goBack(): boolean;
  applyRules(enabledMap: EnabledMap, paramMap: ParamMap): void;
  setDebug(on: boolean): void;
  reload(): void;
}

interface Props {
  profile: SiteProfile;
  enabledMap: EnabledMap;
  paramMap: ParamMap;
}

const BrowserScreen = forwardRef<BrowserHandle, Props>(({ profile, enabledMap, paramMap }, ref) => {
  const webviewRef = useRef<WebView>(null);
  const canGoBack = useRef(false);
  const lastHost = useRef('');
  const lastUrl = useRef('');
  // Mirrors the wake lock so repeated reports don't thrash the native module.
  const awake = useRef(false);

  // Used at page-load time; runtime toggles go through applyRules instead.
  const bootstrap = useMemo(
    () => buildBootstrap(profile, enabledMap, paramMap),
    [profile, enabledMap, paramMap]
  );

  const enabledRef = useRef(enabledMap);
  enabledRef.current = enabledMap;

  useImperativeHandle(ref, () => ({
    goBack() {
      if (canGoBack.current) {
        webviewRef.current?.goBack();
        return true;
      }
      return false;
    },
    applyRules(map: EnabledMap, params: ParamMap) {
      webviewRef.current?.injectJavaScript(buildApplyCall(profile, map, params));
    },
    setDebug(on: boolean) {
      webviewRef.current?.injectJavaScript(buildDebugCall(on));
    },
    reload() {
      webviewRef.current?.reload();
    },
  }));

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (canGoBack.current) {
        webviewRef.current?.goBack();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, []);

  const setPlaying = useCallback((playing: boolean) => {
    if (playing === awake.current) return;
    awake.current = playing;
    setKeepAwake(playing);
  }, []);

  // Android CookieManager can lose cookies set within ~30s of process death
  // (react-native-webview#3451) — flush whenever we background.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background' || state === 'inactive') {
        CookieManager.flush().catch(() => {});
        // A video paused by backgrounding reports nothing, so drop the lock
        // here; the page's poll re-arms it if playback is still running when
        // we come back.
        setPlaying(false);
      }
    });
    return () => sub.remove();
  }, [setPlaying]);

  // Nothing else releases these if the screen goes away mid-video.
  useEffect(
    () => () => {
      setPlaying(false);
      setFullscreenOrientation(false);
    },
    [setPlaying]
  );

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let msg: { type?: string; playing?: boolean; on?: boolean };
      try {
        msg = JSON.parse(event.nativeEvent.data);
      } catch {
        if (__DEV__) console.log('[unhook] raw:', event.nativeEvent.data);
        return;
      }
      // playback/fullscreen drive device state, not diagnostics — they have to
      // be handled in release builds too, so they run before the __DEV__ log.
      if (msg.type === 'playback') setPlaying(!!msg.playing);
      else if (msg.type === 'fullscreen') setFullscreenOrientation(!!msg.on);
      if (__DEV__) console.log('[unhook]', msg);
    },
    [setPlaying]
  );

  return (
    <View style={styles.container}>
      <WebView
        ref={webviewRef}
        source={{ uri: profile.startUrl }}
        userAgent={profile.userAgent ?? USER_AGENT}
        javaScriptEnabled
        domStorageEnabled
        thirdPartyCookiesEnabled
        sharedCookiesEnabled
        cacheEnabled
        incognito={false}
        setSupportMultipleWindows={false}
        javaScriptCanOpenWindowsAutomatically
        allowsFullscreenVideo
        mediaPlaybackRequiresUserAction={false}
        allowsBackForwardNavigationGestures
        webviewDebuggingEnabled={__DEV__}
        // injectedJavaScriptBeforeContentLoaded is documented as "not 100%
        // reliable" on Android; when it missed, no filtering ran at all. The
        // bootstrap is idempotent (it re-applies through window.__unhook if
        // already installed), so we inject at three points and let whichever
        // one lands first win. Before-content-loaded is still the preferred
        // path — it's the one that avoids a flash of unfiltered content.
        injectedJavaScriptBeforeContentLoaded={bootstrap}
        injectedJavaScript={bootstrap}
        onLoadEnd={() => webviewRef.current?.injectJavaScript(bootstrap)}
        onShouldStartLoadWithRequest={(req) =>
          shouldLoad(req, {
            allowedHosts: profile.allowedHosts,
            blockedPathPatterns: activeBlockedPaths(profile, enabledRef.current),
            blockedSchemes: profile.blockedSchemes,
          })
        }
        onNavigationStateChange={(nav) => {
          canGoBack.current = nav.canGoBack;
          // Leaving a page kills its <video> without a pause event, which would
          // strand the wake lock. The new page re-reports within 2s.
          if (nav.url !== lastUrl.current) {
            lastUrl.current = nav.url;
            setPlaying(false);
          }
          try {
            const host = new URL(nav.url).hostname;
            // Returning from accounts.google.com means login just finished —
            // flush immediately so the session survives an early app kill.
            if (lastHost.current.includes('accounts.') && !host.includes('accounts.')) {
              CookieManager.flush().catch(() => {});
            }
            lastHost.current = host;
          } catch {}
        }}
        onMessage={onMessage}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  container: { flex: 1 },
});

export default BrowserScreen;
