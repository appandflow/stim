# Android media control

`Main.java` calls Android's media-volume API with the shell package identity.
The CLI and Desktop bundle the same small helper; users do not need a host JDK.
Desktop stores its copy as base64 so its Sources tree remains ASCII-only.

To rebuild both checked-in artifacts, use JDK 17 or later, Android SDK Platform
34 and Build Tools 35.0.1, then run from the repository root:

```sh
ANDROID_HOME=/path/to/android-sdk node scripts/build-android-audio.mjs
```

The build pins the Android inputs and jar timestamps. Runtime callers transfer
an invocation-specific file only to their verified emulator and remove it after
use. They confirm the requested media volume independently; ringtone and alarm
streams are unchanged.
