#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace stim::noise {

using Bytes = std::vector<uint8_t>;
using Key = std::array<uint8_t, 32>;

constexpr size_t kKeyBytes = 32;
constexpr size_t kTagBytes = 16;
/** Largest handshake message either side writes or reads, payload included. */
constexpr size_t kMaxHandshakeMessageBytes = 1024;

/** Any handshake or transport failure; the handshake or transport is unusable afterwards. */
class NoiseError : public std::runtime_error {
public:
  using std::runtime_error::runtime_error;
};

/** Initializes libsodium once; every other function here calls it. */
void ensureSodium();

struct KeyPair {
  Key publicKey{};
  Key privateKey{};
  ~KeyPair();
};

KeyPair generateKeyPair();
KeyPair keyPairFromPrivateKey(const uint8_t* privateKey);

Key sha256(const uint8_t* data, size_t length);

/** Noise's CipherState: a key and a 64-bit counter used as the nonce. */
class CipherState {
public:
  CipherState() = default;
  explicit CipherState(const uint8_t* key);
  CipherState(CipherState&& other) noexcept;
  CipherState& operator=(CipherState&& other) noexcept;
  CipherState(const CipherState&) = delete;
  CipherState& operator=(const CipherState&) = delete;
  ~CipherState();

  bool hasKey() const { return _hasKey; }
  void setNonce(uint64_t n) { _n = n; }
  Bytes encryptWithAd(const uint8_t* ad, size_t adLength, const uint8_t* plaintext, size_t length);
  Bytes decryptWithAd(const uint8_t* ad, size_t adLength, const uint8_t* ciphertext, size_t length);
  /**
   * Decrypts into `out`, which must hold `length - kTagBytes` bytes and may be `ciphertext` itself, and returns false
   * if authentication fails.
   */
  bool decryptInto(const uint8_t* ciphertext, size_t length, uint8_t* out);

private:
  Key _k{};
  uint64_t _n = 0;
  bool _hasKey = false;
};

enum class Pattern { XX, XXpsk2 };

struct HandshakeOptions {
  Pattern pattern = Pattern::XX;
  bool initiator = true;
  Bytes prologue;
  const KeyPair* staticKeyPair = nullptr;
  /** 32 bytes, required for XXpsk2 and refused for XX. */
  std::optional<Key> psk;
  /** Fixed ephemeral key, only for reproducing published test vectors. */
  const KeyPair* ephemeralKeyPair = nullptr;
};

/**
 * Noise's HandshakeState for Noise_XX_25519_ChaChaPoly_SHA256 and Noise_XXpsk2_25519_ChaChaPoly_SHA256. The
 * initiator writes messages 1 and 3. Any error, including an out-of-turn call, ends the handshake: every later call
 * throws NoiseError.
 */
class HandshakeState {
public:
  explicit HandshakeState(const HandshakeOptions& options);
  ~HandshakeState();
  HandshakeState(const HandshakeState&) = delete;
  HandshakeState& operator=(const HandshakeState&) = delete;

  bool isComplete() const { return _index == 3; }
  /** The peer's static public key, once the message that carries it has been read and authenticated. */
  std::optional<Key> remoteStaticPublicKey() const;
  Key handshakeHash() const;

  Bytes writeMessage(const uint8_t* payload = nullptr, size_t length = 0);
  Bytes readMessage(const uint8_t* message, size_t length);

  /** Noise's Split(): this side's sending and receiving cipher states. It can be called once. */
  std::pair<CipherState, CipherState> split();

private:
  enum class Token { E, S, EE, ES, SE, PSK };
  const std::vector<Token>& tokens() const;
  template <typename Run> Bytes step(bool writing, Run&& run);
  void mixHash(const uint8_t* data, size_t length);
  void mixKey(const uint8_t* input, size_t length);
  void mixKeyAndHash(const uint8_t* input, size_t length);
  Bytes encryptAndHash(const uint8_t* plaintext, size_t length);
  Bytes decryptAndHash(const uint8_t* ciphertext, size_t length);
  void mixEphemeral(const Key& publicKey);
  void mixToken(Token token);
  void dh(const Key& privateKey, const Key& publicKey);

  Pattern _pattern;
  bool _initiator;
  Key _ck{};
  Key _h{};
  CipherState _cipher;
  KeyPair _s;
  std::optional<KeyPair> _e;
  std::optional<Key> _re;
  std::optional<Key> _rs;
  std::optional<Key> _psk;
  int _index = 0;
  bool _failed = false;
  bool _split = false;
};

enum class MessageType : uint8_t { Text = 0x01, Binary = 0x02 };

/**
 * Stim's transport framing after the handshake: each WebSocket message is one ChaCha20-Poly1305 message with empty
 * associated data under the next counter value, and the first plaintext byte is the message type. Counters are not
 * sent, so a reordered, replayed, dropped or altered message fails to decrypt. A failure closes the transport.
 */
class Transport {
public:
  Transport(CipherState send, CipherState receive, size_t maxSendBytes, size_t maxReceiveBytes);

  bool closed() const { return _closed; }
  /** Encrypts one message. A body over maxSendBytes throws std::length_error and consumes no counter. */
  Bytes encrypt(MessageType type, const uint8_t* body, size_t length);
  /**
   * Decrypts one message in place: its first `length - kTagBytes` bytes become the plaintext, whose first byte is the
   * type, and returns the type. Throws NoiseError and closes the transport on any failure; a message of the wrong
   * length is rejected before anything is written.
   */
  MessageType decrypt(uint8_t* message, size_t length);

private:
  CipherState _send;
  CipherState _receive;
  size_t _maxSend;
  size_t _maxReceive;
  bool _closed = false;
};

} // namespace stim::noise

namespace stim::protocol {

/** The protocol version byte of the cleartext prefix. */
constexpr uint8_t kVersion = 2;
constexpr uint8_t kModeReturning = 0;
constexpr uint8_t kModeFirstContact = 1;
constexpr size_t kLookupBytes = 16;
/** Plaintext limits, without the type byte: the server accepts 64 KiB from clients and sends up to 16 MiB. */
constexpr size_t kMaxSendBytes = 64 * 1024;
constexpr size_t kMaxReceiveBytes = 16 * 1024 * 1024;

/** psk = SHA-256("stim noise psk v1" || secret) */
noise::Key derivePsk(const noise::Bytes& secret);
/** lookup = SHA-256("stim noise lookup v1" || secret)[0..16] */
std::array<uint8_t, kLookupBytes> deriveLookup(const noise::Bytes& secret);
/** The cleartext prefix: version, mode, and in first-contact mode the lookup. */
noise::Bytes prefix(const std::optional<noise::Bytes>& secret);
/** "stim noise v1" || prefix */
noise::Bytes prologue(const noise::Bytes& prefix);

std::optional<noise::Bytes> base64UrlDecode(const std::string& text);
std::string base64UrlEncode(const uint8_t* data, size_t length);

} // namespace stim::protocol
