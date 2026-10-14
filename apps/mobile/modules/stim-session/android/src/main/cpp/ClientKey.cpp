#include "ClientKey.hpp"

#include <fbjni/fbjni.h>

#include <cstring>
#include <stdexcept>

namespace stim::platform {

namespace jni = facebook::jni;

namespace {

struct JClientKeyStore : jni::JavaClass<JClientKeyStore> {
  static constexpr auto kJavaDescriptor = "Lcom/margelo/nitro/stimsession/ClientKeyStore;";
};

std::runtime_error javaError(const char* action, const jni::JniException& error) {
  return std::runtime_error(std::string("The Android Keystore could not ") + action + " the client key: " +
                            error.what());
}

} // namespace

std::optional<noise::Key> loadClientPrivateKey() {
  try {
    static const auto load = JClientKeyStore::javaClassStatic()->getStaticMethod<jni::JArrayByte()>("load");
    auto bytes = load(JClientKeyStore::javaClassStatic());
    if (!bytes) return std::nullopt;
    if (bytes->size() != noise::kKeyBytes) throw std::runtime_error("The stored client key is not 32 bytes");
    noise::Key key;
    auto pinned = bytes->pin();
    std::memcpy(key.data(), pinned.get(), key.size());
    std::memset(pinned.get(), 0, key.size());
    return key;
  } catch (const jni::JniException& error) {
    throw javaError("read", error);
  }
}

void storeClientPrivateKey(const noise::Key& privateKey) {
  try {
    static const auto store =
        JClientKeyStore::javaClassStatic()->getStaticMethod<void(jni::alias_ref<jni::JArrayByte>)>("store");
    auto bytes = jni::JArrayByte::newArray(privateKey.size());
    bytes->setRegion(0, privateKey.size(), reinterpret_cast<const jbyte*>(privateKey.data()));
    store(JClientKeyStore::javaClassStatic(), bytes);
  } catch (const jni::JniException& error) {
    throw javaError("store", error);
  }
}

void withJvm(const std::function<void()>& fn) {
  // fbjni runs `fn` under a Java frame, which a C++ exception must not unwind.
  std::exception_ptr failure;
  jni::ThreadScope::WithClassLoader([&] {
    try {
      fn();
    } catch (...) {
      failure = std::current_exception();
    }
  });
  if (failure) std::rethrow_exception(failure);
}

} // namespace stim::platform
