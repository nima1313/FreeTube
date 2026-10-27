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
  /**
   * assets/icons/<icons>/ — the Liberty-torch icon with this site's logo as
   * the flame, drawn by scripts/make-icons.mjs.
   */
  icons: string;
  /** Adaptive-icon background; must match ICON_BACKGROUNDS in make-icons.mjs. */
  iconBackground: string;
  /**
   * Extra manifest permissions. react-native-webview already turns a page's
   * getUserMedia into an Android runtime prompt, but Android silently denies a
   * permission the manifest doesn't declare — so without these, no dialog.
   */
  permissions?: string[];
  /**
   * Lists the app in Android's share sheet. What arrives is handed to the
   * site's own share handling; see src/device/share.ts.
   */
  shareTarget?: boolean;
}

// Voice/video messages. MODIFY_AUDIO_SETTINGS is install-time (no prompt);
// WebView's WebRTC audio path needs it or the mic can record silence.
const MEDIA_CAPTURE = [
  'android.permission.RECORD_AUDIO',
  'android.permission.CAMERA',
  'android.permission.MODIFY_AUDIO_SETTINGS',
];

// One file, several files, or text (a link), of any type: the same set the
// Telegram app accepts.
const SHARE_INTENT_FILTERS = ['SEND', 'SEND_MULTIPLE'].map((action) => ({
  action,
  category: ['DEFAULT'],
  data: [{ mimeType: '*/*' }],
}));

const VARIANTS: Record<string, Variant> = {
  youtube: {
    name: 'FreeTube',
    slug: 'FreeTube',
    androidPackage: 'com.nima.freetube',
    icons: 'youtube',
    iconBackground: '#FDECEA',
  },
  instagram: {
    name: 'FreeGram',
    slug: 'FreeGram',
    androidPackage: 'com.nima.freegram',
    icons: 'instagram',
    iconBackground: '#FDE7F3',
    permissions: MEDIA_CAPTURE,
  },
  telegram: {
    name: 'FreeTele',
    slug: 'FreeTele',
    androidPackage: 'com.nima.freetele',
    icons: 'telegram',
    iconBackground: '#DCEFFB',
    // Tapping a downloaded APK hands it to Android's installer, which refuses
    // apps that don't declare this ("install unknown apps" is then asked once).
    permissions: [...MEDIA_CAPTURE, 'android.permission.REQUEST_INSTALL_PACKAGES'],
    shareTarget: true,
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

  const icons = './assets/icons/' + variant.icons + '/';
  return {
    ...config,
    name: variant.name,
    slug: variant.slug,
    icon: icons + 'icon.png',
    android: {
      ...(config.android ?? {}),
      package: variant.androidPackage,
      permissions: [...(config.android?.permissions ?? []), ...(variant.permissions ?? [])],
      // Built fresh rather than spread from app.json: a backgroundImage there
      // would win over the colour.
      adaptiveIcon: {
        foregroundImage: icons + 'foreground.png',
        monochromeImage: icons + 'monochrome.png',
        backgroundColor: variant.iconBackground,
      },
      intentFilters: [
        ...(config.android?.intentFilters ?? []),
        ...(variant.shareTarget ? SHARE_INTENT_FILTERS : []),
      ],
    },
  };
};
