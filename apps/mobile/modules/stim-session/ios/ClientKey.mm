#include "ClientKey.hpp"

#import <Foundation/Foundation.h>
#import <Security/Security.h>

#include <cstring>
#include <stdexcept>
#include <string>

namespace stim::platform {

namespace {

NSString* const kService = @"com.appandflow.stim.noise";
NSString* const kAccount = @"client-x25519";

NSMutableDictionary* query() {
  return [@{
    (__bridge id)kSecClass : (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService : kService,
    (__bridge id)kSecAttrAccount : kAccount,
  } mutableCopy];
}

std::runtime_error keychainError(const char* action, OSStatus status) {
  return std::runtime_error(std::string("Keychain ") + action + " failed with OSStatus " + std::to_string(status));
}

} // namespace

std::optional<noise::Key> loadClientPrivateKey() {
  NSMutableDictionary* search = query();
  search[(__bridge id)kSecReturnData] = @YES;
  search[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
  CFTypeRef result = nullptr;
  const OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)search, &result);
  if (status == errSecItemNotFound) return std::nullopt;
  if (status != errSecSuccess) throw keychainError("read", status);
  NSData* data = (__bridge_transfer NSData*)result;
  if (data.length != noise::kKeyBytes) throw std::runtime_error("The stored client key is not 32 bytes");
  noise::Key key;
  std::memcpy(key.data(), data.bytes, key.size());
  return key;
}

void storeClientPrivateKey(const noise::Key& privateKey) {
  NSMutableDictionary* item = query();
  item[(__bridge id)kSecValueData] = [NSData dataWithBytes:privateKey.data() length:privateKey.size()];
  item[(__bridge id)kSecAttrAccessible] = (__bridge id)kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly;
  const OSStatus status = SecItemAdd((__bridge CFDictionaryRef)item, nullptr);
  if (status != errSecSuccess) throw keychainError("write", status);
}

void withJvm(const std::function<void()>& fn) {
  fn();
}

} // namespace stim::platform
