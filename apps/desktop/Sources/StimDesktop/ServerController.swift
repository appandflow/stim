import Foundation
import StimKit

@MainActor
final class ServerController: ObservableObject {
  enum State: Equatable {
    case off
    case starting
    case running(ServerHealth, owned: Bool)
    case failed(String)
  }

  static let shared = ServerController()
  static let startTimeout: TimeInterval = 15

  @Published private(set) var state = State.off
  @Published private(set) var devices: [PairedDevice] = []
  @Published private(set) var devicesError: String?
  @Published private(set) var changeError: String?
  @Published private(set) var pendingGrants: [String: Bool] = [:]

  private var environment: Task<[String: String], Never>?
  private var process: Process?
  private var exiting: Process?
  private var output: [String] = []
  private var generation = 0
  private var devicesEpoch = 0

  var port: Int { StimServerCLI.defaultPort }

  var isRunning: Bool {
    if case .running = state { return true }
    return false
  }

  var canRestart: Bool {
    if case .running(_, owned: true) = state { return true }
    return false
  }

  func configure(environment: Task<[String: String], Never>) {
    self.environment = environment
    if UserDefaults.standard.bool(forKey: AppPreferences.Key.servesPhones) { start() }
  }

  func cli() async -> StimServerCLI {
    var environment = await environment?.value ?? ProcessInfo.processInfo.environment
    if case .running(let health, _) = state { environment["STIM_HOME"] = health.stimHome }
    return StimServerCLI(
      environment: environment,
      override: UserDefaults.standard.string(forKey: AppPreferences.Key.stimServerExecutable))
  }

  func start() {
    switch state {
    case .starting, .running: return
    case .off, .failed: break
    }
    generation += 1
    let current = generation
    state = .starting
    Task {
      if let exiting {
        await Task.detached { Self.waitForExit(exiting) }.value
        self.exiting = nil
      }
      guard current == generation else { return }
      if let health = await StimServerCLI.health(port: port) {
        if current == generation { state = .running(health, owned: false) }
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
      while Date() < deadline {
        try? await Task.sleep(for: .milliseconds(250))
        guard current == generation, process != nil else { return }
        if let health = await StimServerCLI.health(port: port) {
          if current == generation { state = .running(health, owned: true) }
          return
        }
      }
      guard current == generation else { return }
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

  func refresh() {
    if case .running(_, let owned) = state {
      let current = generation
      Task {
        let health = await StimServerCLI.health(port: port)
        guard current == generation, isRunning else { return }
        if let health {
          state = .running(health, owned: owned)
        } else if !owned {
          state = .off
          if UserDefaults.standard.bool(forKey: AppPreferences.Key.servesPhones) { start() }
        }
      }
    }
    reloadDevices()
  }

  func reloadDevices() {
    let epoch = devicesEpoch
    Task {
      let cli = await cli()
      let result = await Task.detached { Result { try cli.devices() } }.value
      guard epoch == devicesEpoch else { return }
      switch result {
      case .success(let devices):
        self.devices = devices.map { device in
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
      let result = await Task.detached(operation: { Result { try cli.grant(device.id, control: control) } }).value
      pendingGrants[device.id] = nil
      devicesEpoch += 1
      if case .failure(let error) = result { changeError = error.localizedDescription } else { changeError = nil }
      reloadDevices()
    }
  }

  private static func capabilities(control: Bool) -> [String] {
    control ? ["read", "control"] : ["read"]
  }

  func revoke(_ device: PairedDevice) {
    Task {
      let cli = await cli()
      switch await Task.detached(operation: { Result { try cli.revoke(device.id) } }).value {
      case .success:
        changeError = nil
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
