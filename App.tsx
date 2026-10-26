import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  SafeAreaProvider,
  SafeAreaView,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import { pausedEnabledMap } from './src/filters/buildInjection';
import { activeProfile } from './src/filters/profiles';
import { EnabledMap, ParamMap } from './src/filters/types';
import BrowserScreen, { BrowserHandle } from './src/screens/BrowserScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import {
  loadEnabledMap,
  loadParamMap,
  saveEnabledMap,
  saveParamMap,
} from './src/storage/settings';

const profile = activeProfile;
const FOCUS_BREAK_MS = 60 * 1000;

// Android 16 / RN 0.81+ force edge-to-edge with no opt-out, and React Native's
// own SafeAreaView is iOS-only — without this the WebView drew under the status
// bar and the site's sticky search bar was unreachable. Insets have to come
// from react-native-safe-area-context, which works on both platforms.
function Root() {
  const browserRef = useRef<BrowserHandle>(null);
  const insets = useSafeAreaInsets();
  const [enabledMap, setEnabledMap] = useState<EnabledMap | null>(null);
  const [paramMap, setParamMap] = useState<ParamMap | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [debug, setDebug] = useState(false);
  const [breakUntil, setBreakUntil] = useState(0);
  // True from "Unlock for 1 minute" until the break is over: the page gets
  // pausedEnabledMap instead of the user's choices, which stay untouched.
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  // Each handler below changes one map but has to re-inject both, and a
  // useCallback with [] deps would close over a stale copy of the other.
  const enabledRef = useRef<EnabledMap>({});
  enabledRef.current = enabledMap ?? {};
  const paramRef = useRef<ParamMap>({});
  paramRef.current = paramMap ?? {};

  // The rules the page should run right now.
  const pushRules = useCallback((enabled: EnabledMap, params: ParamMap) => {
    const map = pausedRef.current ? pausedEnabledMap(profile, enabled) : enabled;
    browserRef.current?.applyRules(map, params);
  }, []);

  useEffect(() => {
    loadEnabledMap(profile.id).then(setEnabledMap);
    loadParamMap(profile.id).then(setParamMap);
  }, []);

  const onToggle = useCallback((ruleId: string, value: boolean) => {
    setEnabledMap((prev) => {
      const next = { ...(prev ?? {}), [ruleId]: value };
      saveEnabledMap(profile.id, next);
      pushRules(next, paramRef.current);
      return next;
    });
  }, []);

  const onParamChange = useCallback((ruleId: string, value: string) => {
    setParamMap((prev) => {
      const next = { ...(prev ?? {}), [ruleId]: value };
      saveParamMap(profile.id, next);
      pushRules(enabledRef.current, next);
      return next;
    });
  }, []);

  const onToggleDebug = useCallback((value: boolean) => {
    setDebug(value);
    browserRef.current?.setDebug(value);
  }, []);

  // Settings closes too: the break is for going somewhere in Telegram.
  const onFocusBreak = useCallback(() => {
    const until = Date.now() + FOCUS_BREAK_MS;
    pausedRef.current = true;
    setPaused(true);
    setBreakUntil(until);
    pushRules(enabledRef.current, paramRef.current);
    browserRef.current?.startFocusBreak(until);
    setSettingsOpen(false);
  }, [pushRules]);

  // Ends the break: the user's rules go back in, which also reopens the focus
  // folder (switching it back on restarts that loop). Checked again on return
  // to the app, in case the timer was held up while it was in the background.
  useEffect(() => {
    if (!paused) return;
    const end = () => {
      if (Date.now() < breakUntil) return;
      pausedRef.current = false;
      setPaused(false);
      pushRules(enabledRef.current, paramRef.current);
    };
    const timer = setTimeout(end, Math.max(0, breakUntil - Date.now()) + 50);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') end();
    });
    return () => {
      clearTimeout(timer);
      sub.remove();
    };
  }, [paused, breakUntil, pushRules]);

  // What a page (re)load injects: paused during a break, like applyRules.
  const pageEnabledMap = useMemo(
    () => (enabledMap && paused ? pausedEnabledMap(profile, enabledMap) : enabledMap),
    [enabledMap, paused]
  );

  // Wait for stored settings before mounting the WebView so the very first
  // page load already has the right rules injected. Both maps, not just one:
  // mounting early would boot the focus folder with its default name.
  if (enabledMap === null || paramMap === null || pageEnabledMap === null) return null;

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom', 'left', 'right']}>
      <StatusBar style="dark" />
      <BrowserScreen
        ref={browserRef}
        profile={profile}
        enabledMap={pageEnabledMap}
        paramMap={paramMap}
      />

      <Pressable
        // Sits above the site's own bottom nav, which now ends at the inset.
        style={[styles.fab, { bottom: 96 + insets.bottom }]}
        onPress={() => setSettingsOpen(true)}
        hitSlop={8}
        accessibilityLabel="Open filter settings"
      >
        <Text style={styles.fabIcon}>⚙</Text>
      </Pressable>

      <Modal
        visible={settingsOpen}
        animationType="slide"
        onRequestClose={() => setSettingsOpen(false)}
      >
        <SafeAreaView style={styles.container} edges={['top', 'bottom', 'left', 'right']}>
          <SettingsScreen
            profile={profile}
            enabledMap={enabledMap}
            paramMap={paramMap}
            debug={debug}
            onToggle={onToggle}
            onParamChange={onParamChange}
            onToggleDebug={onToggleDebug}
            focusBreakUntil={breakUntil}
            onFocusBreak={onFocusBreak}
            onReload={() => {
              browserRef.current?.reload();
              setSettingsOpen(false);
            }}
            onClose={() => setSettingsOpen(false)}
          />
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <View style={styles.container}>
        <Root />
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  fab: {
    position: 'absolute',
    right: 12,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  fabIcon: { color: '#fff', fontSize: 20, lineHeight: 22 },
});
