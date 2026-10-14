package com.margelo.nitro.stimsession

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.annotation.Keep
import com.facebook.proguard.annotations.DoNotStrip
import com.margelo.nitro.NitroModules
import java.security.KeyStore
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

  @JvmStatic
  @DoNotStrip
  @Keep
  fun load(): ByteArray? {
    val stored = preferences().getString(ENTRY, null) ?: return null
    val parts = stored.split(':')
    require(parts.size == 2) { "The stored client key is malformed" }
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, wrappingKey(), GCMParameterSpec(TAG_BITS, Base64.decode(parts[0], Base64.NO_WRAP)))
    return cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP))
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
