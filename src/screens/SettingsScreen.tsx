import React, { useEffect, useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { EnabledMap, FilterRule, ParamMap, SiteProfile } from '../filters/types';

interface Props {
  profile: SiteProfile;
  enabledMap: EnabledMap;
  paramMap: ParamMap;
  debug: boolean;
  onToggle(ruleId: string, value: boolean): void;
  onParamChange(ruleId: string, value: string): void;
  onToggleDebug(value: boolean): void;
  /** When the current focus break ends (epoch ms); 0 or past means none. */
  focusBreakUntil: number;
  onFocusBreak(): void;
  onReload(): void;
  onClose(): void;
}

/**
 * Text field for a rule's param. The edit is committed on blur/submit rather
 * than per keystroke: every commit re-injects the rules, and for the focus
 * folder that restarts the retry loop — so typing a name would otherwise send
 * it chasing every prefix of what the user is halfway through writing.
 */
function ParamField({
  rule,
  value,
  enabled,
  onCommit,
}: {
  rule: FilterRule;
  value: string;
  enabled: boolean;
  onCommit(value: string): void;
}) {
  const [draft, setDraft] = useState(value);

  return (
    <TextInput
      style={[styles.param, !enabled && styles.paramDisabled]}
      value={draft}
      editable={enabled}
      placeholder={rule.param?.placeholder}
      placeholderTextColor="#aaa"
      autoCapitalize="none"
      autoCorrect={false}
      returnKeyType="done"
      accessibilityLabel={rule.param?.label}
      onChangeText={setDraft}
      onBlur={() => onCommit(draft.trim())}
      onSubmitEditing={() => onCommit(draft.trim())}
    />
  );
}

/**
 * "Unlock for 1 minute", under the focus-lock rule: lifts the lock briefly,
 * then it comes back by itself. Counts down instead while a break is running.
 */
function FocusBreakButton({
  until,
  lockOn,
  onPress,
}: {
  until: number;
  lockOn: boolean;
  onPress(): void;
}) {
  const [now, setNow] = useState(Date.now());
  const left = Math.ceil((until - now) / 1000);
  const running = lockOn && left > 0;

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [running]);

  const label = running
    ? `Unlocked — focus back in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
    : 'Unlock for 1 minute';
  return (
    <View style={styles.breakRow}>
      <Pressable
        style={[styles.breakButton, (!lockOn || running) && styles.breakButtonOff]}
        disabled={!lockOn || running}
        onPress={() => {
          setNow(Date.now());
          onPress();
        }}
        accessibilityRole="button"
      >
        <Text style={styles.breakText}>{label}</Text>
      </Pressable>
      {lockOn ? null : <Text style={styles.description}>Turn on Block other chats to use this.</Text>}
    </View>
  );
}

export default function SettingsScreen({
  profile,
  enabledMap,
  paramMap,
  debug,
  onToggle,
  onParamChange,
  onToggleDebug,
  focusBreakUntil,
  onFocusBreak,
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
        renderItem={({ item }) => {
          const enabled = enabledMap[item.id] ?? item.enabledByDefault;
          return (
            <View style={styles.row}>
              <View style={styles.rowText}>
                <Text style={styles.label}>{item.label}</Text>
                {item.description ? (
                  <Text style={styles.description}>{item.description}</Text>
                ) : null}
                {item.param ? (
                  <ParamField
                    rule={item}
                    value={paramMap[item.id] ?? item.param.defaultValue}
                    enabled={enabled}
                    onCommit={(v) => onParamChange(item.id, v)}
                  />
                ) : null}
                {item.jsAction === 'focusLock' ? (
                  <FocusBreakButton until={focusBreakUntil} lockOn={enabled} onPress={onFocusBreak} />
                ) : null}
              </View>
              <Switch value={enabled} onValueChange={(v) => onToggle(item.id, v)} />
            </View>
          );
        }}
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
  param: {
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 15,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#ccc',
    borderRadius: 8,
    backgroundColor: '#fff',
    color: '#000',
  },
  paramDisabled: { backgroundColor: '#f2f2f2', color: '#999' },
  breakRow: { marginTop: 10 },
  breakButton: {
    alignSelf: 'flex-start',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#3390ec',
  },
  breakButtonOff: { opacity: 0.45 },
  breakText: { fontSize: 14, fontWeight: '600', color: '#3390ec' },
  reload: { margin: 16, padding: 12, borderRadius: 8, backgroundColor: '#f2f2f2', alignItems: 'center' },
  reloadText: { fontSize: 15, fontWeight: '600', color: '#c00' },
});
