#include "HybridStimSession.hpp"

#include "ClientKey.hpp"
#include "HybridHybridWebSocketSpec.hpp"
#include "VideoPush.hpp"

#include <NitroModules/ArrayBuffer.hpp>
#include <NitroModules/HybridObjectRegistry.hpp>
#include <sodium.h>

#include <chrono>
#include <cstring>
#include <stdexcept>

namespace margelo::nitro::stimsession {

using nitrofetchwebsockets::HybridHybridWebSocketSpec;
using nitrofetchwebsockets::HybridWebSocketMessageEvent;
using nitrofetchwebsockets::WebSocketCloseEvent;
namespace noise = stim::noise;
namespace protocol = stim::protocol;

namespace {

constexpr uint8_t kVideoHeaderVersion = 1;
constexpr size_t kVideoFixedHeaderBytes = 21;
// RFC 6455 section 7.4.1: 1002 is a protocol error, 1006 is reserved for a connection that closed without a close
// frame and is never sent.
constexpr int kCloseProtocolError = 1002;
constexpr int kCloseAbnormal = 1006;
constexpr size_t kMaxPendingBytes = 4 * 1024 * 1024;
constexpr size_t kMaxPendingSubscriptions = 8;
constexpr auto kPendingLifetime = std::chrono::seconds(5);

bool validUtf8(const uint8_t* s, size_t n) {
  size_t i = 0;
  while (i < n) {
    const uint8_t c = s[i];
    size_t extra;
    uint32_t min;
    uint32_t cp;
    if (c < 0x80) {
      i++;
      continue;
    } else if ((c & 0xE0) == 0xC0) {
      extra = 1, min = 0x80, cp = c & 0x1F;
    } else if ((c & 0xF0) == 0xE0) {
      extra = 2, min = 0x800, cp = c & 0x0F;
    } else if ((c & 0xF8) == 0xF0) {
      extra = 3, min = 0x10000, cp = c & 0x07;
    } else {
      return false;
    }
    if (n - i <= extra) return false;
    for (size_t j = 1; j <= extra; j++) {
      if ((s[i + j] & 0xC0) != 0x80) return false;
      cp = (cp << 6) | (s[i + j] & 0x3F);
    }
    if (cp < min || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return false;
    i += extra + 1;
  }
  return true;
}

std::optional<noise::Key> decodeKey(const std::string& text) {
  auto bytes = protocol::base64UrlDecode(text);
  if (!bytes || bytes->size() != noise::kKeyBytes) return std::nullopt;
  noise::Key key;
  std::memcpy(key.data(), bytes->data(), key.size());
  return key;
}

/** `{"name": <name>}`, as stim-server reads message 3's payload on first contact. */
noise::Bytes namePayload(const std::string& name) {
  std::string json = "{\"name\":\"";
  for (const unsigned char c : name) {
    if (c == '"' || c == '\\') {
      json += '\\';
      json += static_cast<char>(c);
    } else if (c < 0x20) {
      static const char* digits = "0123456789abcdef";
      json += "\\u00";
      json += digits[c >> 4];
      json += digits[c & 0xF];
    } else {
      json += static_cast<char>(c);
    }
  }
  json += "\"}";
  return noise::Bytes(json.begin(), json.end());
}

std::mutex clientKeyMutex;
std::optional<noise::KeyPair> clientKey;

/** The client key pair, read from secure storage once per process and created there the first time. */
const noise::KeyPair& loadClientKey() {
  std::lock_guard<std::mutex> lock(clientKeyMutex);
  if (clientKey) return *clientKey;
  std::optional<noise::Key> stored;
  try {
    stim::platform::withJvm([&] {
      stored = stim::platform::loadClientPrivateKey();
      if (!stored) {
        noise::KeyPair created = noise::generateKeyPair();
        stim::platform::storeClientPrivateKey(created.privateKey);
        stored = created.privateKey;
      }
    });
  } catch (const std::exception& error) {
    throw std::runtime_error(std::string("client-key-unavailable: ") + error.what());
  }
  clientKey.emplace(noise::keyPairFromPrivateKey(stored->data()));
  sodium_memzero(stored->data(), stored->size());
  return *clientKey;
}

} // namespace

HybridStimSession::~HybridStimSession() {
  std::unique_lock<std::mutex> lock(_state->mutex);
  _state->stage = State::Stage::Closed;
  _state->onOpen.reset();
  _state->onMessage.reset();
  _state->onClose.reset();
  auto socket = _state->socket;
  _state->detachSocket();
  lock.unlock();
  if (socket) socket->close(1000, "");
}

std::optional<std::function<void(const std::string&)>> HybridStimSession::getOnOpen() {
  std::lock_guard<std::mutex> lock(_state->mutex);
  return _state->onOpen;
}
void HybridStimSession::setOnOpen(const std::optional<std::function<void(const std::string&)>>& onOpen) {
  std::lock_guard<std::mutex> lock(_state->mutex);
  _state->onOpen = onOpen;
}
std::optional<std::function<void(const std::string&)>> HybridStimSession::getOnMessage() {
  std::lock_guard<std::mutex> lock(_state->mutex);
  return _state->onMessage;
}
void HybridStimSession::setOnMessage(const std::optional<std::function<void(const std::string&)>>& onMessage) {
  std::lock_guard<std::mutex> lock(_state->mutex);
  _state->onMessage = onMessage;
}
std::optional<std::function<void(const SessionClose&)>> HybridStimSession::getOnClose() {
  std::lock_guard<std::mutex> lock(_state->mutex);
  return _state->onClose;
}
void HybridStimSession::setOnClose(const std::optional<std::function<void(const SessionClose&)>>& onClose) {
  std::lock_guard<std::mutex> lock(_state->mutex);
  _state->onClose = onClose;
}

void HybridStimSession::connect(const std::shared_ptr<HybridObject>& socketObject, const std::string& url,
                                const SessionOptions& options) {
  auto socket = std::dynamic_pointer_cast<HybridHybridWebSocketSpec>(socketObject);
  if (!socket) throw std::invalid_argument("connect() needs a HybridWebSocket from react-native-nitro-websockets");

  std::optional<noise::Bytes> secret;
  if (options.pairingToken) {
    secret = protocol::base64UrlDecode(*options.pairingToken);
    if (!secret || secret->size() != 32) throw std::invalid_argument("The pairing token is not 32 base64url bytes");
  }
  std::optional<noise::Key> serverKey;
  if (options.serverKey) {
    serverKey = decodeKey(*options.serverKey);
    if (!serverKey) throw std::invalid_argument("The server key is not 32 base64url bytes");
  }
  if (!secret && !serverKey) throw std::invalid_argument("connect() needs a pairing token or the pinned server key");
  std::optional<noise::Key> fingerprint;
  if (options.fingerprint) {
    fingerprint = decodeKey(*options.fingerprint);
    if (!fingerprint) throw std::invalid_argument("The server key fingerprint is not 32 base64url bytes");
  }
  if (options.name && !validUtf8(reinterpret_cast<const uint8_t*>(options.name->data()), options.name->size()))
    throw std::invalid_argument("The device name is not UTF-8");

  const noise::KeyPair& key = loadClientKey();
  noise::HandshakeOptions handshake;
  // The HandshakeState keeps its own copy; this one and the secret are wiped however connect() returns.
  struct Wipe {
    noise::HandshakeOptions& options;
    std::optional<noise::Bytes>& secret;
    ~Wipe() {
      if (options.psk) sodium_memzero(options.psk->data(), options.psk->size());
      if (secret) sodium_memzero(secret->data(), secret->size());
    }
  } wipe{handshake, secret};
  handshake.pattern = secret ? noise::Pattern::XXpsk2 : noise::Pattern::XX;
  handshake.initiator = true;
  noise::Bytes prefix = protocol::prefix(secret);
  handshake.prologue = protocol::prologue(prefix);
  handshake.staticKeyPair = &key;
  if (secret) handshake.psk = protocol::derivePsk(*secret);

  {
    std::lock_guard<std::mutex> lock(_state->mutex);
    if (_state->stage != State::Stage::Idle) throw std::logic_error("connect() was already called");
    _state->stage = State::Stage::Connecting;
    _state->socket = socket;
    _state->handshake = std::make_unique<noise::HandshakeState>(handshake);
    _state->prefix = std::move(prefix);
    _state->expectedServerKey = serverKey;
    _state->expectedFingerprint = fingerprint;
    _state->thirdPayload = secret ? namePayload(options.name.value_or("")) : noise::Bytes();
  }

  std::weak_ptr<State> weak = _state;
  socket->setOnOpen([weak]() {
    if (auto state = weak.lock()) state->opened();
  });
  socket->setOnMessage([weak](const HybridWebSocketMessageEvent& event) {
    auto state = weak.lock();
    if (!state || !event.data) return;
    state->received(event.data, event.isBinary);
  });
  socket->setOnClose([weak](const WebSocketCloseEvent& event) {
    if (auto state = weak.lock()) state->closed(static_cast<int>(event.code), event.reason);
  });
  // react-native-nitro-websockets 1.3.1 on iOS can end a socket with an error and no close event.
  socket->setOnError([weak](const std::string& message) {
    if (auto state = weak.lock()) state->closed(kCloseAbnormal, message);
  });
  socket->connect(url, {}, {});
}

void HybridStimSession::send(const std::string& text) {
  std::lock_guard<std::mutex> lock(_state->mutex);
  if (_state->stage != State::Stage::Open || !_state->transport) throw std::runtime_error("The session is not open");
  noise::Bytes message = _state->transport->encrypt(noise::MessageType::Text,
                                                    reinterpret_cast<const uint8_t*>(text.data()), text.size());
  _state->socket->sendBinary(ArrayBuffer::move(std::move(message)));
}

void HybridStimSession::close() {
  std::unique_lock<std::mutex> lock(_state->mutex);
  if (_state->stage == State::Stage::Closed) return;
  _state->stage = State::Stage::Closed;
  auto socket = _state->socket;
  _state->detachSocket();
  _state->handshake.reset();
  _state->transport.reset();
  _state->streams.clear();
  _state->pending.clear();
  auto onClose = _state->onClose;
  _state->onOpen.reset();
  _state->onMessage.reset();
  _state->onClose.reset();
  const bool answered = _state->serverAnswered;
  lock.unlock();
  if (socket) socket->close(1000, "");
  if (onClose) (*onClose)(SessionClose(1000, "", answered, false, std::nullopt));
}

std::shared_ptr<HybridVideoStreamSpec> HybridStimSession::createVideoStream() {
  auto object = HybridObjectRegistry::createHybridObject("VideoStream");
  auto stream = std::dynamic_pointer_cast<HybridVideoStreamSpec>(object);
  if (!stream) throw std::runtime_error("VideoStream is not registered");
  return stream;
}

std::shared_ptr<HybridVideoStreamSpec> HybridStimSession::videoStream(const std::string& subscription) {
  auto stream = createVideoStream();
  std::lock_guard<std::mutex> lock(_state->mutex);
  _state->streams[subscription] = stream;
  auto waiting = _state->pending.find(subscription);
  if (waiting != _state->pending.end()) {
    auto packets = std::move(waiting->second.packets);
    _state->pending.erase(waiting);
    // Replayed under the lock, so a message the socket delivers meanwhile reaches the stream after these.
    for (const auto& packet : packets) stim::platform::pushVideo(stream, packet);
  }
  return stream;
}

std::string HybridStimSession::clientPublicKey() {
  const noise::KeyPair& key = loadClientKey();
  return protocol::base64UrlEncode(key.publicKey.data(), key.publicKey.size());
}

SessionTiming HybridStimSession::timing() {
#ifdef STIM_TIMING
  std::lock_guard<std::mutex> lock(_state->timingMutex);
  const auto& t = _state->timings;
  const double video = t.videoMessages - t.dropped;
  return SessionTiming(true, t.messages, t.videoMessages, t.dropped, t.messages ? t.decryptSum / t.messages : 0,
                       t.decryptMax, video > 0 ? t.routeSum / video : 0, t.routeMax);
#else
  return SessionTiming(false, 0, 0, 0, 0, 0, 0, 0);
#endif
}

std::string HybridStimSession::videoSubscription(const uint8_t* packet, size_t length) {
  if (length < kVideoFixedHeaderBytes || packet[0] != kVideoHeaderVersion) return {};
  const size_t idLength = packet[20];
  const size_t headerLength = (static_cast<size_t>(packet[2]) << 8) | packet[3];
  if (headerLength < kVideoFixedHeaderBytes + idLength || headerLength > length) return {};
  return std::string(reinterpret_cast<const char*>(packet + kVideoFixedHeaderBytes), idLength);
}

void HybridStimSession::State::detachSocket() {
  if (!socket) return;
  socket->setOnOpen(std::nullopt);
  socket->setOnMessage(std::nullopt);
  socket->setOnClose(std::nullopt);
  socket->setOnError(std::nullopt);
  socket.reset();
}

void HybridStimSession::State::opened() {
  std::unique_lock<std::mutex> lock(mutex);
  if (stage != Stage::Connecting || !handshake) return;
  noise::Bytes first = prefix;
  try {
    noise::Bytes message = handshake->writeMessage();
    first.insert(first.end(), message.begin(), message.end());
  } catch (const std::exception& error) {
    return fail(lock, error.what());
  }
  stage = Stage::Handshaking;
  socket->sendBinary(ArrayBuffer::move(std::move(first)));
}

void HybridStimSession::State::received(const std::shared_ptr<ArrayBuffer>& message, bool isBinary) {
  uint8_t* data = message->data();
  const size_t length = message->size();
  std::unique_lock<std::mutex> lock(mutex);
  if (stage == Stage::Handshaking) {
    serverAnswered = true;
    if (!isBinary) return fail(lock, "The server answered the handshake with a text message");
    std::string serverKey;
    try {
      if (!handshake->readMessage(data, length).empty()) return fail(lock, "handshake-failed");
      auto remote = handshake->remoteStaticPublicKey();
      if (!remote) return fail(lock, "The server sent no static key");
      if (expectedServerKey && *remote != *expectedServerKey) return fail(lock, "server-key-mismatch");
      if (expectedFingerprint && noise::sha256(remote->data(), remote->size()) != *expectedFingerprint)
        return fail(lock, "server-key-mismatch");
      noise::Bytes third = handshake->writeMessage(thirdPayload.data(), thirdPayload.size());
      auto [sendCipher, receiveCipher] = handshake->split();
      transport = std::make_unique<noise::Transport>(std::move(sendCipher), std::move(receiveCipher),
                                                     protocol::kMaxSendBytes, protocol::kMaxReceiveBytes);
      handshake.reset();
      serverKey = protocol::base64UrlEncode(remote->data(), remote->size());
      stage = Stage::Open;
      socket->sendBinary(ArrayBuffer::move(std::move(third)));
    } catch (const std::exception& error) {
      return fail(lock, error.what());
    }
    auto callback = onOpen;
    lock.unlock();
    if (callback) (*callback)(serverKey);
    return;
  }
  if (stage != Stage::Open || !transport) return;
  if (!isBinary) return fail(lock, "The server sent a text message after the handshake");
#ifdef STIM_TIMING
  const auto arrived = std::chrono::steady_clock::now();
  const auto since = [arrived] {
    return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - arrived).count();
  };
#endif
  noise::MessageType type;
  try {
    type = transport->decrypt(data, length);
  } catch (const std::exception& error) {
    return fail(lock, error.what());
  }
#ifdef STIM_TIMING
  {
    const double decrypted = since();
    std::lock_guard<std::mutex> timingLock(timingMutex);
    timings.messages++;
    if (type == noise::MessageType::Binary) timings.videoMessages++;
    timings.decryptSum += decrypted;
    timings.decryptMax = std::max(timings.decryptMax, decrypted);
  }
#endif
  const uint8_t* body = data + 1;
  const size_t bodyLength = length - noise::kTagBytes - 1;
  if (type == noise::MessageType::Text) {
    if (!validUtf8(body, bodyLength)) return fail(lock, "The server sent a text message that is not UTF-8");
    auto callback = onMessage;
    lock.unlock();
    if (callback) (*callback)(std::string(reinterpret_cast<const char*>(body), bodyLength));
    return;
  }
  const std::string subscription = videoSubscription(body, bodyLength);
  auto found = subscription.empty() ? streams.end() : streams.find(subscription);
  auto stream = found == streams.end() ? nullptr : found->second.lock();
  auto packet = ArrayBuffer::wrap(data + 1, bodyLength, [message]() {});
  if (!stream) {
    if (found != streams.end()) streams.erase(found);
    else if (!subscription.empty() && keep(subscription, packet)) return;
#ifdef STIM_TIMING
    std::lock_guard<std::mutex> timingLock(timingMutex);
    timings.dropped++;
#endif
    return;
  }
  lock.unlock();
  try {
    stim::platform::pushVideo(stream, packet);
  } catch (const std::exception&) {
    // The message is dropped; the view asks for a keyframe when it misses one.
  }
#ifdef STIM_TIMING
  const double routed = since();
  std::lock_guard<std::mutex> timingLock(timingMutex);
  timings.routeSum += routed;
  timings.routeMax = std::max(timings.routeMax, routed);
#endif
}

bool HybridStimSession::State::keep(const std::string& subscription, const std::shared_ptr<ArrayBuffer>& packet) {
  const auto now = std::chrono::steady_clock::now();
  for (auto it = pending.begin(); it != pending.end();) {
    it = now - it->second.since > kPendingLifetime ? pending.erase(it) : std::next(it);
  }
  const bool keyframe = packet->size() > 1 && (packet->data()[1] & 1) != 0;
  auto found = pending.find(subscription);
  if (found == pending.end()) {
    if (!keyframe || pending.size() >= kMaxPendingSubscriptions) return false;
    found = pending.emplace(subscription, Pending{{}, 0, now}).first;
  }
  Pending& entry = found->second;
  if (keyframe) {
    entry.packets.clear();
    entry.bytes = 0;
  }
  if (entry.bytes + packet->size() > kMaxPendingBytes) return false;
  entry.packets.push_back(packet);
  entry.bytes += packet->size();
  return true;
}

void HybridStimSession::State::closed(int code, const std::string& reason) {
  std::unique_lock<std::mutex> lock(mutex);
  if (stage == Stage::Closed) return;
  const bool complete = stage == Stage::Open;
  stage = Stage::Closed;
  detachSocket();
  handshake.reset();
  transport.reset();
  streams.clear();
  pending.clear();
  auto callback = onClose;
  onOpen.reset();
  onMessage.reset();
  onClose.reset();
  const bool answered = serverAnswered;
  lock.unlock();
  if (callback) (*callback)(SessionClose(code, reason, answered, complete, std::nullopt));
}

void HybridStimSession::State::fail(std::unique_lock<std::mutex>& lock, const std::string& error) {
  const bool complete = stage == Stage::Open;
  stage = Stage::Closed;
  auto closing = socket;
  detachSocket();
  handshake.reset();
  transport.reset();
  streams.clear();
  pending.clear();
  auto callback = onClose;
  onOpen.reset();
  onMessage.reset();
  onClose.reset();
  const bool answered = serverAnswered;
  lock.unlock();
  if (closing) closing->close(kCloseProtocolError, "");
  if (callback) (*callback)(SessionClose(kCloseAbnormal, "", answered, complete, error));
}

} // namespace margelo::nitro::stimsession
