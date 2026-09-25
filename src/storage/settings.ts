import AsyncStorage from '@react-native-async-storage/async-storage';
import { EnabledMap, ParamMap } from '../filters/types';

// Namespaced per profile so multi-site support later needs no migration.
const key = (profileId: string) => 'settings:' + profileId;
// Rule params live under their own key rather than inside the settings blob:
// folding them in would have meant migrating every already-installed build, and
// this way the two shapes stay independently readable.
const paramKey = (profileId: string) => 'params:' + profileId;

export async function loadEnabledMap(profileId: string): Promise<EnabledMap> {
  try {
    const raw = await AsyncStorage.getItem(key(profileId));
    return raw ? (JSON.parse(raw) as EnabledMap) : {};
  } catch {
    return {};
  }
}

export async function saveEnabledMap(profileId: string, map: EnabledMap): Promise<void> {
  await AsyncStorage.setItem(key(profileId), JSON.stringify(map));
}

export async function loadParamMap(profileId: string): Promise<ParamMap> {
  try {
    const raw = await AsyncStorage.getItem(paramKey(profileId));
    return raw ? (JSON.parse(raw) as ParamMap) : {};
  } catch {
    return {};
  }
}

export async function saveParamMap(profileId: string, map: ParamMap): Promise<void> {
  await AsyncStorage.setItem(paramKey(profileId), JSON.stringify(map));
}
