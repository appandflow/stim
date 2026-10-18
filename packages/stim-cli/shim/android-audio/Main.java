package dev.stim.audio;

import android.content.Context;
import android.media.AudioManager;
import android.os.Looper;

public final class Main {
  public static void main(String[] args) throws Exception {
    if (args.length != 1) throw new IllegalArgumentException("Expected one media volume index");
    Looper.prepareMainLooper();
    Class<?> activityThread = Class.forName("android.app.ActivityThread");
    Object thread = activityThread.getDeclaredMethod("systemMain").invoke(null);
    Context system = (Context) activityThread.getDeclaredMethod("getSystemContext").invoke(thread);
    // AudioService's AppOps check requires the shell UID's actual package.
    Context shell = system.createPackageContext("com.android.shell", 0);
    AudioManager audio = (AudioManager) shell.getSystemService(Context.AUDIO_SERVICE);
    int volume = Integer.parseInt(args[0]);
    if (volume < 0 || volume > audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC)) {
      throw new IllegalArgumentException("Media volume out of range");
    }
    audio.setStreamVolume(AudioManager.STREAM_MUSIC, volume, 0);
    System.out.println(audio.getStreamVolume(AudioManager.STREAM_MUSIC));
  }
}
