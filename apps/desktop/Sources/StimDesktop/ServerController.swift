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

  private var environment: Task<[String: String], Never>?
  private var process: Process?
  private var output: [String] = []
  private var generation = 0

  var port: Int { StimServerCLI.defaultPort }

  func configure(environment: Task<[String: String], Never>) {
    self.environment = environment
    if UserDefaults.standard.bool(forKey: AppPreferences.Key.servesPhones) { start() }
  }

  func cli() async -> StimServerCLI {
    StimServerCLI(
      environment: await environment?.value ?? ProcessInfo.processInfo.environment,
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
    guard case .running(_, owned: true) = state, let process else { return }
    stop()
    Task.detached {
      Self.waitForExit(process)
      await MainActor.run { self.start() }
    }
  }

  func refresh() {
    if case .running(_, owned: false) = state {
      Task {
        if await StimServerCLI.health(port: port) == nil, case .running(_, owned: false) = state {
          state = .off
          if UserDefaults.standard.bool(forKey: AppPreferences.Key.servesPhones) { start() }
        }
      }
    }
    reloadDevices()
  }

  func reloadDevices() {
    Task {
      let cli = await cli()
      let result = await Task.detached { Result { try cli.devices() } }.value
      switch result {
      case .success(let devices):
        self.devices = devices.sorted { $0.pairedAt > $1.pairedAt }
        devicesError = nil
      case .failure(let error):
        devicesError = error.localizedDescription
      }
    }
  }

  func revoke(_ device: PairedDevice) {
    Task {
      let cli = await cli()
      if case .failure(let error) = await Task.detached(operation: { Result { try cli.revoke(device.id) } }).value {
        devicesError = error.localizedDescription
      }
      reloadDevices()
    }
  }

  func stopForQuit() {
    guard let process else { return }
    generation += 1
    terminate()
    Self.waitForExit(process)
  }

  private func terminate() {
    if let process, process.isRunning { process.terminate() }
    process = nil
  }

  private nonisolated static func waitForExit(_ process: Process) {
    let deadline = Date().addingTimeInterval(3)
    while process.isRunning, Date() < deadline { usleep(50_000) }
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
