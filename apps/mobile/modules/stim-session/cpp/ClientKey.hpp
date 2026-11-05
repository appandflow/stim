#pragma once

#include "Noise.hpp"

#include <functional>
#include <optional>

namespace stim::platform {

/**
 * This phone's long-term X25519 private key, from the iOS Keychain (kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)
 * or, on Android, app storage encrypted with an AES key held in the Android Keystore. Empty when none is stored.
 * Throws std::runtime_error when the store cannot be read.
 */
std::optional<noise::Key> loadClientPrivateKey();

/** Stores the key; throws std::runtime_error on failure. */
void storeClientPrivateKey(const noise::Key& privateKey);

/** Runs `fn` on a thread that can call into Kotlin; on iOS it runs `fn` directly. */
void withJvm(const std::function<void()>& fn);

} // namespace stim::platform
