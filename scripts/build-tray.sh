#!/bin/zsh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/tray"
swift build -c release
BIN="$(swift build -c release --show-bin-path)/DevboardTray"
DIST="$ROOT/tray/Dist/Devboard.app"
rm -rf "$DIST"
mkdir -p "$DIST/Contents/MacOS"
cp "$BIN" "$DIST/Contents/MacOS/Devboard"
cat > "$DIST/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Devboard</string>
  <key>CFBundleDisplayName</key>
  <string>Devboard</string>
  <key>CFBundleIdentifier</key>
  <string>local.devboard.tray</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleExecutable</key>
  <string>Devboard</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>DevboardRoot</key>
  <string>${ROOT}</string>
</dict>
</plist>
EOF
codesign --force --sign - --identifier local.devboard.tray "$DIST" >/dev/null
DEST="$HOME/Applications/Devboard.app"
mkdir -p "$HOME/Applications"
rm -rf "$DEST"
cp -R "$DIST" "$DEST"
codesign --force --sign - --identifier local.devboard.tray "$DEST" >/dev/null
echo "installed $DEST"
