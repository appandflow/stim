#pragma once

#include "HybridVideoStreamSpec.hpp"

#include <NitroModules/ArrayBuffer.hpp>

#include <memory>

namespace stim::platform {

/**
 * Hands one decrypted video message to `stream` on the calling thread. On Android it copies the message into a pooled
 * Java buffer and calls the Kotlin stream directly, so a message creates no Java objects; on iOS it calls `push`.
 */
void pushVideo(const std::shared_ptr<margelo::nitro::stimsession::HybridVideoStreamSpec>& stream,
               const std::shared_ptr<margelo::nitro::ArrayBuffer>& packet);

} // namespace stim::platform
