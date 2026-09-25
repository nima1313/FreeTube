import { ConfigContext, ExpoConfig } from 'expo/config';

// One codebase, one APK per site. EXPO_PUBLIC_APP_PROFILE picks the variant at
// build time: this file gives it a distinct name/package/icon, and
// src/filters/profiles/index.ts reads the same variable to pick the filter set.
//
// The variants have different android.package values, so switching between them
// requires `expo prebuild --clean` — see AGENTS.md.
interface Variant {
  name: string;
  slug: string;
  androidPackage: string;
  /** Adaptive-icon background — the cheapest way to tell the two apps apart. */
  iconBackground: string;
}

const VARIANTS: Record<string, Variant> = {
  youtube: {
    name: 'FreeTube',
    slug: 'FreeTube',
    androidPackage: 'com.nima.freetube',
    iconBackground: '#E6F4FE',
  },
  instagram: {
    name: 'FreeGram',
    slug: 'FreeGram',
    androidPackage: 'com.nima.freegram',
    iconBackground: '#FDE7F3',
  },
  telegram: {
    name: 'FreeTele',
    slug: 'FreeTele',
    androidPackage: 'com.nima.freetele',
    // Teal, not Telegram's blue: FreeTube already owns the pale blue above, and
    // this colour is the only thing telling the launcher icons apart.
    iconBackground: '#D7F0EA',
  },
};

export default ({ config }: ConfigContext): ExpoConfig => {
  const id = process.env.EXPO_PUBLIC_APP_PROFILE ?? 'youtube';
  const variant = VARIANTS[id];
  // Fail loudly: a typo'd variable must not silently build the YouTube app.
  if (!variant) {
    throw new Error(
      'Unknown EXPO_PUBLIC_APP_PROFILE "' +
        id +
        '". Expected one of: ' +
        Object.keys(VARIANTS).join(', ')
    );
  }

  return {
    ...config,
    name: variant.name,
    slug: variant.slug,
    android: {
      ...(config.android ?? {}),
      package: variant.androidPackage,
      adaptiveIcon: {
        ...(config.android?.adaptiveIcon ?? {}),
        backgroundColor: variant.iconBackground,
      },
    },
  };
};
