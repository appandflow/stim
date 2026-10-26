#include "VideoPush.hpp"

namespace stim::platform {

void pushVideo(const std::shared_ptr<margelo::nitro::stimsession::HybridVideoStreamSpec>& stream,
               const std::shared_ptr<margelo::nitro::ArrayBuffer>& packet) {
  stream->push(packet);
}

} // namespace stim::platform
