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
  /**
   * Extra manifest permissions. react-native-webview already turns a page's
   * getUserMedia into an Android runtime prompt, but Android silently denies a
   * permission the manifest doesn't declare — so without these, no dialog.
   */
  permissions?: string[];
}

// Voice/video messages. MODIFY_AUDIO_SETTINGS is install-time (no prompt);
// WebView's WebRTC audio path needs it or the mic can record silence.
const MEDIA_CAPTURE = [
  'android.permission.RECORD_AUDIO',
  'android.permission.CAMERA',
  'android.permission.MODIFY_AUDIO_SETTINGS',
];

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
    permissions: MEDIA_CAPTURE,
  },
  telegram: {
    name: 'FreeTele',
    slug: 'FreeTele',
    androidPackage: 'com.nima.freetele',
    // Teal, not Telegram's blue: FreeTube already owns the pale blue above, and
    // this colour is the only thing telling the launcher icons apart.
    iconBackground: '#D7F0EA',
    // Tapping a downloaded APK hands it to Android's installer, which refuses
    // apps that don't declare this ("install unknown apps" is then asked once).
    permissions: [...MEDIA_CAPTURE, 'android.permission.REQUEST_INSTALL_PACKAGES'],
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
      permissions: [...(config.android?.permissions ?? []), ...(variant.permissions ?? [])],
      adaptiveIcon: {
        ...(config.android?.adaptiveIcon ?? {}),
        backgroundColor: variant.iconBackground,
      },
    },
  };
};
