#include "HybridNoiseCheck.hpp"

#include "ClientKey.hpp"
#include "HybridStimSession.hpp"
#include "Noise.hpp"

#include <NitroModules/ArrayBuffer.hpp>

#include <chrono>
#include <cstring>

namespace margelo::nitro::stimsession {

namespace noise = stim::noise;

namespace {

noise::Bytes hex(const std::string& text) {
  noise::Bytes out;
  out.reserve(text.size() / 2);
  for (size_t i = 0; i + 1 < text.size(); i += 2) {
    out.push_back(static_cast<uint8_t>(std::stoi(text.substr(i, 2), nullptr, 16)));
  }
  return out;
}

std::string toHex(const uint8_t* data, size_t length) {
  static const char digits[] = "0123456789abcdef";
  std::string out;
  out.reserve(length * 2);
  for (size_t i = 0; i < length; i++) {
    out += digits[data[i] >> 4];
    out += digits[data[i] & 15];
  }
  return out;
}

noise::Key key(const std::string& text) {
  noise::Bytes bytes = hex(text);
  if (bytes.size() != noise::kKeyBytes) throw noise::NoiseError("A key is not 32 bytes");
  noise::Key out;
  std::memcpy(out.data(), bytes.data(), out.size());
  return out;
}

std::string runVector(const NoiseVector& vector) {
  const noise::Pattern pattern = vector.psk ? noise::Pattern::XXpsk2 : noise::Pattern::XX;
  const noise::Key initStatic = key(vector.initStatic), initEphemeral = key(vector.initEphemeral);
  const noise::Key respStatic = key(vector.respStatic), respEphemeral = key(vector.respEphemeral);
  noise::KeyPair is = noise::keyPairFromPrivateKey(initStatic.data());
  noise::KeyPair ie = noise::keyPairFromPrivateKey(initEphemeral.data());
  noise::KeyPair rs = noise::keyPairFromPrivateKey(respStatic.data());
  noise::KeyPair re = noise::keyPairFromPrivateKey(respEphemeral.data());
  noise::HandshakeOptions initOptions;
  initOptions.pattern = pattern;
  initOptions.initiator = true;
  initOptions.prologue = hex(vector.initPrologue);
  initOptions.staticKeyPair = &is;
  initOptions.ephemeralKeyPair = &ie;
  noise::HandshakeOptions respOptions;
  respOptions.pattern = pattern;
  respOptions.initiator = false;
  respOptions.prologue = hex(vector.respPrologue);
  respOptions.staticKeyPair = &rs;
  respOptions.ephemeralKeyPair = &re;
  if (vector.psk) {
    if (!vector.initPsk || !vector.respPsk) return "missing PSK";
    initOptions.psk = key(*vector.initPsk);
    respOptions.psk = key(*vector.respPsk);
  }
  if (vector.messages.size() < 3) return "fewer than three messages";
  noise::HandshakeState initiator(initOptions);
  noise::HandshakeState responder(respOptions);
  for (size_t i = 0; i < 3; i++) {
    noise::HandshakeState& writer = i % 2 == 0 ? initiator : responder;
    noise::HandshakeState& reader = i % 2 == 0 ? responder : initiator;
    noise::Bytes payload = hex(vector.messages[i].payload);
    noise::Bytes message = writer.writeMessage(payload.data(), payload.size());
    if (toHex(message.data(), message.size()) != vector.messages[i].ciphertext)
      return "handshake message " + std::to_string(i) + " differs";
    if (reader.readMessage(message.data(), message.size()) != payload)
      return "handshake message " + std::to_string(i) + " payload differs";
  }
  if (vector.handshakeHash) {
    const noise::Key hash = initiator.handshakeHash();
    if (toHex(hash.data(), hash.size()) != *vector.handshakeHash || responder.handshakeHash() != hash)
      return "handshake hash differs";
  }
  auto [initSend, initReceive] = initiator.split();
  auto [respSend, respReceive] = responder.split();
  for (size_t i = 3; i < vector.messages.size(); i++) {
    const bool fromInitiator = i % 2 == 0;
    noise::CipherState& sender = fromInitiator ? initSend : respSend;
    noise::CipherState& receiver = fromInitiator ? respReceive : initReceive;
    noise::Bytes payload = hex(vector.messages[i].payload);
    noise::Bytes message = sender.encryptWithAd(nullptr, 0, payload.data(), payload.size());
    if (toHex(message.data(), message.size()) != vector.messages[i].ciphertext)
      return "transport message " + std::to_string(i) + " differs";
    if (receiver.decryptWithAd(nullptr, 0, message.data(), message.size()) != payload)
      return "transport message " + std::to_string(i) + " payload differs";
  }
  return "";
}

std::string runFraming(const FramingVector& vector) {
  const noise::Key k = key(vector.key);
  const uint64_t counter = std::stoull(vector.counter);
  noise::CipherState send(k.data());
  noise::CipherState receive(k.data());
  send.setNonce(counter);
  receive.setNonce(counter);
  noise::Transport transport(std::move(send), std::move(receive), 1 << 24, 1 << 24);
  const noise::Bytes data = hex(vector.data);
  const noise::MessageType type = vector.text ? noise::MessageType::Text : noise::MessageType::Binary;
  noise::Bytes message = transport.encrypt(type, data.data(), data.size());
  if (toHex(message.data(), message.size()) != vector.ciphertext) return "ciphertext differs";
  noise::Bytes plaintext;
  if (transport.decrypt(message.data(), message.size(), plaintext) != type) return "type differs";
  if (noise::Bytes(plaintext.begin() + 1, plaintext.end()) != data) return "plaintext differs";
  return "";
}

} // namespace

std::vector<std::string> HybridNoiseCheck::runVectors(const std::vector<NoiseVector>& vectors,
                                                      const std::vector<FramingVector>& framing) {
  std::vector<std::string> failures;
  for (const auto& vector : vectors) {
    std::string failure;
    try {
      failure = runVector(vector);
    } catch (const std::exception& error) {
      failure = error.what();
    }
    if (!failure.empty()) failures.push_back(vector.name + ": " + failure);
  }
  for (const auto& vector : framing) {
    std::string failure;
    try {
      failure = runFraming(vector);
    } catch (const std::exception& error) {
      failure = error.what();
    }
    if (!failure.empty()) failures.push_back("framing at counter " + vector.counter + ": " + failure);
  }
  return failures;
}

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
