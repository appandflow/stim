#include "HybridNoiseCheck.hpp"

#include "ClientKey.hpp"
#include "HybridStimSession.hpp"
#include "Noise.hpp"

#include <NitroModules/ArrayBuffer.hpp>

#include <chrono>
#include <cstring>

namespace margelo::nitro::stimsession {

namespace noise = stim::noise;

ThroughputResult HybridNoiseCheck::measureThroughput(double bytesValue, double countValue) {
  const size_t bytes = static_cast<size_t>(bytesValue);
  const size_t count = static_cast<size_t>(countValue);
  const std::string subscription = "s1";
  const size_t header = 21 + subscription.size();
  if (bytes <= header || bytes > stim::protocol::kMaxReceiveBytes) throw std::invalid_argument("bad message size");
  noise::Key k;
  k.fill(7);
  noise::Transport sender(noise::CipherState(k.data()), noise::CipherState(k.data()), bytes, bytes);
  noise::Transport receiver(noise::CipherState(k.data()), noise::CipherState(k.data()), bytes, bytes);
  noise::Bytes packet(bytes, 0);
  packet[0] = 1;
  packet[2] = static_cast<uint8_t>(header >> 8);
  packet[3] = static_cast<uint8_t>(header & 0xff);
  packet[16] = 0x03, packet[17] = 0x20;
  packet[18] = 0x05, packet[19] = 0x00;
  packet[20] = static_cast<uint8_t>(subscription.size());
  std::memcpy(packet.data() + 21, subscription.data(), subscription.size());
  std::vector<noise::Bytes> messages;
  messages.reserve(count);
  for (size_t i = 0; i < count; i++) {
    packet[1] = i == 0 ? 1 : 0;
    messages.push_back(sender.encrypt(noise::MessageType::Binary, packet.data(), packet.size()));
  }
  auto stream = HybridStimSession::createVideoStream();
  std::unordered_map<std::string, std::weak_ptr<HybridVideoStreamSpec>> streams{{subscription, stream}};
  const auto start = std::chrono::steady_clock::now();
  for (const auto& message : messages) {
    auto plaintext = std::make_unique<noise::Bytes>();
    receiver.decrypt(message.data(), message.size(), *plaintext);
    auto found = streams.find(HybridStimSession::videoSubscription(plaintext->data() + 1, plaintext->size() - 1));
    if (found == streams.end()) continue;
    auto target = found->second.lock();
    noise::Bytes* owned = plaintext.release();
    auto buffer = ArrayBuffer::wrap(owned->data() + 1, owned->size() - 1, [owned]() { delete owned; });
    stim::platform::withJvm([&] { target->push(buffer); });
  }
  const double seconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count();
  stream->dispose();
  return ThroughputResult(static_cast<double>(bytes) * static_cast<double>(count) / 1e6 / seconds,
                          static_cast<double>(count));
}

} // namespace margelo::nitro::stimsession
