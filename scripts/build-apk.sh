#!/usr/bin/env bash
# Builds a signed release APK for one variant.
#
# EXPO_PUBLIC_APP_PROFILE has to be set for BOTH steps:
#   - `expo prebuild` writes the app name / package id into the native project
#   - `gradlew assembleRelease` is where Metro bundles the JS and inlines the
#     variable into `src/filters/profiles/index.ts`
# Setting it for only the prebuild produces an APK that is branded correctly but
# silently ships the DEFAULT profile's filters — an Instagram-looking app that
# opens YouTube. That bug shipped once; this script exists so it can't recur.
#
# Usage: scripts/build-apk.sh <youtube|instagram|telegram> [output.apk]
set -euo pipefail

VARIANT="${1:?usage: build-apk.sh <youtube|instagram|telegram> [output.apk]}"
case "$VARIANT" in
  youtube|instagram|telegram) ;;
  *) echo "unknown variant '$VARIANT' (expected youtube, instagram or telegram)" >&2; exit 1 ;;
esac

export EXPO_PUBLIC_APP_PROFILE="$VARIANT"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

OUT="${2:-$ROOT/build/$VARIANT.apk}"
KEYSTORE_BACKUP="$ROOT/.keystore-backup/debug.keystore"

# `prebuild --clean` deletes android/, taking the signing key with it. Keeping
# one key across rebuilds is what lets a new APK install over the old one
# instead of demanding an uninstall (which would drop the logged-in session).
if [ -f android/app/debug.keystore ] && [ ! -f "$KEYSTORE_BACKUP" ]; then
  mkdir -p "$(dirname "$KEYSTORE_BACKUP")"
  cp android/app/debug.keystore "$KEYSTORE_BACKUP"
  echo "==> saved signing key to $KEYSTORE_BACKUP"
fi

echo "==> prebuild ($VARIANT)"
npx expo prebuild --clean --platform android

echo "sdk.dir=$ANDROID_HOME" > android/local.properties
if [ -f "$KEYSTORE_BACKUP" ]; then
  cp "$KEYSTORE_BACKUP" android/app/debug.keystore
fi

# --no-build-cache: Gradle does not track environment variables as task inputs,
# so the JS bundle built for the other variant would otherwise be reused
# verbatim — the exact failure this script guards against.
echo "==> assembleRelease ($VARIANT)"
(cd android && ./gradlew assembleRelease --no-daemon --no-build-cache)

mkdir -p "$(dirname "$OUT")"
cp android/app/build/outputs/apk/release/app-release.apk "$OUT"
echo "==> wrote $OUT"
