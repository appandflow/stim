#include "VideoPush.hpp"

#include "ClientKey.hpp"
#include "JHybridVideoStreamSpec.hpp"

#include <fbjni/ByteBuffer.h>
#include <fbjni/fbjni.h>

#include <cstring>

namespace stim::platform {

namespace jni = facebook::jni;
using margelo::nitro::stimsession::HybridVideoStreamSpec;
using margelo::nitro::stimsession::JHybridVideoStreamSpec;

namespace {

struct JHybridVideoStream : jni::JavaClass<JHybridVideoStream, JHybridVideoStreamSpec::JavaPart> {
  static constexpr auto kJavaDescriptor = "Lcom/margelo/nitro/stimsession/HybridVideoStream;";
};

} // namespace

void pushVideo(const std::shared_ptr<HybridVideoStreamSpec>& stream,
               const std::shared_ptr<margelo::nitro::ArrayBuffer>& packet) {
  auto java = std::dynamic_pointer_cast<JHybridVideoStreamSpec>(stream);
  withJvm([&] {
    if (!java) return stream->push(packet);
    static const auto obtain =
        JHybridVideoStream::javaClassStatic()->getMethod<jni::local_ref<jni::JByteBuffer>(jint)>("obtainBuffer");
    static const auto push =
        JHybridVideoStream::javaClassStatic()->getMethod<void(jni::alias_ref<jni::JByteBuffer>)>("pushBuffer");
    jni::alias_ref<JHybridVideoStreamSpec::JavaPart::javaobject> part = java->getJavaPart();
    auto self = jni::static_ref_cast<JHybridVideoStream::javaobject>(part);
    auto buffer = obtain(self, static_cast<jint>(packet->size()));
    std::memcpy(buffer->getDirectAddress(), packet->data(), packet->size());
    push(self, buffer);
  });
}

} // namespace stim::platform
