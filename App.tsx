import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Pressable, SafeAreaView, StyleSheet, Text } from 'react-native';
import { youtubeProfile } from './src/filters/profiles/youtube';
import { EnabledMap } from './src/filters/types';
import BrowserScreen, { BrowserHandle } from './src/screens/BrowserScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import { loadEnabledMap, saveEnabledMap } from './src/storage/settings';

const profile = youtubeProfile;

export default function App() {
  const browserRef = useRef<BrowserHandle>(null);
  const [enabledMap, setEnabledMap] = useState<EnabledMap | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [debug, setDebug] = useState(false);

  useEffect(() => {
    loadEnabledMap(profile.id).then(setEnabledMap);
  }, []);

  const onToggle = useCallback((ruleId: string, value: boolean) => {
    setEnabledMap((prev) => {
      const next = { ...(prev ?? {}), [ruleId]: value };
      saveEnabledMap(profile.id, next);
      browserRef.current?.applyRules(next);
      return next;
    });
  }, []);

  const onToggleDebug = useCallback((value: boolean) => {
    setDebug(value);
    browserRef.current?.setDebug(value);
  }, []);

  // Wait for stored settings before mounting the WebView so the very first
  // page load already has the right rules injected.
  if (enabledMap === null) return null;

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="dark" />
      <BrowserScreen ref={browserRef} profile={profile} enabledMap={enabledMap} />

      <Pressable
        style={styles.fab}
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
        <SafeAreaView style={styles.container}>
          <SettingsScreen
            profile={profile}
            enabledMap={enabledMap}
            debug={debug}
            onToggle={onToggle}
            onToggleDebug={onToggleDebug}
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  fab: {
    position: 'absolute',
    right: 12,
    bottom: 96,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  fabIcon: { color: '#fff', fontSize: 20, lineHeight: 22 },
});
