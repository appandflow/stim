#pragma once

#include "HybridStimSessionSpec.hpp"
#include "HybridVideoStreamSpec.hpp"
#include "Noise.hpp"

#include <NitroModules/ArrayBuffer.hpp>

#include <chrono>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

namespace margelo::nitro::nitrofetchwebsockets {
class HybridHybridWebSocketSpec;
}

namespace margelo::nitro::stimsession {

class HybridStimSession : public HybridStimSessionSpec {
public:
  HybridStimSession() : HybridObject(TAG) {}
  ~HybridStimSession() override;

  std::optional<std::function<void(const std::string&)>> getOnOpen() override;
  void setOnOpen(const std::optional<std::function<void(const std::string&)>>& onOpen) override;
  std::optional<std::function<void(const std::string&)>> getOnMessage() override;
  void setOnMessage(const std::optional<std::function<void(const std::string&)>>& onMessage) override;
  std::optional<std::function<void(const SessionClose&)>> getOnClose() override;
  void setOnClose(const std::optional<std::function<void(const SessionClose&)>>& onClose) override;

  void connect(const std::shared_ptr<HybridObject>& socket, const std::string& url,
               const SessionOptions& options) override;
  void send(const std::string& text) override;
  void close() override;
  std::shared_ptr<HybridVideoStreamSpec> videoStream(const std::string& subscription) override;
  SessionTiming timing() override;
  std::string clientPublicKey() override;

  /** Creates the VideoStream HybridObject the session feeds, in the platform's language. */
  static std::shared_ptr<HybridVideoStreamSpec> createVideoStream();
  /** The subscription id of a stim-server video message, or empty when the message is not one. */
  static std::string videoSubscription(const uint8_t* packet, size_t length);

  struct State;

private:
  std::shared_ptr<State> _state = std::make_shared<State>();
};

struct HybridStimSession::State {
  enum class Stage { Idle, Connecting, Handshaking, Open, Closed };

  std::mutex mutex;
  Stage stage = Stage::Idle;
  std::shared_ptr<nitrofetchwebsockets::HybridHybridWebSocketSpec> socket;
  std::unique_ptr<stim::noise::HandshakeState> handshake;
  std::unique_ptr<stim::noise::Transport> transport;
  stim::noise::Bytes prefix;
  std::optional<stim::noise::Key> expectedServerKey;
  std::optional<stim::noise::Key> expectedFingerprint;
  /** Message 3's payload: `{"name": ...}` on first contact, empty when returning. */
  stim::noise::Bytes thirdPayload;
  bool serverAnswered = false;
  std::optional<std::function<void(const std::string&)>> onOpen;
  std::optional<std::function<void(const std::string&)>> onMessage;
  std::optional<std::function<void(const SessionClose&)>> onClose;
  std::unordered_map<std::string, std::weak_ptr<HybridVideoStreamSpec>> streams;
  /**
   * Video messages of subscriptions JavaScript has not asked a stream for yet, from their last keyframe: the server
   * sends a keyframe right after the subscribe result, before JavaScript reads it.
   */
  struct Pending {
    std::vector<std::shared_ptr<ArrayBuffer>> packets;
    size_t bytes = 0;
    std::chrono::steady_clock::time_point since;
  };
  std::unordered_map<std::string, Pending> pending;

#ifdef STIM_TIMING
  struct Timing {
    double messages = 0, videoMessages = 0, dropped = 0;
    double decryptSum = 0, decryptMax = 0, routeSum = 0, routeMax = 0;
  };
  std::mutex timingMutex;
  Timing timings;
#endif

  void opened();
  void received(const uint8_t* data, size_t length, bool isBinary);
  void closed(int code, const std::string& reason);
  bool keep(const std::string& subscription, const std::shared_ptr<ArrayBuffer>& packet);
  void fail(std::unique_lock<std::mutex>& lock, const std::string& error);
  void detachSocket();
};

} // namespace margelo::nitro::stimsession
