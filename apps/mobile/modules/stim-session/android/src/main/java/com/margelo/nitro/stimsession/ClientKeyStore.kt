package com.margelo.nitro.stimsession

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.annotation.Keep
import com.facebook.proguard.annotations.DoNotStrip
import com.margelo.nitro.NitroModules
import java.security.KeyStore
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Keeps this phone's raw X25519 private key in app storage, encrypted with an AES-GCM key that never leaves the
 * Android Keystore. The Keystore cannot hold X25519 keys in a form libsodium can use, so it wraps the key instead.
 */
@DoNotStrip
@Keep
object ClientKeyStore {
  private const val KEYSTORE = "AndroidKeyStore"
  private const val WRAPPING_KEY = "stim.noise.client-key-wrap"
  private const val PREFERENCES = "stim.noise"
  private const val ENTRY = "client-x25519"
  private const val TAG_BITS = 128
  private const val KEY_BYTES = 32

  private fun preferences() =
    (NitroModules.applicationContext ?: error("React Native has not started"))
      .getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

  private fun wrappingKey(): SecretKey {
    val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
    (keyStore.getKey(WRAPPING_KEY, null) as? SecretKey)?.let { return it }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
    generator.init(
      KeyGenParameterSpec.Builder(WRAPPING_KEY, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build()
    )
    return generator.generateKey()
  }

  /**
   * The stored key, or null when there is none or the stored one can never be read: malformed, wrapped by a Keystore
   * key this install does not have (an Auto Backup restore or a reinstall), or failing its tag. Such an entry is
   * deleted, so the session makes a new key. Other Keystore failures throw.
   */
  @JvmStatic
  @DoNotStrip
  @Keep
  fun load(): ByteArray? {
    val stored = preferences().getString(ENTRY, null) ?: return null
    val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
    if (!keyStore.containsAlias(WRAPPING_KEY)) return discard()
    val parts = stored.split(':')
    if (parts.size != 2) return discard()
    val key = try {
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, wrappingKey(), GCMParameterSpec(TAG_BITS, Base64.decode(parts[0], Base64.NO_WRAP)))
      cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP))
    } catch (_: AEADBadTagException) {
      return discard()
    } catch (_: IllegalArgumentException) {
      return discard()
    }
    return if (key.size == KEY_BYTES) key else discard()
  }

  private fun discard(): ByteArray? {
    check(preferences().edit().remove(ENTRY).commit()) { "Could not delete the unreadable client key" }
    return null
  }

  @JvmStatic
  @DoNotStrip
  @Keep
  fun store(key: ByteArray) {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, wrappingKey())
    val sealed = Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" +
      Base64.encodeToString(cipher.doFinal(key), Base64.NO_WRAP)
    check(preferences().edit().putString(ENTRY, sealed).commit()) { "Could not save the client key" }
  }
}
