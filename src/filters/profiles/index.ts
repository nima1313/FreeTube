import { SiteProfile } from '../types';
import { instagramProfile } from './instagram';
import { telegramProfile } from './telegram';
import { youtubeProfile } from './youtube';

export const PROFILES: Record<string, SiteProfile> = {
  youtube: youtubeProfile,
  instagram: instagramProfile,
  telegram: telegramProfile,
};

export const DEFAULT_PROFILE_ID = 'youtube';

// Must stay a literal `process.env.X` dot access: Metro only inlines
// statically-referenced EXPO_PUBLIC_* properties, so destructuring or bracket
// access would leave this undefined in a release build. The matching build-time
// half of this switch lives in app.config.ts.
const PROFILE_ID = process.env.EXPO_PUBLIC_APP_PROFILE ?? DEFAULT_PROFILE_ID;

export const activeProfile: SiteProfile = PROFILES[PROFILE_ID] ?? youtubeProfile;
