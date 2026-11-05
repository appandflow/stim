#include "Noise.hpp"

#include <iostream>
#include <sstream>
#include <string>
#include <vector>

using namespace stim::noise;

namespace {

Bytes hex(const std::string& text) {
  Bytes out;
  if (text == "-") return out;
  for (size_t i = 0; i + 1 < text.size(); i += 2) out.push_back(static_cast<uint8_t>(std::stoi(text.substr(i, 2), nullptr, 16)));
  return out;
}

Key key(const std::string& text) {
  Bytes bytes = hex(text);
  Key out{};
  std::copy(bytes.begin(), bytes.end(), out.begin());
  return out;
}

std::string handshake(std::istringstream& line, std::istream& in) {
  std::string name, protocol, ip, is, ie, ipsk, rp, rs, re, rpsk, hash;
  size_t count;
  line >> name >> protocol >> ip >> is >> ie >> ipsk >> rp >> rs >> re >> rpsk >> hash >> count;
  std::vector<std::pair<Bytes, Bytes>> messages;
  for (size_t i = 0; i < count; i++) {
    std::string text, kind, payload, ciphertext;
    std::getline(in, text);
    std::istringstream message(text);
    message >> kind >> payload >> ciphertext;
    messages.emplace_back(hex(payload), hex(ciphertext));
  }
  const Key isk = key(is), iek = key(ie), rsk = key(rs), rek = key(re);
  KeyPair initStatic = keyPairFromPrivateKey(isk.data()), initEphemeral = keyPairFromPrivateKey(iek.data());
  KeyPair respStatic = keyPairFromPrivateKey(rsk.data()), respEphemeral = keyPairFromPrivateKey(rek.data());
  const Pattern pattern = protocol.find("psk2") != std::string::npos ? Pattern::XXpsk2 : Pattern::XX;
  HandshakeOptions initOptions{pattern, true, hex(ip), &initStatic, std::nullopt, &initEphemeral};
  HandshakeOptions respOptions{pattern, false, hex(rp), &respStatic, std::nullopt, &respEphemeral};
  if (pattern == Pattern::XXpsk2) {
    initOptions.psk = key(ipsk);
    respOptions.psk = key(rpsk);
  }
  HandshakeState initiator(initOptions), responder(respOptions);
  for (size_t i = 0; i < 3; i++) {
    HandshakeState& writer = i % 2 == 0 ? initiator : responder;
    HandshakeState& reader = i % 2 == 0 ? responder : initiator;
    Bytes message = writer.writeMessage(messages[i].first.data(), messages[i].first.size());
    if (message != messages[i].second) return name + ": handshake message " + std::to_string(i) + " differs";
    if (reader.readMessage(message.data(), message.size()) != messages[i].first)
      return name + ": handshake payload " + std::to_string(i) + " differs";
  }
  if (hash != "-" && (initiator.handshakeHash() != key(hash) || responder.handshakeHash() != key(hash)))
    return name + ": handshake hash differs";
  auto [initSend, initReceive] = initiator.split();
  auto [respSend, respReceive] = responder.split();
  for (size_t i = 3; i < messages.size(); i++) {
    CipherState& sender = i % 2 == 0 ? initSend : respSend;
    CipherState& receiver = i % 2 == 0 ? respReceive : initReceive;
    Bytes message = sender.encryptWithAd(nullptr, 0, messages[i].first.data(), messages[i].first.size());
    if (message != messages[i].second) return name + ": transport message " + std::to_string(i) + " differs";
    if (receiver.decryptWithAd(nullptr, 0, message.data(), message.size()) != messages[i].first)
      return name + ": transport payload " + std::to_string(i) + " differs";
  }
  return "";
}

std::string framing(std::istringstream& line) {
  std::string k, counter, type, data, ciphertext;
  line >> k >> counter >> type >> data >> ciphertext;
  const Key cipherKey = key(k);
  CipherState send(cipherKey.data()), receive(cipherKey.data());
  send.setNonce(std::stoull(counter));
  receive.setNonce(std::stoull(counter));
  Transport transport(std::move(send), std::move(receive), 1 << 24, 1 << 24);
  const MessageType kind = type == "text" ? MessageType::Text : MessageType::Binary;
  const Bytes body = hex(data);
  Bytes message = transport.encrypt(kind, body.data(), body.size());
  if (message != hex(ciphertext)) return "framing at counter " + counter + ": ciphertext differs";
  if (transport.decrypt(message.data(), message.size()) != kind ||
      Bytes(message.begin() + 1, message.end() - kTagBytes) != body)
    return "framing at counter " + counter + ": plaintext differs";
  return "";
}

} // namespace

int main() {
  size_t handshakes = 0, framings = 0, failures = 0;
  std::string text;
  while (std::getline(std::cin, text)) {
    std::istringstream line(text);
    std::string kind;
    line >> kind;
    std::string failure;
    try {
      if (kind == "V") {
        handshakes++;
        failure = handshake(line, std::cin);
      } else if (kind == "F") {
        framings++;
        failure = framing(line);
      } else {
        continue;
      }
    } catch (const std::exception& error) {
      failure = kind + ": " + error.what();
    }
    if (!failure.empty()) {
      failures++;
      std::cout << "FAIL " << failure << "\n";
    }
  }
  std::cout << handshakes << " handshake vectors, " << framings << " framing vectors, " << failures << " failures\n";
  return failures == 0 ? 0 : 1;
}
