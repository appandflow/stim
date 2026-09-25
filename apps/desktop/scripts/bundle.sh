#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
website=../../website

app=build/Stim.app
if [ "${1:-}" = --universal ]; then
  # A multi-arch `swift build` uses the PIF backend, which rejects .swiftLanguageMode(.v5):
  # https://github.com/swiftlang/swift-package-manager/issues/7958
  swift build -c release --arch arm64 --scratch-path .build/arm64
  swift build -c release --arch x86_64 --scratch-path .build/x86_64
  bin=$(swift build -c release --arch arm64 --scratch-path .build/arm64 --show-bin-path)
  x86_bin=$(swift build -c release --arch x86_64 --scratch-path .build/x86_64 --show-bin-path)
else
  swift build -c release
  bin=$(swift build -c release --show-bin-path)
fi
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources" "$app/Contents/Frameworks"
if [ -n "${x86_bin:-}" ]; then
  lipo -create "$bin/StimDesktop" "$x86_bin/StimDesktop" -output "$app/Contents/MacOS/StimDesktop"
else
  cp "$bin/StimDesktop" "$app/Contents/MacOS/StimDesktop"
fi
install_name_tool -add_rpath @executable_path/../Frameworks "$app/Contents/MacOS/StimDesktop"
ditto "$bin/Lottie.framework" "$app/Contents/Frameworks/Lottie.framework"
codesign --force --sign - "$app/Contents/Frameworks/Lottie.framework"
ditto "$bin/Sparkle.framework" "$app/Contents/Frameworks/Sparkle.framework"
cp Support/Info.plist "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :SUPublicEDKey ${SPARKLE_PUBLIC_ED_KEY:-}" "$app/Contents/Info.plist"
cp Support/AppIcon.icns "$app/Contents/Resources/AppIcon.icns"
cp "$website/src/css/fonts/InterVariable.woff2" "$website/src/css/fonts/JetBrainsMono-Regular.woff2" \
  "$website/src/css/fonts/Inter-LICENSE.txt" "$website/src/css/fonts/JetBrainsMono-OFL.txt" \
  "$website/static/img/branding/stim-jar-dark.json" "$website/static/img/branding/stim-jar-light.json" \
  "$website/static/img/branding/wordmark.svg" \
  "$app/Contents/Resources/"
xcrun -sdk iphonesimulator clang -fobjc-arc -arch arm64 -arch x86_64 -mios-simulator-version-min=18.0 \
  -framework Foundation Support/SimFold/main.m -o "$app/Contents/Resources/sim-fold" \
  -Wl,-sectcreate,__TEXT,__entitlements,Support/SimFold/entitlements.plist
codesign --force --sign - "$app/Contents/Resources/sim-fold"
codesign --force --sign - "$app"
echo "$PWD/$app"
