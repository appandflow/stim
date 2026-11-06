import AppKit
import Foundation
import StimKit

/// The Stim home's stimd: found through `run/stimd.json`, or started from the machine's engine when none runs. Desktop
/// never stops it; stimd serves the CLI too and exits on its own idle clock.
@MainActor
final class ServerController: ObservableObject {
  enum State: Equatable {
    case off
    case starting
    case running(ServerHealth, owned: Bool)
    case notReady(ServerStartup, owned: Bool)
    case failed(String)

    var logName: String {
      switch self {
      case .off: "off"
      case .starting: "starting"
      case .running(_, let owned): "running(\(owned ? "started by Desktop" : "found"))"
      case .notReady(let startup, let owned): "notReady(\(startup), \(owned ? "started by Desktop" : "found"))"
      case .failed(let message): "failed(\(message))"
      }
    }

    var logLevel: DebugLog.Level {
      switch self {
      case .failed: .error
      case .notReady(.degraded, _): .warning
      default: .info
      }
    }

    var kind: String {
      switch self {
      case .off: "off"
      case .starting: "starting"
      case .running: "running"
      case .notReady: "not-ready"
      case .failed: "failed"
      }
    }
  }

  /// What the start loop does after a poll of `run/stimd.json`.
  enum StartupAction: Equatable {
    case use(StimdRecord)
    case wait
    /// A record Desktop cannot read: `text` says to update Desktop.
    case refuse(String)
    case fail

    static func decide(_ read: EngineRead<StimdRecord>, alive: (StimdRecord) -> Bool, deadlinePassed: Bool)
      -> StartupAction
    {
      switch read {
      case .found(let record) where alive(record): return .use(record)
      case .unknownFormat(let text): return .refuse(text)
      case .found, .missing, .unreadable: return deadlinePassed ? .fail : .wait
      }
    }
  }

  static let shared = ServerController()
  static let startTimeout: TimeInterval = 15

  @Published private(set) var state = State.off {
    didSet {
      if state != oldValue { DebugLog.log(state.logLevel, .server, "state \(oldValue.logName) -> \(state.logName)") }
      if case .failed = state { if case .failed = oldValue {} else { failedAt = Date() } } else { failedAt = nil }
      let failure = failureKind
      failureKind = nil
      if state.kind != oldValue.kind {
        Diagnostics.shared.breadcrumb("server", "state \(state.kind)")
        Diagnostics.shared.tag("server_state", state.kind)
        if case .failed = state { Diagnostics.shared.report(.server(failure ?? .exited)) }
      }
      if case .running = state {
        if case .running = oldValue {} else { reloadDevices() }
      } else {
        hasDeviceList = false
      }
    }
  }
  @Published private(set) var devices: [PairedDevice] = []
  private var hasDeviceList = false
  @Published private(set) var devicesError: String?
  @Published private(set) var changeError: String?
  @Published private(set) var pendingGrants: [String: Bool] = [:]
  @Published private(set) var settingUpConnection = false
  @Published private(set) var connectionError: String?
  @Published private(set) var connectionRefusal: String?
  /// What starting needs from the engine store, from the last start.
  @Published private(set) var engine: EngineNeed?
  /// What the start loop is doing while it installs or updates the engine.
  @Published private(set) var startDetail: String?
  /// The running stimd's record, which names the socket Desktop connects to.
  @Published private(set) var record: StimdRecord?
  /// The loopback port of stimd's network listener, once `net.ensure` answered.
  @Published private(set) var netPort: Int?
  var reconnect: (() -> Void)?

  private var environment: Task<[String: String], Never>?
  /// The launch environment with the Settings Stim home and overrides, read once at launch like the CLI's.
  private var settingsEnvironment = ProcessInfo.processInfo.environment
  private var process: Process?
  private var generation = 0
  private var devicesEpoch = 0
  private var failedAt: Date?
  private var failureKind: ServerFailureKind?
  private var retriesFailure = true
  static let retryAfter: TimeInterval = 30

  static let devicesInterval: Duration = .seconds(10)
  static let inactiveDevicesInterval: Duration = .seconds(60)

  private lazy var devicesPoller = ActivityPoller(
    active: Self.devicesInterval, inactive: Self.inactiveDevicesInterval, isActive: { NSApplication.shared.isActive },
    tick: { [weak self] in
      guard let self else { return }
      retryFailure()
      guard isResponding else { return }
      refresh()
    })

  var stimHome: String { StimHome.path(environment: settingsEnvironment) }
  var engineRoot: EngineRoot { EngineRoot(environment: settingsEnvironment) }

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

  /// Why the server is unusable, or nil while it starts, runs with an open connection or waits for its Stim home.
  var problem: String? { Self.problem(state: state, connectionRefusal: connectionRefusal) ?? engineNotice }

  /// What to tell the person about an engine older than this Desktop that Desktop does not move forward itself.
  var engineNotice: String? {
    switch engine {
    case .pinned(_, let text): return text
    case .moveForward(let engine, automatic: false):
      return
        "The Stim engine \(engine.version) is older than this Stim Desktop needs (\(EngineInstall.wanted?.description ?? "")): run stim engine update, or Update Engine."
    case .ready, .install, .moveForward(_, automatic: true), .unreadable, nil: return nil
    }
  }

  static func problem(state: State, connectionRefusal: String?) -> String? {
    switch state {
    case .failed(let message): return message
    case .notReady(.degraded(let reason), _): return "Degraded: \(reason)"
    case .running: return connectionRefusal
    case .off, .starting, .notReady(.pending, _): return nil
    }
  }

  /// A failure that can clear by itself, such as an engine download that lost the network, is retried from the
  /// poller after `retryAfter` seconds. A file this Desktop cannot read is not.
  private func retryFailure() {
    guard retriesFailure, case .failed = state, let failedAt, Date().timeIntervalSince(failedAt) >= Self.retryAfter else {
      return
    }
    start()
  }

  func retry() {
    if engineNotice != nil, isRunning {
      Task { await updateEngine() }
    } else if case .failed = state {
      start()
    } else if connectionRefusal != nil {
      reconnect?()
    } else {
      refresh()
    }
  }

  func connectionRefused(_ message: String?) {
    if connectionRefusal != message { connectionRefusal = message }
  }

  func configure(environment: Task<[String: String], Never>, settingsEnvironment: [String: String]) {
    self.environment = environment
    self.settingsEnvironment = settingsEnvironment
    start()
    devicesPoller.start()
    NotificationCenter.default.addObserver(
      forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated { self?.devicesPoller.activate() }
    }
  }

  /// The login environment with the Stim home and engine root Desktop runs.
  private func engineEnvironment() async -> [String: String] {
    var environment = await environment?.value ?? ProcessInfo.processInfo.environment
    environment["STIM_HOME"] = settingsEnvironment["STIM_HOME"]
    environment["STIM_ENGINE_ROOT"] = settingsEnvironment["STIM_ENGINE_ROOT"]
    return environment
  }

  /// The engine CLI with the login environment and the Stim home Desktop runs.
  func cli() async -> StimServerCLI {
    let environment = await engineEnvironment()
    return StimServerCLI(environment: environment, engine: EngineLaunch.resolve(environment: environment))
  }

  func start() {
    switch state {
    case .starting, .running, .notReady: return
    case .off, .failed: break
    }
    generation += 1
    let current = generation
    state = .starting
    retriesFailure = true
    netPort = nil
    record = nil
    Task {
      switch StartupAction.decide(
        EngineFiles.stimd(stimHome: stimHome), alive: EngineFiles.isAlive, deadlinePassed: false)
      {
      case .use(let record) where current == generation: return use(record, owned: false)
      case .refuse(let text) where current == generation: return refuse(text)
      case .use, .refuse: return
      case .wait, .fail: break
      }
      guard let launch = await prepareEngine(generation: current), current == generation else { return }
      let command = launch.stimd(engineRoot)
      do {
        process = try Self.launch(command, environment: launchEnvironment) { status in
          DispatchQueue.main.async { MainActor.assumeIsolated { self.exited(status, generation: current) } }
        }
      } catch {
        failureKind = .launchFailed
        state = .failed("Could not start stimd: \(error.localizedDescription)")
        return
      }
      let deadline = Date().addingTimeInterval(Self.startTimeout)
      while current == generation {
        let action = StartupAction.decide(
          EngineFiles.stimd(stimHome: stimHome), alive: EngineFiles.isAlive, deadlinePassed: Date() >= deadline)
        switch action {
        case .use(let record):
          use(record, owned: record.pid == process?.processIdentifier)
          return
        case .refuse(let text):
          return refuse(text)
        case .fail:
          failureKind = .noAnswer
          state = .failed(
            "stimd did not write \(abbreviatingHome(EngineFiles.runDirectory(stimHome: stimHome)))/stimd.json within \(Int(Self.startTimeout)) seconds.\(Self.logTail())"
          )
          return
        case .wait:
          try? await Task.sleep(for: .milliseconds(250))
        }
      }
    }
  }

  /// The environment stimd starts with: the launch environment with the Settings Stim home and overrides, so it waits
  /// for nothing. It discovers the toolchain for the commands it runs itself.
  private var launchEnvironment: [String: String] {
    var environment = settingsEnvironment
    if Bundle.main.bundleURL.pathExtension == "app" { environment["STIM_DESKTOP_APP"] = Bundle.main.bundlePath }
    return environment
  }

  /// Installs the engine on a Mac without one, with the managed Node runtime when the Mac has no Node 22.12 or later,
  /// and moves an older one forward when Desktop installed it. Nil, with a failed state, when it cannot.
  private func prepareEngine(generation current: Int) async -> EngineLaunch? {
    if let development = EngineLaunch.resolve(environment: settingsEnvironment), development.isDevelopment {
      return development
    }
    let root = engineRoot
    let need = EngineNeed.decide(
      pointer: EngineFiles.pointer(root), wanted: EngineInstall.wanted,
      installedByDesktop: UserDefaults.standard.bool(forKey: AppPreferences.Key.engineInstalledByDesktop))
    engine = need
    switch need {
    case .unreadable(let text):
      if current == generation { refuse(text) }
      return nil
    case .install(let version):
      guard await installEngine(version: version, generation: current) else { return nil }
    case .moveForward(_, automatic: true):
      await updateEngine(generation: current)
    case .ready(let pointer), .moveForward(let pointer, automatic: false), .pinned(let pointer, _):
      ManagedNode.prune(root, keep: pointer.node.map(\.path))
    }
    guard current == generation else { return nil }
    if case .install = need {
      engine = EngineNeed.decide(
        pointer: EngineFiles.pointer(root), wanted: EngineInstall.wanted, installedByDesktop: true)
    }
    guard FileManager.default.isExecutableFile(atPath: root.stimd) else {
      failureKind = .launchFailed
      state = .failed(
        "The Stim engine at \(abbreviatingHome(root.path)) has no bin/stimd. Run stim engine update, then Try Again.")
      return nil
    }
    return .installed(root)
  }

  private func installEngine(version: String, generation current: Int) async -> Bool {
    let environment = await engineEnvironment()
    let home = environment["HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? NSHomeDirectory()
    let root = engineRoot
    var node: NodeRuntime
    switch NodeChoice.decide(
      system: await NodeRuntime.probe(environment: environment, home: home), managed: ManagedNode.installed(root))
    {
    case .use(let found): node = found
    case .download:
      startDetail = "Installing Node.js \(ManagedNode.version) for the Stim engine"
      do {
        node = try await ManagedNode.install(root)
      } catch {
        return fail(.engineUnavailable, error.localizedDescription, generation: current)
      }
    }
    guard current == generation else { return false }
    startDetail = "Installing the Stim engine \(version)"
    defer { startDetail = nil }
    let install = EngineInstall.installRequest(version: version, node: node, environment: environment, home: home)
    let result = try? await install.run()
    guard let result, result.succeeded else {
      let detail =
        result.map { result in
          stderrTail(
            result.stderrText.split(whereSeparator: \.isNewline).filter { !$0.hasPrefix("npm notice") }
              .joined(separator: "\n"))
        } ?? ""
      return fail(
        .engineUnavailable, "Could not install the Stim engine \(version) with npx.\(detail.isEmpty ? "" : "\n\(detail)")",
        generation: current)
    }
    UserDefaults.standard.set(true, forKey: AppPreferences.Key.engineInstalledByDesktop)
    return current == generation
  }

  /// `stim engine update` through the engine; a failure leaves the older engine running.
  func updateEngine(generation current: Int? = nil) async {
    let environment = await engineEnvironment()
    startDetail = "Updating the Stim engine"
    defer { startDetail = nil }
    let update = EngineInstall.updateRequest(engineRoot, environment: environment, home: NSHomeDirectory())
    let result = try? await update.run()
    if result?.succeeded != true { DebugLog.warning(.server, "stim engine update failed: \(result?.stderrText ?? "")") }
    guard current == nil || current == generation else { return }
    engine = EngineNeed.decide(
      pointer: EngineFiles.pointer(engineRoot), wanted: EngineInstall.wanted,
      installedByDesktop: UserDefaults.standard.bool(forKey: AppPreferences.Key.engineInstalledByDesktop))
  }

  private func fail(_ kind: ServerFailureKind, _ message: String, generation current: Int) -> Bool {
    startDetail = nil
    guard current == generation else { return false }
    failureKind = kind
    state = .failed(message)
    return false
  }

  private func refuse(_ text: String) {
    retriesFailure = false
    failureKind = .unknownFormat
    state = .failed(text)
  }

  private func use(_ record: StimdRecord, owned: Bool) {
    self.record = record
    state = .running(ServerHealth(record: record, stimHome: stimHome), owned: owned)
  }

  func stop() {
    DebugLog.info(.server, "stop requested")
    generation += 1
    state = .off
  }

  /// stimd's network listener answered `net.ensure` on `port` for Desktop's connection; its `/health` gives Tailscale
  /// and route state.
  func netListening(_ port: Int) {
    guard netPort != port else { return }
    netPort = port
    refresh()
  }

  func setUpConnection() async -> String? {
    guard isRunning else { return "The Stim engine is not running. Try again." }
    guard !settingUpConnection else { return "Connection setup is already running. Try again." }
    settingUpConnection = true
    connectionError = nil
    defer { settingUpConnection = false }
    guard let client = ServerSession.shared.client, client.isOpen else {
      connectionError = "The local Desktop connection is not ready. Try again."
      return connectionError
    }
    do {
      _ = try await client.request("route.setup", [:])
      refresh()
    } catch {
      connectionError = error.localizedDescription
    }
    return connectionError
  }

  func pairPhone(control: Bool) async throws -> PairingCode {
    guard UserDefaults.standard.bool(forKey: AppPreferences.Key.servesPhones) else {
      throw ServerError(code: "not-connected", message: "Turn on Allow connections to pair a phone.")
    }
    let cli = await cli()
    guard isRunning, let port = netPort, case .ready(let before) = await StimServerCLI.health(port: port) else {
      throw ServerError(code: "not-connected", message: "Could not verify the phone connection. Try again.")
    }
    if before.loopbackOnly == true {
      throw ServerError(
        code: "not-connected",
        message: "The Stim engine serves this Mac only, so a phone could not connect. Turn on Allow connections and try again."
      )
    }
    if before.tailscale.isRunning && before.route?.state != "routed" {
      if let route = before.route, route.state == "unknown" {
        throw ServerError(
          code: "not-connected",
          message:
            "The server is running, but its private Tailscale route could not be verified: \(route.reason ?? "the route check did not answer"). Try again."
        )
      }
      throw ServerError(
        code: "not-connected",
        message: "Pairing needs a verified tailnet-only route. Turn on serving first.")
    }
    let code = try await cli.pair(port: port, control: control)
    if before.tailscale.isRunning || !code.isLocalOnly {
      guard case .ready(let after) = await StimServerCLI.health(port: port), after.route?.state == "routed",
        let dnsName = after.tailscale.dnsName, code.qr.endpoint == after.route?.endpoint(dnsName: dnsName)
      else {
        throw ServerError(
          code: "not-connected", message: "The phone connection changed or could not be verified. Try again.")
      }
    }
    return code
  }

  /// Checks that the recorded stimd still runs, starting again when it is gone, and reads its network listener's
  /// health when it has one.
  func refresh() {
    if case .notReady = state {} else { reloadDevices() }
    let owned: Bool
    switch state {
    case .running(_, let value), .notReady(_, let value): owned = value
    case .off, .starting, .failed: return
    }
    let current = generation
    Task {
      guard case .found(let found) = EngineFiles.stimd(stimHome: stimHome), EngineFiles.isAlive(found), found == record else {
        guard current == generation else { return }
        DebugLog.info(.server, "stimd exited; starting again")
        generation += 1
        state = .off
        start()
        return
      }
      guard let port = netPort else { return }
      let probe = await StimServerCLI.health(port: port)
      guard current == generation, isResponding else { return }
      switch probe {
      case .ready(let health):
        state = .running(health, owned: owned)
        if health.nativeViewerOpened == true { NativeViewerPermissions.shared.viewerOpened(serverOwned: owned) }
      case .notReady(let startup, _):
        state = .notReady(startup, owned: owned)
      case nil:
        netPort = nil
        state = .running(ServerHealth(record: found, stimHome: stimHome), owned: owned)
      }
    }
  }

  var pairedPhoneCount: Int? {
    guard case .running = state, hasDeviceList, devicesError == nil else { return nil }
    return devices.filter(\.isPhone).count
  }

  func reloadDevices() {
    let epoch = devicesEpoch
    let current = generation
    let running = isRunning
    Task {
      let cli = await cli()
      guard epoch == devicesEpoch, current == generation else { return }
      let result = await Result.awaiting { try await cli.devices() }
      guard epoch == devicesEpoch, current == generation else { return }
      switch result {
      case .success(let devices):
        hasDeviceList = running
        self.devices = devices.map { device in
          guard let control = pendingGrants[device.id] else { return device }
          var device = device
          device.capabilities = Self.capabilities(control: control)
          return device
        }
        .sorted { $0.pairedAt > $1.pairedAt }
        devicesError = nil
        FeatureFlags.seed(servesPhones: false, pairedPhones: self.devices.filter(\.isPhone).count)
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

  func revoke(_ devices: [PairedDevice]) {
    Task {
      let cli = await cli()
      changeError = nil
      for device in devices {
        if case .failure(let error) = await Result.awaiting({ try await cli.revoke(device.id) }), changeError == nil {
          changeError = error.localizedDescription
        }
      }
      devicesEpoch += 1
      reloadDevices()
    }
  }

  func rename(_ devices: [PairedDevice], to name: String) {
    Task {
      let cli = await cli()
      changeError = nil
      for device in devices {
        if case .failure(let error) = await Result.awaiting({ try await cli.rename(device.id, to: name) }) {
          changeError = error.localizedDescription
          break
        }
      }
      devicesEpoch += 1
      reloadDevices()
    }
  }

  private func exited(_ status: Int32, generation: Int) {
    guard generation == self.generation else { return }
    process = nil
    guard case .starting = state else { return }
    DebugLog.info(.server, "stimd exited status=\(status) while starting")
  }

  /// Where the stimd Desktop starts writes its output: beside Desktop's own debug log, so it outlives the app.
  static var logURL: URL {
    let name = DebugLog.logURL.lastPathComponent
    return DebugLog.logURL.deletingLastPathComponent().appendingPathComponent("stimd" + name.dropFirst("Desktop".count))
  }

  private static func logTail() -> String {
    guard let text = try? String(contentsOf: logURL, encoding: .utf8) else { return "" }
    let tail = text.split(whereSeparator: \.isNewline).suffix(3).joined(separator: "\n")
    return tail.isEmpty ? "" : "\n\(tail)"
  }

  /// Starts stimd detached from Desktop's lifetime: no input, output appended to `logURL`, which restarts past 2 MB.
  private static func launch(
    _ command: (program: String, arguments: [String]), environment: [String: String],
    onExit: @escaping @Sendable (Int32) -> Void
  ) throws -> Process {
    let files = FileManager.default
    let log = logURL
    try files.createDirectory(at: log.deletingLastPathComponent(), withIntermediateDirectories: true)
    if let size = (try? files.attributesOfItem(atPath: log.path))?[.size] as? Int, size > 2_000_000 {
      try? files.removeItem(at: log)
    }
    if !files.fileExists(atPath: log.path) {
      files.createFile(atPath: log.path, contents: nil, attributes: [.posixPermissions: 0o600])
    }
    let output = try FileHandle(forWritingTo: log)
    output.seekToEndOfFile()
    defer { try? output.close() }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: command.program)
    process.arguments = command.arguments
    process.environment = environment
    process.currentDirectoryURL = URL(fileURLWithPath: NSHomeDirectory())
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = output
    process.standardError = output
    process.terminationHandler = { onExit($0.terminationStatus) }
    DebugLog.info(.server, "starting stimd: \(command.program) \(command.arguments.joined(separator: " "))")
    try process.run()
    return process
  }
}
