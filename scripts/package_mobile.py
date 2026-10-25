"""Produce local APK, self-contained iOS source and unsigned web distributions."""
from pathlib import Path
import hashlib
import re
import shutil
import zipfile
import plistlib

ROOT = Path(__file__).resolve().parents[1]


def main():
    output = ROOT / "release/mobile"
    output.mkdir(parents=True, exist_ok=True)
    apk = ROOT / "apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk"
    variant = None
    if apk.is_file():
        shutil.copy2(apk, output / "Ayana-0.2.0-android.apk")
        build = re.search(r"\bversionCode\s+(\d+)", (ROOT / "apps/mobile/android/app/build.gradle").read_text()).group(1)
        variant = output / f"Ayana-0.2.0-android-build{build}.apk"
        shutil.copy2(apk, variant)
    ios = output / "Ayana-0.2.0-ios-project.zip"
    with zipfile.ZipFile(ios, "w", zipfile.ZIP_DEFLATED) as archive:
        mobile = ROOT / "apps/mobile"
        for directory in ("src", "public", "ios"):
            for path in (mobile / directory).rglob("*"):
                if path.is_file() and not {"build", "DerivedData", ".build", "xcuserdata"}.intersection(path.parts):
                    archive.write(path, path.relative_to(ROOT))
        for name in ("package.json", "package-lock.json", "tsconfig.json", "vite.config.ts", "capacitor.config.ts", "index.html", "README.md"):
            archive.write(mobile / name, (mobile / name).relative_to(ROOT))
        for name in ("scripts/build_mobile_ios.sh", "scripts/audit_mobile_ios.sh", "scripts/audit_mobile_layout.mjs", "scripts/test_mobile_state.mjs", "scripts/test_mobile_model_history.mjs", "scripts/verify_mobile_ui.mjs", "scripts/verify_mobile_offline.mjs", "docs/MOBILE_INDEPENDENT_DELIVERY.md", "docs/MOBILE_IOS_INSTALL.md", "docs/MOBILE_ACCEPTANCE_2026-10-25.md", "docs/MOBILE_UI_AUDIT_2026-10-25.md", "docs/MOBILE_FLOATING_2026-10-25.md", "docs/MOBILE_TYPOGRAPHY_2026-10-25.md"):
            path = ROOT / name
            if path.is_file():
                archive.write(path, name)
    with zipfile.ZipFile(output / "Ayana-0.2.0-web.zip", "w", zipfile.ZIP_DEFLATED) as archive:
        for path in (ROOT / "apps/mobile/dist").rglob("*"):
            if path.is_file():
                archive.write(path, path.relative_to(ROOT / "apps/mobile/dist"))
    files = [output / "Ayana-0.2.0-android.apk", output / "Ayana-0.2.0-ios-unsigned.ipa", ios, output / "Ayana-0.2.0-web.zip"]
    if variant:
        files.append(variant)
    unsigned = output / "Ayana-0.2.0-ios-unsigned.ipa"
    if unsigned.is_file():
        with zipfile.ZipFile(unsigned) as archive:
            ios_build = str(plistlib.loads(archive.read("Payload/App.app/Info.plist"))["CFBundleVersion"])
        if re.fullmatch(r"\d+", ios_build):
            ios_variant = output / f"Ayana-0.2.0-ios-build{ios_build}-unsigned.ipa"
            shutil.copy2(unsigned, ios_variant)
            files.append(ios_variant)
    (output / "SHA256SUMS-0.2.0.txt").write_text("\n".join(
        hashlib.sha256(path.read_bytes()).hexdigest() + "  " + path.name for path in files if path.is_file()) + "\n", encoding="ascii")
    for path in files:
        if path.is_file():
            print(path.name, path.stat().st_size, "bytes")


if __name__ == "__main__":
    main()
