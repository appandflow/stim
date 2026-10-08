#if DEBUG
  import Foundation
  import StimKit
  import SwiftUI

  enum PairPhoneFixture: String, CaseIterable, Identifiable {
    case app, tailscaleChecking, tailscaleMissing, tailscaleOff, tailscaleCLI, tailscaleOn
    case serveStarting, serveRoute, serveReady, serveFunnel, serveRouteFailed, serveFailed, serveOtherHome
    case pairWaiting, pairManual, pairExpired, pairError, pairedControl, pairedViewOnly
    var id: Self { self }

    @MainActor func make() -> PairPhoneModel {
      let now = Date(timeIntervalSince1970: 1_791_284_400)
      let running = MacTailscale.running(dnsName: "macbook.tail.test")
      var snapshot = PairPhoneModel.Snapshot(server: .off)
      switch self {
      case .serveStarting: snapshot.server = .starting
      case .serveFailed: snapshot.server = .failed("stim-server was not found on PATH.")
      case .serveRoute, .serveRouteFailed:
        snapshot.server = .running(tailscale: true, route: "missing", servesOtherHome: false)
      case .serveFunnel: snapshot.server = .running(tailscale: true, route: "funneled", servesOtherHome: false)
      case .serveOtherHome: snapshot.server = .running(tailscale: true, route: "routed", servesOtherHome: true)
      case .serveReady, .pairWaiting, .pairManual, .pairExpired, .pairError, .pairedControl, .pairedViewOnly:
        snapshot.server = .running(tailscale: true, route: "routed", servesOtherHome: false)
      default: break
      }
      if case .running(_, let route, _) = snapshot.server {
        snapshot.route = Self.decode(ServeRoute.self, "{\"state\":\"\(route!)\",\"port\":7443}")
        snapshot.dnsName = "macbook.tail.test"
        snapshot.stimHome = self == .serveOtherHome ? NSHomeDirectory() + "/stim-test" : NSHomeDirectory() + "/.stim"
      }
      if self == .serveRouteFailed {
        snapshot.connectionError = "Enable Tailscale HTTPS at https://login.tailscale.com/admin/dns then try again."
      }
      var wizard = PhonePairing(servesPhones: false, server: .off, phones: [], now: now)
      if self != .app { _ = wizard.apply(.next, now: now) }
      let tailscale: MacTailscale
      switch self {
      case .app, .tailscaleChecking: tailscale = .checking
      case .tailscaleMissing: tailscale = .missing
      case .tailscaleOff: tailscale = .stopped(hasApp: true)
      case .tailscaleCLI: tailscale = .stopped(hasApp: false)
      default: tailscale = running
      }
      _ = wizard.apply(.tailscale(tailscale), now: now)
      if rawValue.hasPrefix("serve") || rawValue.hasPrefix("pair") {
        _ = wizard.apply(.next, now: now)
        _ = wizard.apply(.server(snapshot.server), now: now)
      }
      if self == .serveRouteFailed {
        _ = wizard.apply(.routeFinished(error: snapshot.connectionError), now: now)
      }
      let isPair = rawValue.hasPrefix("pair")
      if isPair {
        _ = wizard.apply(.next, now: now)
        if self == .pairedViewOnly { _ = wizard.apply(.access(control: false), now: now) }
      }
      let expiresAt = self == .pairExpired ? now.addingTimeInterval(-1) : now.addingTimeInterval(300)
      let code = Self.decode(
        PairingCode.self,
        """
        {"qr":{"v":1,"name":"MacBook","endpoint":"wss://macbook.tail.test:7443","pairingToken":"fixture-token"},
         "expiresAt":\(expiresAt.timeIntervalSince1970)}
        """)
      if self == .pairExpired {
        for _ in 0..<PhonePairing.automaticRenewals {
          _ = wizard.apply(.codeIssued(expiresAt: expiresAt, control: true), now: now)
          _ = wizard.apply(.tick, now: now)
        }
      }
      if self == .pairError {
        _ = wizard.apply(.codeFailed("The phone connection changed. Try again."), now: now)
      } else if isPair {
        _ = wizard.apply(.codeIssued(expiresAt: expiresAt, control: wizard.control), now: now)
      }
      var devices: [PairedDevice] = []
      if self == .pairedControl || self == .pairedViewOnly {
        let capabilities = self == .pairedControl ? "[\"read\",\"control\"]" : "[\"read\"]"
        devices = [
          Self.decode(
            PairedDevice.self,
            """
            {"id":"fixture-phone","name":"Janic's iPhone","identity":{"kind":"tailnet","nodeName":"phone"},
             "pairedAt":\(now.timeIntervalSince1970),"capabilities":\(capabilities)}
            """)
        ]
        _ = wizard.apply(.devices(devices), now: now)
      }
      let model = PairPhoneModel(
        servesPhones: false,
        dependencies: .init(
          tailscale: { tailscale }, snapshot: { snapshot }, refreshServer: {}, reloadDevices: {}, devices: { devices },
          startServing: {}, stopServing: {}, setUpRoute: { nil }, pair: { _ in code }, now: { now }), wizard: wizard)
      model.configureFixture(
        code: isPair && self != .pairError && wizard.step != .done ? code : nil, manualExpanded: self == .pairManual)
      return model
    }

    private static func decode<T: Decodable>(_ type: T.Type, _ json: String) -> T {
      let decoder = JSONDecoder()
      decoder.dateDecodingStrategy = .secondsSince1970
      return try! decoder.decode(type, from: Data(json.utf8))
    }
  }

  struct PairPhonePlayground: View {
    @State private var fixture = PairPhoneFixture.app
    @State private var model = PairPhoneFixture.app.make()

    var body: some View {
      VStack(spacing: 0) {
        Picker("Wizard state", selection: $fixture) {
          ForEach(PairPhoneFixture.allCases) { Text($0.rawValue).tag($0) }
        }.padding(Space.md)
        PairPhoneSheet(model: model, openPhones: {}).id(fixture)
      }
      .onChange(of: fixture) { model = fixture.make() }
    }
  }
#endif
