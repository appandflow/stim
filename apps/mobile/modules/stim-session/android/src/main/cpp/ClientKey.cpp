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

namespace {

JavaVM* javaVm = nullptr;

/**
 * Keeps a native thread, such as the socket's, attached to the JVM from its first call until it exits.
 * fbjni's ThreadScope otherwise attaches and detaches it around every call, which is every video message.
 */
struct Attachment {
  JavaVM* vm = nullptr;
  bool ready = false;
  ~Attachment() {
    if (vm) vm->DetachCurrentThread();
  }
};
thread_local Attachment attachment;

} // namespace

void rememberJavaVm(JavaVM* vm) {
  javaVm = vm;
}

void withJvm(const std::function<void()>& fn) {
  if (attachment.ready) return fn();
  JNIEnv* env = nullptr;
  if (javaVm && javaVm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6) == JNI_EDETACHED) {
    JavaVMAttachArgs args{JNI_VERSION_1_6, const_cast<char*>("stim-session"), nullptr};
    if (javaVm->AttachCurrentThread(&env, &args) != JNI_OK) throw std::runtime_error("Could not attach to the JVM");
    attachment.vm = javaVm;
  }
  // The first call on a thread runs with the app's class loader, so fbjni can look up and cache the Kotlin classes
  // a native thread's bootstrap loader cannot see. fbjni runs `fn` under a Java frame, which a C++ exception must
  // not unwind.
  std::exception_ptr failure;
  jni::ThreadScope::WithClassLoader([&] {
    try {
      fn();
    } catch (...) {
      failure = std::current_exception();
    }
  });
  // Threads Java started keep the class loader on every call; only a thread attached here skips it afterwards.
  attachment.ready = attachment.vm != nullptr;
  if (failure) std::rethrow_exception(failure);
}

} // namespace stim::platform
