import Foundation
import Testing

@testable import StimKit

@Suite struct PairingPayloadTests {
  static let token = "pi0jTJc87qI-3ZptkFJ1k3eiBjzGWD-kUfYWSn_WOCc"
  static let fingerprint = "ctu3M2x2eAAj-D2kw1Xy7uqFczsT00d2l5F3kMEikIQ"

  static func payload(
    v: Int = 2, endpoint: String = "wss://floco.tail1234.ts.net:7443", fingerprint: String? = fingerprint
  ) -> String {
    var fields = #""v":\#(v),"name":"floco","endpoint":"\#(endpoint)","pairingToken":"\#(token)""#
    if let fingerprint { fields += #","fingerprint":"\#(fingerprint)""# }
    return "{\(fields)}"
  }

  @Test func bothPrintedFormsOfStimServerPairParse() throws {
    let bare = try PairingPayload.parse(Self.payload())
    let wrapped = try PairingPayload.parse(#"{"qr":\#(Self.payload()),"expiresAt":"2026-10-26T12:05:00.000Z"}"#)
    #expect(bare == wrapped)
    #expect(bare.name == "floco")
    #expect(bare.endpoint.absoluteString == "wss://floco.tail1234.ts.net:7443")
    #expect(bare.secret == Noise.decodeSecret(Self.token))
    #expect(bare.fingerprint == Self.fingerprint)
  }

  @Test func aPayloadWithoutAFingerprintOrFromAnotherProtocolIsRefused() {
    #expect(throws: PairingPayload.Problem.missingFingerprint) { try PairingPayload.parse(Self.payload(fingerprint: nil)) }
    #expect(throws: PairingPayload.Problem.serverOutdated) { try PairingPayload.parse(Self.payload(v: 1, fingerprint: nil)) }
    #expect(throws: PairingPayload.Problem.desktopOutdated) { try PairingPayload.parse(Self.payload(v: 3)) }
    #expect(throws: PairingPayload.Problem.notAPairingCode) { try PairingPayload.parse("stim") }
    #expect(throws: PairingPayload.Problem.badToken) {
      try PairingPayload.parse(Self.payload(fingerprint: "short"))
    }
  }

  struct EndpointVector: Decodable {
    var endpoint: String
    var kind: String
    var desktop: Bool
  }

  @Test func endpointsFollowTheRuleSharedWithThePhoneApp() throws {
    let url = Bundle.module.url(
      forResource: "pairing-endpoint-vectors", withExtension: "json", subdirectory: "Fixtures")!
    struct File: Decodable { var endpoints: [EndpointVector] }
    let vectors = try JSONDecoder().decode(File.self, from: Data(contentsOf: url)).endpoints
    #expect(vectors.contains { $0.kind == "localNetwork" })
    for vector in vectors {
      let payload = try? PairingPayload.parse(Self.payload(endpoint: vector.endpoint))
      #expect((payload != nil) == vector.desktop, "\(vector.endpoint)")
      if let payload {
        #expect(payload.network == (vector.kind == "tailnet" ? .tailnet : .localNetwork), "\(vector.endpoint)")
      } else {
        #expect(throws: PairingPayload.Problem.unsupportedEndpoint, "\(vector.endpoint)") {
          try PairingPayload.parse(Self.payload(endpoint: vector.endpoint))
        }
      }
    }
  }
}
