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
import { buildApplyCall, buildBootstrap, buildDebugCall, isRuleEnabled } from '../filters/buildInjection';
import { EnabledMap, SiteProfile } from '../filters/types';
import { USER_AGENT } from '../webview/constants';
import { shouldLoad } from '../webview/navigation';

export interface BrowserHandle {
  /** Returns true if the WebView consumed the back press. */
  goBack(): boolean;
  applyRules(enabledMap: EnabledMap): void;
  setDebug(on: boolean): void;
  reload(): void;
}

interface Props {
  profile: SiteProfile;
  enabledMap: EnabledMap;
}

const BrowserScreen = forwardRef<BrowserHandle, Props>(({ profile, enabledMap }, ref) => {
  const webviewRef = useRef<WebView>(null);
  const canGoBack = useRef(false);
  const lastHost = useRef('');

  // Used at page-load time; runtime toggles go through applyRules instead.
  const bootstrap = useMemo(() => buildBootstrap(profile, enabledMap), [profile, enabledMap]);

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
    applyRules(map: EnabledMap) {
      webviewRef.current?.injectJavaScript(buildApplyCall(profile, map));
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

  // Android CookieManager can lose cookies set within ~30s of process death
  // (react-native-webview#3451) — flush whenever we background.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background' || state === 'inactive') {
        CookieManager.flush().catch(() => {});
      }
    });
    return () => sub.remove();
  }, []);

  const onMessage = useCallback((event: WebViewMessageEvent) => {
    if (!__DEV__) return;
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      console.log('[unhook]', msg);
    } catch {
      console.log('[unhook] raw:', event.nativeEvent.data);
    }
  }, []);

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
        injectedJavaScriptBeforeContentLoaded={bootstrap}
        onShouldStartLoadWithRequest={(req) =>
          shouldLoad(req, {
            allowedHosts: profile.allowedHosts,
            blockShorts: isRuleEnabled(profile, enabledRef.current, 'hide-shorts'),
          })
        }
        onNavigationStateChange={(nav) => {
          canGoBack.current = nav.canGoBack;
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
