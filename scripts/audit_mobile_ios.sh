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
OUTPUT="$ROOT/release/mobile/ios-layout-audit"
mkdir -p "$OUTPUT"
CONTAINER="$(xcrun simctl get_app_container "$DEVICE" dev.ayana.mobile data)"
collect_diagnostics() {
  if [[ -d "$CONTAINER/Documents/layout-audit" ]]; then cp "$CONTAINER/Documents/layout-audit/"* "$OUTPUT/" 2>/dev/null || true; fi
  xcrun simctl spawn "$DEVICE" log show --style compact --last 5m --predicate 'process == "App"' > "$OUTPUT/system.log" 2>&1 || true
}
trap collect_diagnostics EXIT
xcrun simctl launch --console --terminate-running-process "$DEVICE" dev.ayana.mobile --ayana-layout-audit > "$OUTPUT/console.log" 2>&1 &
LAUNCH_PID=$!
for attempt in $(seq 1 120); do
  if [[ -f "$CONTAINER/Documents/layout-audit/report.json" && -f "$CONTAINER/Documents/layout-audit/response-audit.json" ]]; then break; fi
  if ! kill -0 "$LAUNCH_PID" 2>/dev/null; then cat "$OUTPUT/console.log"; break; fi
  sleep 1
done
cat "$OUTPUT/console.log"
test -f "$CONTAINER/Documents/layout-audit/report.json"
test -f "$CONTAINER/Documents/layout-audit/response-audit.json"
cp "$CONTAINER/Documents/layout-audit/"* "$OUTPUT/"
cat "$OUTPUT/report.json"
cat "$OUTPUT/response-audit.json"
xcrun simctl terminate "$DEVICE" dev.ayana.mobile || true
wait "$LAUNCH_PID" || true
