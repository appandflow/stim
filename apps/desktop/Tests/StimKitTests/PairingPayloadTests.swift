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

  @Test func onlyTailnetEndpointsAreAccepted() {
    let accepted = [
      "wss://floco.tail1234.ts.net:7443", "wss://Floco.Tail1234.TS.net/", "ws://100.64.0.1:7787",
      "ws://100.127.255.254:7787", "ws://[fd7a:115c:a1e0::1]:7787",
    ]
    let refused = [
      "ws://floco.tail1234.ts.net:7443", "wss://ts.net", "wss://example.com", "ws://100.63.255.255:7787",
      "ws://100.128.0.1:7787", "ws://203.0.113.5:7787", "ws://127.0.0.1:7787", "ws://192.168.1.2:7787",
      "ws://[fd7a:115c:a1e1::1]:7787", "wss://user:pass@floco.tail1234.ts.net", "wss://floco.tail1234.ts.net/?x=1",
      "http://100.64.0.1:7787", "wss://100.64.0.1:7443",
    ]
    for endpoint in accepted {
      #expect((try? PairingPayload.parse(Self.payload(endpoint: endpoint))) != nil, "\(endpoint)")
    }
    for endpoint in refused {
      #expect(throws: PairingPayload.Problem.notTailnet, "\(endpoint)") {
        try PairingPayload.parse(Self.payload(endpoint: endpoint))
      }
    }
  }
}
