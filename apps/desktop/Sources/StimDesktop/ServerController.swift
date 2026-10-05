import AppKit
import Foundation
import StimKit

@MainActor
final class ServerController: ObservableObject {
  enum State: Equatable {
    case off
    case starting
    case running(ServerHealth, owned: Bool)
    case notReady(ServerStartup, owned: Bool)
    case failed(String)

    init(probe: ServerHealthProbe, owned: Bool, resolvedHome: String, port: Int) {
      switch probe {
      case .notReady(let startup, let stimHome):
        if !owned, let stimHome,
          let failure = StimHome.adoptionFailure(serverHome: stimHome, resolved: resolvedHome, port: port)
        {
          self = .failed(failure)
        } else {
          self = .notReady(startup, owned: owned)
        }
      case .ready(let health):
        if !owned,
          let failure = StimHome.adoptionFailure(serverHome: health.stimHome, resolved: resolvedHome, port: port)
        {
          self = .failed(failure)
        } else {
          self = .running(health, owned: owned)
        }
      }
    }
  }

  static let shared = ServerController()
  static let startTimeout: TimeInterval = 15

  enum StartupAction: Equatable {
    case retry
    case handOver
    case fail

    init(lastAnswer: ServerHealthProbe?, deadlinePassed: Bool) {
      switch lastAnswer {
      case .ready: self = .handOver
      case .notReady: self = deadlinePassed ? .handOver : .retry
      case nil: self = deadlinePassed ? .fail : .retry
      }
    }
  }

  @Published private(set) var state = State.off
  @Published private(set) var devices: [PairedDevice] = []
  @Published private(set) var devicesError: String?
  @Published private(set) var changeError: String?
  @Published private(set) var pendingGrants: [String: Bool] = [:]
  @Published private(set) var settingUpConnection = false
  @Published private(set) var connectionError: String?

  private var environment: Task<[String: String], Never>?
  private var process: Process?
  private var exiting: Process?
  private var output: [String] = []
  private var generation = 0
  private var devicesEpoch = 0
  private var missedProbes = 0
  private var serverLauncher: (executable: String?, launcher: NodeLauncher?, resolved: Date)?

  static let devicesInterval: Duration = .seconds(10)
  static let inactiveDevicesInterval: Duration = .seconds(60)

  private lazy var devicesPoller = ActivityPoller(
    active: Self.devicesInterval, inactive: Self.inactiveDevicesInterval, isActive: { NSApplication.shared.isActive },
    tick: { [weak self] in
      guard let self, isResponding else { return }
      refresh()
    })

  var port: Int {
    let port = UserDefaults.standard.integer(forKey: AppPreferences.Key.stimServerPort)
    return (1...65535).contains(port) ? port : StimServerCLI.defaultPort
  }

  /// Build clients, and Macs waiting for approval to build here, newest first.
  var buildClients: [PairedDevice] { devices.filter(\.isBuildClient) }

  var deviceHostClients: [PairedDevice] { devices.filter(\.isDeviceHostClient) }

  var phones: [PairedDevice] { devices.filter(\.isPhone) }

  var isRunning: Bool {
    if case .running = state { return true }
    return false
  }

  private var isResponding: Bool {
    switch state {
    case .running, .notReady: return true
    case .off, .starting, .failed: return false
    }
  }

  var canRestart: Bool {
    if case .running(_, owned: true) = state { return true }
    return false
  }

  func configure(environment: Task<[String: String], Never>) {
    self.environment = environment
    if UserDefaults.standard.bool(forKey: AppPreferences.Key.servesPhones) { start() }
    devicesPoller.start()
    NotificationCenter.default.addObserver(
      forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated { self?.devicesPoller.activate() }
    }
  }

  func cli() async -> StimServerCLI {
    var environment = await environment?.value ?? ProcessInfo.processInfo.environment
    if case .running(let health, _) = state { environment["STIM_HOME"] = health.stimHome }
    let override = UserDefaults.standard.string(forKey: AppPreferences.Key.stimServerExecutable)
    let plain = StimServerCLI(environment: environment, override: override)
    let stale = serverLauncher.map { $0.launcher?.script == nil && Date().timeIntervalSince($0.resolved) > 60 } ?? true
    if stale || serverLauncher?.executable != plain.executable {
      let launcher = await NodeLauncher.resolve(
        executable: plain.executable, name: "stim-server", environment: plain.environment)
      serverLauncher = (plain.executable, launcher, Date())
    }
    return StimServerCLI(environment: environment, override: override, launcher: serverLauncher?.launcher)
  }

  func start() {
    switch state {
    case .starting, .running, .notReady: return
    case .off, .failed: break
    }
    generation += 1
    let current = generation
    state = .starting
    missedProbes = 0
    Task {
      if let exiting {
        await Task.detached { Self.waitForExit(exiting) }.value
        self.exiting = nil
      }
      guard current == generation else { return }
      if let probe = await StimServerCLI.health(port: port) {
        let resolved = StimHome.path(environment: await environment?.value ?? ProcessInfo.processInfo.environment)
        guard current == generation else { return }
        state = State(probe: probe, owned: false, resolvedHome: resolved, port: port)
        return
      }
      let cli = await cli()
      guard current == generation else { return }
      output = []
      do {
        process = try cli.serve(
          port: port,
          onLine: { line in
            DispatchQueue.main.async { MainActor.assumeIsolated { self.record(line.text, generation: current) } }
          },
          onExit: { status in
            DispatchQueue.main.async { MainActor.assumeIsolated { self.exited(status, generation: current) } }
          })
      } catch {
        state = .failed(error.localizedDescription)
        return
      }
      let deadline = Date().addingTimeInterval(Self.startTimeout)
      var lastAnswer: ServerHealthProbe?
      var action = StartupAction.retry
      while action == .retry {
        try? await Task.sleep(for: .milliseconds(250))
        guard current == generation, process != nil else { return }
        let probe = await StimServerCLI.health(port: port)
        guard current == generation, process != nil else { return }
        if let probe {
          lastAnswer = probe
          state = State(probe: probe, owned: true, resolvedHome: StimHome.path(environment: cli.environment), port: port)
        }
        action = StartupAction(lastAnswer: lastAnswer, deadlinePassed: Date() >= deadline)
      }
      guard current == generation, process != nil, action == .fail else { return }
      generation += 1
      terminate()
      state = .failed("stim-server did not answer on port \(port) within \(Int(Self.startTimeout)) seconds.")
    }
  }

  func stop() {
    generation += 1
    terminate()
    state = .off
  }

  func restart() {
    guard canRestart else { return }
    stop()
    start()
  }

  func setupConnection() {
    guard isRunning, !settingUpConnection else { return }
    settingUpConnection = true
    connectionError = nil
    Task {
      defer { settingUpConnection = false }
      guard let client = ServerSession.shared.client, client.isOpen else {
        connectionError = "The local Desktop connection is not ready. Try again."
        return
      }
      do {
        _ = try await client.request("route.setup", [:])
        refresh()
      } catch let error as ServerError where error.code == "unknown-method" {
        connectionError = "Update stim-server to set up the phone connection from Desktop."
      } catch {
        connectionError = error.localizedDescription
      }
    }
  }

  func pairPhone(control: Bool) async throws -> PairingCode {
    let cli = await cli()
    guard isRunning, case .ready(let before) = await StimServerCLI.health(port: port) else {
      throw ServerError(code: "not-connected", message: "Could not verify the phone connection. Try again.")
    }
    if before.tailscale.isRunning && before.route?.state != "routed" {
      throw ServerError(
        code: "not-connected",
        message: "Set up the phone connection in the Phones tab before pairing. A verified tailnet-only route is required.")
    }
    let code = try await cli.pair(port: port, control: control)
    if before.tailscale.isRunning || !code.isLocalOnly {
      guard case .ready(let after) = await StimServerCLI.health(port: port), after.route?.state == "routed",
        let dnsName = after.tailscale.dnsName, code.qr.endpoint == after.route?.endpoint(dnsName: dnsName)
      else {
        throw ServerError(
          code: "not-connected", message: "The phone connection changed or could not be verified. Try again in the Phones tab.")
      }
    }
    return code
  }

  func refresh() {
    reloadDevices()
    let owned: Bool
    switch state {
    case .running(_, let value), .notReady(_, let value): owned = value
    case .off, .starting, .failed: return
    }
    let current = generation
    Task {
      let probe = await StimServerCLI.health(port: port)
      let resolved = StimHome.path(environment: await environment?.value ?? ProcessInfo.processInfo.environment)
      guard current == generation, isResponding else { return }
      switch probe {
      case .notReady(let startup, let stimHome)
      where owned || (stimHome.map { StimHome.adopts(serverHome: $0, resolved: resolved) } ?? true):
        missedProbes = 0
        state = .notReady(startup, owned: owned)
      case .ready(let health) where owned || StimHome.adopts(serverHome: health.stimHome, resolved: resolved):
        missedProbes = 0
        state = .running(health, owned: owned)
        if health.nativeViewerOpened == true { NativeViewerPermissions.shared.viewerOpened(serverOwned: owned) }
      default:
        if !owned {
          missedProbes += 1
          guard missedProbes >= 2 else { return }
          missedProbes = 0
          state = .off
          if UserDefaults.standard.bool(forKey: AppPreferences.Key.servesPhones) { start() }
        }
      }
    }
  }

  func reloadDevices() {
    let epoch = devicesEpoch
    let health: ServerHealth? = if case .running(let health, _) = state { health } else { nil }
    Task {
      let cli = await cli()
      let result = await Result.awaiting { try await cli.devices() }
      guard epoch == devicesEpoch else { return }
      switch result {
      case .success(let devices):
        let own = health.flatMap { ServerSession.ownDeviceID(home: $0.stimHome) }
        self.devices = devices.filter { $0.id != own }.map { device in
          guard let control = pendingGrants[device.id] else { return device }
          var device = device
          device.capabilities = Self.capabilities(control: control)
          return device
        }
        .sorted { $0.pairedAt > $1.pairedAt }
        devicesError = nil
      case .failure(let error):
        devicesError = error.localizedDescription
      }
    }
  }

  func grant(_ device: PairedDevice, control: Bool) {
    guard pendingGrants[device.id] == nil else { return }
    pendingGrants[device.id] = control
    if let index = devices.firstIndex(where: { $0.id == device.id }) {
      devices[index].capabilities = Self.capabilities(control: control)
    }
    Task {
      let cli = await cli()
      let result = await Result.awaiting { try await cli.grant(device.id, control: control) }
      pendingGrants[device.id] = nil
      devicesEpoch += 1
      if case .failure(let error) = result { changeError = error.localizedDescription } else { changeError = nil }
      reloadDevices()
    }
  }

  private static func capabilities(control: Bool) -> [String] {
    control ? ["read", "control"] : ["read"]
  }

  func allowMachine(_ device: PairedDevice) {
    Task {
      let cli = await cli()
      switch await Result.awaiting({
        if device.isDeviceHostClient {
          try await cli.grantDeviceHost(device.id)
        } else {
          try await cli.grantBuild(device.id)
        }
      }) {
      case .success: changeError = nil
      case .failure(let error): changeError = error.localizedDescription
      }
      devicesEpoch += 1
      reloadDevices()
    }
  }

  func revoke(_ device: PairedDevice) {
    Task {
      let cli = await cli()
      switch await Result.awaiting({ try await cli.revoke(device.id) }) {
      case .success:
        changeError = nil
        devicesEpoch += 1
        reloadDevices()
      case .failure(let error): changeError = error.localizedDescription
      }
    }
  }

  func stopForQuit() {
    generation += 1
    terminate()
    if let exiting { Self.waitForExit(exiting) }
  }

  private func terminate() {
    if let process, process.isRunning {
      process.terminate()
      exiting = process
    }
    process = nil
  }

  /// SIGTERM lets the server close its clients and its `stim status` child; SIGKILL follows after 3 seconds.
  private nonisolated static func waitForExit(_ process: Process) {
    let deadline = Date().addingTimeInterval(3)
    while process.isRunning, Date() < deadline { usleep(50_000) }
    guard process.isRunning else { return }
    kill(process.processIdentifier, SIGKILL)
    process.waitUntilExit()
  }

  private func record(_ line: String, generation: Int) {
    guard generation == self.generation else { return }
    output = Array((output + [line]).suffix(20))
  }

  private func exited(_ status: Int32, generation: Int) {
    guard generation == self.generation else { return }
    process = nil
    let detail = output.filter { !$0.isEmpty }.joined(separator: "\n")
    state = .failed("stim-server exited with status \(status).\(detail.isEmpty ? "" : "\n\(detail)")")
  }
}
