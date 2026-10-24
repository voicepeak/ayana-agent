"""Produce local APK, self-contained iOS source and unsigned web distributions."""
from pathlib import Path
import hashlib
import shutil
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    output = ROOT / "release/mobile"
    output.mkdir(parents=True, exist_ok=True)
    apk = ROOT / "apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk"
    if apk.is_file():
        shutil.copy2(apk, output / "Ayana-0.2.0-android.apk")
    ios = output / "Ayana-0.2.0-ios-project.zip"
    with zipfile.ZipFile(ios, "w", zipfile.ZIP_DEFLATED) as archive:
        mobile = ROOT / "apps/mobile"
        for directory in ("src", "public", "ios"):
            for path in (mobile / directory).rglob("*"):
                if path.is_file() and not {"build", "DerivedData", ".build", "xcuserdata"}.intersection(path.parts):
                    archive.write(path, path.relative_to(ROOT))
        for name in ("package.json", "package-lock.json", "tsconfig.json", "vite.config.ts", "capacitor.config.ts", "index.html"):
            archive.write(mobile / name, (mobile / name).relative_to(ROOT))
        for name in ("scripts/build_mobile_ios.sh", "docs/MOBILE_INDEPENDENT_DELIVERY.md"):
            path = ROOT / name
            if path.is_file():
                archive.write(path, name)
    with zipfile.ZipFile(output / "Ayana-0.2.0-web.zip", "w", zipfile.ZIP_DEFLATED) as archive:
        for path in (ROOT / "apps/mobile/dist").rglob("*"):
            if path.is_file():
                archive.write(path, path.relative_to(ROOT / "apps/mobile/dist"))
    files = [output / "Ayana-0.2.0-android.apk", ios, output / "Ayana-0.2.0-web.zip"]
    (output / "SHA256SUMS-0.2.0.txt").write_text("\n".join(
        hashlib.sha256(path.read_bytes()).hexdigest() + "  " + path.name for path in files if path.is_file()) + "\n", encoding="ascii")
    for path in files:
        if path.is_file():
            print(path.name, path.stat().st_size, "bytes")


if __name__ == "__main__":
    main()
