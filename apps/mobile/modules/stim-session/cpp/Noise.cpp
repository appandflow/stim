#include "Noise.hpp"

#include <sodium.h>

#include <cstring>
#include <mutex>

namespace stim::noise {

namespace {

constexpr const char* kXX = "Noise_XX_25519_ChaChaPoly_SHA256";
constexpr const char* kXXpsk2 = "Noise_XXpsk2_25519_ChaChaPoly_SHA256";
// Noise revision 34, section 5.1: nonce 2^64-1 is reserved and must never encrypt a message.
constexpr uint64_t kMaxNonce = UINT64_MAX;

// Noise revision 34, section 12.3: the ChaChaPoly nonce is 32 zero bits then the 64-bit counter, little-endian.
void nonceBytes(uint64_t n, uint8_t out[12]) {
  std::memset(out, 0, 4);
  for (int i = 0; i < 8; i++) out[4 + i] = static_cast<uint8_t>(n >> (8 * i));
}

Key hmac(const uint8_t* key, size_t keyLength, const uint8_t* a, size_t aLength, const uint8_t* b = nullptr,
         size_t bLength = 0) {
  crypto_auth_hmacsha256_state state;
  crypto_auth_hmacsha256_init(&state, key, keyLength);
  crypto_auth_hmacsha256_update(&state, a, aLength);
  if (bLength > 0) crypto_auth_hmacsha256_update(&state, b, bLength);
  Key out;
  crypto_auth_hmacsha256_final(&state, out.data());
  sodium_memzero(&state, sizeof state);
  return out;
}

// Noise revision 34, section 4.3: HKDF as chained HMACs, not RFC 5869's salt and info.
void hkdf(const Key& chainingKey, const uint8_t* input, size_t length, Key& first, Key& second, Key* third) {
  Key temp = hmac(chainingKey.data(), chainingKey.size(), input, length);
  const uint8_t one = 1, two = 2, three = 3;
  first = hmac(temp.data(), temp.size(), &one, 1);
  second = hmac(temp.data(), temp.size(), first.data(), first.size(), &two, 1);
  if (third) *third = hmac(temp.data(), temp.size(), second.data(), second.size(), &three, 1);
  sodium_memzero(temp.data(), temp.size());
}

} // namespace

void ensureSodium() {
  static std::once_flag once;
  std::call_once(once, [] {
    if (sodium_init() < 0) throw NoiseError("libsodium failed to initialize");
  });
}

KeyPair::~KeyPair() {
  sodium_memzero(privateKey.data(), privateKey.size());
}

KeyPair generateKeyPair() {
  ensureSodium();
  KeyPair pair;
  randombytes_buf(pair.privateKey.data(), pair.privateKey.size());
  crypto_scalarmult_curve25519_base(pair.publicKey.data(), pair.privateKey.data());
  return pair;
}

KeyPair keyPairFromPrivateKey(const uint8_t* privateKey) {
  ensureSodium();
  KeyPair pair;
  std::memcpy(pair.privateKey.data(), privateKey, kKeyBytes);
  crypto_scalarmult_curve25519_base(pair.publicKey.data(), pair.privateKey.data());
  return pair;
}

Key sha256(const uint8_t* data, size_t length) {
  ensureSodium();
  Key out;
  crypto_hash_sha256(out.data(), data, length);
  return out;
}

CipherState::CipherState(const uint8_t* key) : _hasKey(true) {
  std::memcpy(_k.data(), key, kKeyBytes);
}

CipherState::CipherState(CipherState&& other) noexcept : _k(other._k), _n(other._n), _hasKey(other._hasKey) {
  sodium_memzero(other._k.data(), other._k.size());
  other._hasKey = false;
}

CipherState& CipherState::operator=(CipherState&& other) noexcept {
  if (this != &other) {
    _k = other._k;
    _n = other._n;
    _hasKey = other._hasKey;
    sodium_memzero(other._k.data(), other._k.size());
    other._hasKey = false;
  }
  return *this;
}

CipherState::~CipherState() {
  sodium_memzero(_k.data(), _k.size());
}

Bytes CipherState::encryptWithAd(const uint8_t* ad, size_t adLength, const uint8_t* plaintext, size_t length) {
  if (!_hasKey) return Bytes(plaintext, plaintext + length);
  if (_n >= kMaxNonce) throw NoiseError("Nonce exhausted");
  uint8_t nonce[12];
  nonceBytes(_n, nonce);
  Bytes out(length + kTagBytes);
  unsigned long long written = 0;
  crypto_aead_chacha20poly1305_ietf_encrypt(out.data(), &written, plaintext, length, ad, adLength, nullptr, nonce,
                                            _k.data());
  _n++;
  return out;
}

Bytes CipherState::decryptWithAd(const uint8_t* ad, size_t adLength, const uint8_t* ciphertext, size_t length) {
  if (!_hasKey) return Bytes(ciphertext, ciphertext + length);
  if (_n >= kMaxNonce) throw NoiseError("Nonce exhausted");
  if (length < kTagBytes) throw NoiseError("Message is shorter than its authentication tag");
  uint8_t nonce[12];
  nonceBytes(_n, nonce);
  Bytes out(length - kTagBytes);
  unsigned long long written = 0;
  if (crypto_aead_chacha20poly1305_ietf_decrypt(out.data(), &written, nullptr, ciphertext, length, ad, adLength,
                                                nonce, _k.data()) != 0) {
    throw NoiseError("Message failed authentication");
  }
  _n++;
  return out;
}

bool CipherState::decryptInto(const uint8_t* ciphertext, size_t length, uint8_t* out) {
  if (!_hasKey || _n >= kMaxNonce || length < kTagBytes) return false;
  uint8_t nonce[12];
  nonceBytes(_n, nonce);
  unsigned long long written = 0;
  if (crypto_aead_chacha20poly1305_ietf_decrypt(out, &written, nullptr, ciphertext, length, nullptr, 0, nonce,
                                                _k.data()) != 0) {
    return false;
  }
  _n++;
  return true;
}

HandshakeState::HandshakeState(const HandshakeOptions& options)
    : _pattern(options.pattern), _initiator(options.initiator) {
  ensureSodium();
  const bool usesPsk = options.pattern == Pattern::XXpsk2;
  if (usesPsk != options.psk.has_value()) throw NoiseError("PSK mismatch for this pattern");
  if (!options.staticKeyPair) throw NoiseError("A static key pair is required");
  const char* name = usesPsk ? kXXpsk2 : kXX;
  const size_t nameLength = std::strlen(name);
  // Noise revision 34, section 5.2: a name of at most HASHLEN bytes is zero-padded, a longer one hashed.
  if (nameLength <= _h.size()) {
    _h.fill(0);
    std::memcpy(_h.data(), name, nameLength);
  } else {
    _h = sha256(reinterpret_cast<const uint8_t*>(name), nameLength);
  }
  _ck = _h;
  mixHash(options.prologue.data(), options.prologue.size());
  _s.publicKey = options.staticKeyPair->publicKey;
  _s.privateKey = options.staticKeyPair->privateKey;
  _psk = options.psk;
  if (options.ephemeralKeyPair) {
    _e.emplace();
    _e->publicKey = options.ephemeralKeyPair->publicKey;
    _e->privateKey = options.ephemeralKeyPair->privateKey;
  }
}

HandshakeState::~HandshakeState() {
  sodium_memzero(_ck.data(), _ck.size());
  if (_psk) sodium_memzero(_psk->data(), _psk->size());
}

const std::vector<HandshakeState::Token>& HandshakeState::tokens() const {
  static const std::vector<Token> xx[3] = {{Token::E}, {Token::E, Token::EE, Token::S, Token::ES}, {Token::S, Token::SE}};
  static const std::vector<Token> xxpsk2[3] = {
      {Token::E}, {Token::E, Token::EE, Token::S, Token::ES, Token::PSK}, {Token::S, Token::SE}};
  return _pattern == Pattern::XXpsk2 ? xxpsk2[_index] : xx[_index];
}

std::optional<Key> HandshakeState::remoteStaticPublicKey() const {
  if (_failed) return std::nullopt;
  return _rs;
}

Key HandshakeState::handshakeHash() const {
  if (!isComplete()) throw NoiseError("The handshake is not complete");
  return _h;
}

template <typename Run> Bytes HandshakeState::step(bool writing, Run&& run) {
  if (_failed) throw NoiseError("The handshake has failed");
  try {
    if (_index >= 3) throw NoiseError("The handshake is complete");
    if (writing != (_initiator == (_index % 2 == 0)))
      throw NoiseError(writing ? "It is not this side's turn to write" : "It is not this side's turn to read");
    Bytes result = run(tokens());
    _index++;
    return result;
  } catch (const NoiseError&) {
    _failed = true;
    throw;
  } catch (const std::exception& error) {
    _failed = true;
    throw NoiseError(std::string("Handshake failed: ") + error.what());
  }
}

Bytes HandshakeState::writeMessage(const uint8_t* payload, size_t length) {
  return step(true, [&](const std::vector<Token>& tokens) {
    Bytes message;
    for (Token token : tokens) {
      if (token == Token::E) {
        if (!_e) _e.emplace(generateKeyPair());
        message.insert(message.end(), _e->publicKey.begin(), _e->publicKey.end());
        mixEphemeral(_e->publicKey);
      } else if (token == Token::S) {
        Bytes encrypted = encryptAndHash(_s.publicKey.data(), _s.publicKey.size());
        message.insert(message.end(), encrypted.begin(), encrypted.end());
      } else {
        mixToken(token);
      }
    }
    Bytes encrypted = encryptAndHash(payload, length);
    message.insert(message.end(), encrypted.begin(), encrypted.end());
    if (message.size() > kMaxHandshakeMessageBytes) throw NoiseError("Handshake message is too large");
    return message;
  });
}

Bytes HandshakeState::readMessage(const uint8_t* message, size_t length) {
  return step(false, [&](const std::vector<Token>& tokens) {
    if (length > kMaxHandshakeMessageBytes) throw NoiseError("Handshake message is too large");
    size_t offset = 0;
    auto take = [&](size_t count) {
      if (length - offset < count) throw NoiseError("Handshake message is truncated");
      const uint8_t* part = message + offset;
      offset += count;
      return part;
    };
    for (Token token : tokens) {
      if (token == Token::E) {
        Key re;
        std::memcpy(re.data(), take(kKeyBytes), kKeyBytes);
        _re = re;
        mixEphemeral(re);
      } else if (token == Token::S) {
        const size_t count = kKeyBytes + (_cipher.hasKey() ? kTagBytes : 0);
        Bytes rs = decryptAndHash(take(count), count);
        Key key;
        std::memcpy(key.data(), rs.data(), kKeyBytes);
        _rs = key;
      } else {
        mixToken(token);
      }
    }
    return decryptAndHash(message + offset, length - offset);
  });
}

std::pair<CipherState, CipherState> HandshakeState::split() {
  if (_failed || !isComplete()) throw NoiseError("The handshake is not complete");
  if (_split) throw NoiseError("The handshake has already been split");
  _split = true;
  Key first, second;
  hkdf(_ck, nullptr, 0, first, second, nullptr);
  CipherState initiatorToResponder(first.data());
  CipherState responderToInitiator(second.data());
  sodium_memzero(first.data(), first.size());
  sodium_memzero(second.data(), second.size());
  if (_initiator) return {std::move(initiatorToResponder), std::move(responderToInitiator)};
  return {std::move(responderToInitiator), std::move(initiatorToResponder)};
}

void HandshakeState::mixHash(const uint8_t* data, size_t length) {
  crypto_hash_sha256_state state;
  crypto_hash_sha256_init(&state);
  crypto_hash_sha256_update(&state, _h.data(), _h.size());
  if (length > 0) crypto_hash_sha256_update(&state, data, length);
  crypto_hash_sha256_final(&state, _h.data());
}

void HandshakeState::mixKey(const uint8_t* input, size_t length) {
  Key ck, k;
  hkdf(_ck, input, length, ck, k, nullptr);
  _ck = ck;
  _cipher = CipherState(k.data());
  sodium_memzero(ck.data(), ck.size());
  sodium_memzero(k.data(), k.size());
}

void HandshakeState::mixKeyAndHash(const uint8_t* input, size_t length) {
  Key ck, h, k;
  hkdf(_ck, input, length, ck, h, &k);
  _ck = ck;
  mixHash(h.data(), h.size());
  _cipher = CipherState(k.data());
  sodium_memzero(ck.data(), ck.size());
  sodium_memzero(h.data(), h.size());
  sodium_memzero(k.data(), k.size());
}

Bytes HandshakeState::encryptAndHash(const uint8_t* plaintext, size_t length) {
  Bytes ciphertext = _cipher.encryptWithAd(_h.data(), _h.size(), plaintext, length);
  mixHash(ciphertext.data(), ciphertext.size());
  return ciphertext;
}

Bytes HandshakeState::decryptAndHash(const uint8_t* ciphertext, size_t length) {
  Bytes plaintext = _cipher.decryptWithAd(_h.data(), _h.size(), ciphertext, length);
  mixHash(ciphertext, length);
  return plaintext;
}

void HandshakeState::mixEphemeral(const Key& publicKey) {
  mixHash(publicKey.data(), publicKey.size());
  // Noise revision 34, section 9.2: in a PSK handshake every "e" token also calls MixKey(e.public_key).
  if (_psk) mixKey(publicKey.data(), publicKey.size());
}

void HandshakeState::dh(const Key& privateKey, const Key& publicKey) {
  Key shared;
  if (crypto_scalarmult_curve25519(shared.data(), privateKey.data(), publicKey.data()) != 0)
    throw NoiseError("X25519 failed; the peer sent an invalid public key");
  mixKey(shared.data(), shared.size());
  sodium_memzero(shared.data(), shared.size());
}

void HandshakeState::mixToken(Token token) {
  if (token == Token::PSK) {
    if (!_psk) throw NoiseError("Pattern needs a PSK");
    mixKeyAndHash(_psk->data(), _psk->size());
    return;
  }
  if (!_e) throw NoiseError("Token needs an ephemeral key");
  auto remote = [](const std::optional<Key>& key) -> const Key& {
    if (!key) throw NoiseError("Token needs a remote key");
    return *key;
  };
  if (token == Token::EE) dh(_e->privateKey, remote(_re));
  else if (token == Token::ES) _initiator ? dh(_e->privateKey, remote(_rs)) : dh(_s.privateKey, remote(_re));
  else _initiator ? dh(_s.privateKey, remote(_re)) : dh(_e->privateKey, remote(_rs));
}

Transport::Transport(CipherState send, CipherState receive, size_t maxSendBytes, size_t maxReceiveBytes)
    : _send(std::move(send)), _receive(std::move(receive)), _maxSend(maxSendBytes), _maxReceive(maxReceiveBytes) {
  if (!_send.hasKey() || !_receive.hasKey()) throw NoiseError("Transport cipher states need keys");
}

Bytes Transport::encrypt(MessageType type, const uint8_t* body, size_t length) {
  if (_closed) throw NoiseError("The transport is closed");
  if (length > _maxSend) throw std::length_error("Message exceeds the send limit");
  Bytes plaintext(length + 1);
  plaintext[0] = static_cast<uint8_t>(type);
  if (length > 0) std::memcpy(plaintext.data() + 1, body, length);
  try {
    Bytes ciphertext = _send.encryptWithAd(nullptr, 0, plaintext.data(), plaintext.size());
    sodium_memzero(plaintext.data(), plaintext.size());
    return ciphertext;
  } catch (...) {
    _closed = true;
    throw;
  }
}

MessageType Transport::decrypt(uint8_t* message, size_t length) {
  if (_closed) throw NoiseError("The transport is closed");
  if (length > _maxReceive + 1 + kTagBytes || length < 1 + kTagBytes) {
    _closed = true;
    throw NoiseError(length < 1 + kTagBytes ? "Message is too short" : "Message is too large");
  }
  if (!_receive.decryptInto(message, length, message)) {
    _closed = true;
    throw NoiseError("Message failed authentication");
  }
  const uint8_t type = message[0];
  if (type != static_cast<uint8_t>(MessageType::Text) && type != static_cast<uint8_t>(MessageType::Binary)) {
    _closed = true;
    throw NoiseError("Unknown message type");
  }
  return static_cast<MessageType>(type);
}

} // namespace stim::noise

namespace stim::protocol {

using noise::Bytes;
using noise::Key;

namespace {

Key labeledHash(const char* label, const Bytes& secret) {
  noise::ensureSodium();
  crypto_hash_sha256_state state;
  crypto_hash_sha256_init(&state);
  crypto_hash_sha256_update(&state, reinterpret_cast<const uint8_t*>(label), std::strlen(label));
  crypto_hash_sha256_update(&state, secret.data(), secret.size());
  Key out;
  crypto_hash_sha256_final(&state, out.data());
  return out;
}

} // namespace

Key derivePsk(const Bytes& secret) {
  return labeledHash("stim noise psk v1", secret);
}

std::array<uint8_t, kLookupBytes> deriveLookup(const Bytes& secret) {
  Key hash = labeledHash("stim noise lookup v1", secret);
  std::array<uint8_t, kLookupBytes> lookup;
  std::memcpy(lookup.data(), hash.data(), kLookupBytes);
  return lookup;
}

Bytes prefix(const std::optional<Bytes>& secret) {
  Bytes out{kVersion, secret ? kModeFirstContact : kModeReturning};
  if (secret) {
    auto lookup = deriveLookup(*secret);
    out.insert(out.end(), lookup.begin(), lookup.end());
  }
  return out;
}

Bytes prologue(const Bytes& prefixBytes) {
  static const char label[] = "stim noise v1";
  Bytes out(label, label + sizeof(label) - 1);
  out.insert(out.end(), prefixBytes.begin(), prefixBytes.end());
  return out;
}

std::optional<Bytes> base64UrlDecode(const std::string& text) {
  noise::ensureSodium();
  Bytes out(text.size());
  size_t length = 0;
  if (sodium_base642bin(out.data(), out.size(), text.data(), text.size(), nullptr, &length, nullptr,
                        sodium_base64_VARIANT_URLSAFE_NO_PADDING) != 0) {
    return std::nullopt;
  }
  out.resize(length);
  return out;
}

std::string base64UrlEncode(const uint8_t* data, size_t length) {
  noise::ensureSodium();
  const size_t size = sodium_base64_ENCODED_LEN(length, sodium_base64_VARIANT_URLSAFE_NO_PADDING);
  std::string out(size, '\0');
  sodium_bin2base64(out.data(), size, data, length, sodium_base64_VARIANT_URLSAFE_NO_PADDING);
  out.resize(size - 1);
  return out;
}

} // namespace stim::protocol
