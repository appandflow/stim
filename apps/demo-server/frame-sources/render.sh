#!/bin/bash
set -e
cd "$(dirname "$0")"
C="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
render() { # name w h scale
  # Headless Chrome can stay running after it writes the screenshot, so it gets a time limit.
  timeout 30 "$C" --headless --user-data-dir="$PWD/chrome-profile-$1" --disable-gpu --hide-scrollbars --force-device-scale-factor=$4 --window-size=$2,$3 --screenshot="$PWD/$1.png" "file://$PWD/$1.html" >/dev/null 2>&1 || true
  sips -s format jpeg -s formatOptions 85 "$1.png" --out "../fixtures/frame-$1.jpg" >/dev/null
  rm -rf "chrome-profile-$1" "$1.png"
}
pages="ios:440:956:2 ios-tapped:440:956:2 android:412:915:2 web:1280:800:1 notes-ios:440:956:2 notes-ios-tapped:440:956:2 notes-android:412:915:2 notes-web:1280:800:1 notes-macos:1000:680:2"
for page in $pages; do
  IFS=: read -r name w h scale <<<"$page"
  if [ $# -eq 0 ] || [[ " $* " == *" $name "* ]]; then render "$name" "$w" "$h" "$scale"; fi
done
