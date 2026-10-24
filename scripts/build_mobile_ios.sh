#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/apps/mobile"
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo 'iOS native compilation requires macOS and Xcode.' >&2
  exit 1
fi
XCODE_MAJOR="$(xcodebuild -version | awk '/^Xcode / {split($2, version, "."); print version[1]}')"
if [[ "$XCODE_MAJOR" -lt 26 ]]; then
  echo 'Capacitor 8 requires Xcode 26 or later. Select it using DEVELOPER_DIR or xcode-select.' >&2
  exit 1
fi
npm ci
npm run build
npx cap sync ios
OUTPUT="$ROOT/release/mobile"
mkdir -p "$OUTPUT"
SIGNING=(CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO)
LABEL=unsigned
CONFIGURATION=Release
DESTINATION='generic/platform=iOS'
BUILD_ARGS=(-project ios/App/App.xcodeproj -scheme App)
if [[ -n "${AYANA_IOS_BUNDLE_ID:-}" ]]; then
  BUILD_ARGS+=("PRODUCT_BUNDLE_IDENTIFIER=$AYANA_IOS_BUNDLE_ID")
fi
if [[ -n "${APPLE_TEAM_ID:-}" ]]; then
  SIGNING=(CODE_SIGN_STYLE=Automatic 'CODE_SIGN_IDENTITY=Apple Development' "DEVELOPMENT_TEAM=$APPLE_TEAM_ID" -allowProvisioningUpdates)
  LABEL=development-signed
  CONFIGURATION=Debug
  if [[ -n "${IOS_DEVICE_ID:-}" ]]; then DESTINATION="platform=iOS,id=$IOS_DEVICE_ID"; fi
fi
xcodebuild "${BUILD_ARGS[@]}" -configuration "$CONFIGURATION" \
  -sdk iphoneos -destination "$DESTINATION" -derivedDataPath "$ROOT/.runtime/ios-build" \
  "${SIGNING[@]}" build
APP="$ROOT/.runtime/ios-build/Build/Products/$CONFIGURATION-iphoneos/App.app"
test -d "$APP"
STAGE="$(mktemp -d)"
mkdir -p "$STAGE/Payload"
cp -R "$APP" "$STAGE/Payload/App.app"
(cd "$STAGE" && zip -qry "$OUTPUT/Ayana-0.2.0-ios-$LABEL.ipa" Payload)
echo "Created $OUTPUT/Ayana-0.2.0-ios-$LABEL.ipa"
if [[ "$LABEL" == unsigned ]]; then
  echo 'This IPA requires a valid signature before installation on an ordinary iPhone.'
fi
