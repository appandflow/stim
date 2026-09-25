#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
website=../../website

swift build -c release
app=build/Stim.app
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$(swift build -c release --show-bin-path)/StimDesktop" "$app/Contents/MacOS/StimDesktop"
cp Support/Info.plist "$app/Contents/Info.plist"
cp Support/AppIcon.icns "$app/Contents/Resources/AppIcon.icns"
cp "$website/src/css/fonts/InterVariable.woff2" "$website/src/css/fonts/JetBrainsMono-Regular.woff2" \
  "$website/src/css/fonts/Inter-LICENSE.txt" "$website/src/css/fonts/JetBrainsMono-OFL.txt" \
  "$website/static/img/branding/logo-dark.svg" "$website/static/img/branding/hero-dark.svg" \
  "$website/static/img/branding/logo.svg" "$website/static/img/branding/hero.svg" \
  "$app/Contents/Resources/"
xcrun -sdk iphonesimulator clang -fobjc-arc -arch arm64 -arch x86_64 -mios-simulator-version-min=18.0 \
  -framework Foundation Support/SimFold/main.m -o "$app/Contents/Resources/sim-fold" \
  -Wl,-sectcreate,__TEXT,__entitlements,Support/SimFold/entitlements.plist
codesign --force --sign - "$app/Contents/Resources/sim-fold"
codesign --force --sign - "$app"
echo "$PWD/$app"
