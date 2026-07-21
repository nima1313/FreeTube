import React from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { EnabledMap, SiteProfile } from '../filters/types';

interface Props {
  profile: SiteProfile;
  enabledMap: EnabledMap;
  debug: boolean;
  onToggle(ruleId: string, value: boolean): void;
  onToggleDebug(value: boolean): void;
  onReload(): void;
  onClose(): void;
}

export default function SettingsScreen({
  profile,
  enabledMap,
  debug,
  onToggle,
  onToggleDebug,
  onReload,
  onClose,
}: Props) {
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>{profile.label} filters</Text>
        <Pressable onPress={onClose} hitSlop={12}>
          <Text style={styles.close}>Done</Text>
        </Pressable>
      </View>

      <FlatList
        data={profile.rules}
        keyExtractor={(r) => r.id}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <View style={styles.rowText}>
              <Text style={styles.label}>{item.label}</Text>
              {item.description ? (
                <Text style={styles.description}>{item.description}</Text>
              ) : null}
            </View>
            <Switch
              value={enabledMap[item.id] ?? item.enabledByDefault}
              onValueChange={(v) => onToggle(item.id, v)}
            />
          </View>
        )}
        ListFooterComponent={
          <View>
            <View style={styles.row}>
              <View style={styles.rowText}>
                <Text style={styles.label}>Debug: outline matches</Text>
                <Text style={styles.description}>
                  Outlines filtered elements in red instead of hiding them and
                  logs per-selector match counts to Metro
                </Text>
              </View>
              <Switch value={debug} onValueChange={onToggleDebug} />
            </View>
            <Pressable style={styles.reload} onPress={onReload}>
              <Text style={styles.reloadText}>Reload page</Text>
            </Pressable>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ccc',
  },
  title: { fontSize: 18, fontWeight: '600' },
  close: { fontSize: 16, color: '#065fd4', fontWeight: '600' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#eee',
  },
  rowText: { flex: 1, paddingRight: 12 },
  label: { fontSize: 16 },
  description: { fontSize: 13, color: '#666', marginTop: 2 },
  reload: { margin: 16, padding: 12, borderRadius: 8, backgroundColor: '#f2f2f2', alignItems: 'center' },
  reloadText: { fontSize: 15, fontWeight: '600', color: '#c00' },
});
