import AsyncStorage from '@react-native-async-storage/async-storage';
import { EnabledMap } from '../filters/types';

// Namespaced per profile so multi-site support later needs no migration.
const key = (profileId: string) => 'settings:' + profileId;

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
