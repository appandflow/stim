import Foundation
import Observation
import StimKit

@MainActor @Observable
final class PairPhoneModel {
  struct Snapshot {
    var server: PhoneServer
    var route: ServeRoute? = nil
    var dnsName: String? = nil
    var port = StimServerCLI.defaultPort
    var stimHome: String? = nil
    var connectionError: String? = nil
  }

  struct Dependencies {
    var tailscale: () async -> MacTailscale
    var snapshot: () -> Snapshot
    var refreshServer: () -> Void
    var reloadDevices: () -> Void
    var devices: () -> [PairedDevice]
    var startServing: () -> Void
    var stopServing: () -> Void
    var setUpRoute: () async -> String?
    var pair: (Bool) async throws -> PairingCode
    var now: () -> Date = Date.init
  }

  private(set) var wizard: PhonePairing
  private(set) var code: PairingCode?
  private(set) var route: ServeRoute?
  private(set) var dnsName: String?
  private(set) var serverPort: Int
  private(set) var serverStimHome: String?
  private(set) var connectionError: String?
  private(set) var now: Date
  private(set) var isFixture = false
  var manualExpanded = false
  @ObservationIgnored private let dependencies: Dependencies
  @ObservationIgnored private var polling: Task<Void, Never>?
  @ObservationIgnored private var stopped = false
  @ObservationIgnored private var codeRequest = UUID()

  init(servesPhones: Bool, dependencies: Dependencies, wizard: PhonePairing? = nil, fixing: Bool = false) {
    self.dependencies = dependencies
    let snapshot = dependencies.snapshot()
    now = dependencies.now()
    self.wizard =
      wizard
      ?? PhonePairing(
        servesPhones: servesPhones, server: snapshot.server, phones: dependencies.devices(), now: dependencies.now(),
        fixing: fixing)
    route = snapshot.route
    dnsName = snapshot.dnsName
    serverPort = snapshot.port
    serverStimHome = snapshot.stimHome
    connectionError = snapshot.connectionError
  }

  convenience init(stimHome: String, fixing: Bool = false) {
    let server = ServerController.shared
    self.init(
      servesPhones: UserDefaults.standard.bool(forKey: AppPreferences.Key.servesPhones),
      dependencies: Dependencies(
        tailscale: {
          let environment = await server.cli().environment
          return await Task.detached {
            MacTailscale(
              statusJSON: Tailnet.status(environment: environment),
              install: Tailnet.Install.detect(environment: environment))
          }.value
        },
        snapshot: {
          var snapshot = Snapshot(server: .off, port: server.port, connectionError: server.connectionError)
          switch server.state {
          case .off: break
          case .starting, .notReady(.pending, _): snapshot.server = .starting
          case .notReady(.degraded(let reason), _): snapshot.server = .degraded(reason)
          case .failed(let message): snapshot.server = .failed(message)
          case .running(let health, _):
            snapshot.server = .running(
              tailscale: health.tailscale.isRunning, route: health.route?.state,
              servesOtherHome: StimHome.isDefault(stimHome) && !health.servesDefaultHome())
            snapshot.route = health.route
            snapshot.dnsName = health.tailscale.dnsName
            snapshot.stimHome = health.stimHome
          }
          return snapshot
        },
        refreshServer: { server.refresh() }, reloadDevices: { server.reloadDevices() }, devices: { server.devices },
        startServing: {
          UserDefaults.standard.set(true, forKey: AppPreferences.Key.servesPhones)
          server.start()
        },
        stopServing: {
          UserDefaults.standard.set(false, forKey: AppPreferences.Key.servesPhones)
          server.stopServing()
        },
        setUpRoute: { await server.setUpConnection() }, pair: { try await server.pairPhone(control: $0) }),
      fixing: fixing)
  }

  func start() async {
    guard !isFixture, polling == nil, !wizard.cancelled else { return }
    stopped = false
    polling = Task { [weak self] in
      var lastTailscale = Date.distantPast
      var lastServer = Date.distantPast
      var lastDevices = Date.distantPast
      while !Task.isCancelled {
        guard let self, !self.stopped else { return }
        self.now = self.dependencies.now()
        self.send(.tick)
        self.readSnapshot()
        if self.wizard.step <= .serve, self.now.timeIntervalSince(lastTailscale) >= 3 {
          lastTailscale = self.now
          let tailscale = await self.dependencies.tailscale()
          guard !Task.isCancelled, !self.stopped else { return }
          self.send(.tailscale(tailscale))
        }
        if [.serve, .pair].contains(self.wizard.step), self.now.timeIntervalSince(lastServer) >= 2 {
          lastServer = self.now
          self.dependencies.refreshServer()
        }
        if self.wizard.step == .pair {
          if self.now.timeIntervalSince(lastDevices) >= 2 {
            lastDevices = self.now
            self.dependencies.reloadDevices()
          }
          self.send(.devices(self.dependencies.devices()))
        }
        try? await Task.sleep(for: .seconds(1))
      }
    }
  }

  func send(_ event: PhonePairing.Event) {
    now = dependencies.now()
    let effects = wizard.apply(event, now: now)
    if wizard.step != .pair {
      codeRequest = UUID()
      code = nil
    }
    guard !isFixture else { return }
    for effect in effects {
      switch effect {
      case .startServing: dependencies.startServing()
      case .stopServing: dependencies.stopServing()
      case .setUpRoute:
        Task {
          let error = await dependencies.setUpRoute()
          guard !stopped else { return }
          send(.routeFinished(error: error.map { abbreviatingHome($0) }))
          dependencies.refreshServer()
        }
      case .requestCode(let control):
        code = nil
        let request = UUID()
        codeRequest = request
        Task {
          do {
            let code = try await dependencies.pair(control)
            guard !stopped, codeRequest == request, wizard.step == .pair, control == wizard.control else { return }
            self.code = code
            send(.codeIssued(expiresAt: code.expiresAt, control: control))
          } catch {
            guard !stopped, codeRequest == request, wizard.step == .pair, control == wizard.control else { return }
            send(.codeFailed(abbreviatingHome(error.localizedDescription)))
          }
        }
      }
    }
  }

  func cancel() {
    send(.cancel)
    stop()
  }

  func stop() {
    stopped = true
    codeRequest = UUID()
    polling?.cancel()
    polling = nil
  }

  private func readSnapshot() {
    let snapshot = dependencies.snapshot()
    route = snapshot.route
    dnsName = snapshot.dnsName
    serverPort = snapshot.port
    serverStimHome = snapshot.stimHome
    connectionError = snapshot.connectionError.map { abbreviatingHome($0) }
    send(.server(snapshot.server))
  }

  #if DEBUG
    func configureFixture(code: PairingCode?, manualExpanded: Bool = false) {
      isFixture = true
      self.code = code
      self.manualExpanded = manualExpanded
    }
  #endif
}
