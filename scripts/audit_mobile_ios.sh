#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/apps/mobile"
# build_mobile_ios.sh has already installed packages and copied the production web assets.
AUDIT_BUILD="$ROOT/.runtime/ios-layout-build"
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$AUDIT_BUILD" CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build
DEVICE="$(xcrun simctl list devices available --json | python3 -c 'import json,sys; print(next(d["udid"] for devices in json.load(sys.stdin)["devices"].values() for d in devices if d["name"].startswith("iPhone")))')"
xcrun simctl boot "$DEVICE" || true
xcrun simctl bootstatus "$DEVICE" -b
xcrun simctl install "$DEVICE" "$AUDIT_BUILD/Build/Products/Debug-iphonesimulator/App.app"
xcrun simctl launch "$DEVICE" dev.ayana.mobile --ayana-layout-audit
CONTAINER="$(xcrun simctl get_app_container "$DEVICE" dev.ayana.mobile data)"
for attempt in $(seq 1 45); do
  if [[ -f "$CONTAINER/Documents/layout-audit/report.json" ]]; then break; fi
  sleep 1
done
test -f "$CONTAINER/Documents/layout-audit/report.json"
mkdir -p "$ROOT/release/mobile/ios-layout-audit"
cp "$CONTAINER/Documents/layout-audit/"* "$ROOT/release/mobile/ios-layout-audit/"
cat "$ROOT/release/mobile/ios-layout-audit/report.json"
xcrun simctl terminate "$DEVICE" dev.ayana.mobile || true
