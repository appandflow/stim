import Foundation
import Observation
import StimKit

@MainActor @Observable
final class BuildMachinesModel {
  struct Check {
    enum Problem {
      case unsupported
      case failed(String)
    }

    var statuses: [BuildMachineStatus]
    var hosts: [BuildMachineStatus]?
    var problem: Problem?
  }

  /// Whether Tailscale is running, once checked.
  private(set) var tailscaleRunning: Bool?
  private(set) var macs: [TailnetMac]?
  private(set) var working: String?
  /// What the running action on `working` is doing, such as "Asking Bounce MBP\u{2026}".
  private(set) var progress: String?
  private(set) var writeFailure: String?
  private(set) var runs = 0
  private(set) var stats = Fetched<MachineStats>()
  private(set) var updates: [String: MachineUpdatePhase] = [:]
  private var statusRefreshes: [String: Task<Void, Never>] = [:]
  private var hostingCheckedAt: [String: Date] = [:]
  private var checks: [String: Check] = [:]

  let settings: MachineSettingsStore
  private let cli: Task<StimCLI, Never>
  private let statsReader: StatsReader
  @ObservationIgnored private var latestStatsRun = 0
  @ObservationIgnored private var autoUpdated: Set<String> = []
  private let request: @MainActor (String, [String: JSONValue]) async throws -> JSONValue
  private let now: () -> Date
  private let machineAccess: @MainActor (String, Bool) async throws -> DoctorReport
  private let pollInterval: Duration
  private let unreachableLimit: Duration

  init(
    cli: Task<StimCLI, Never>, settings: MachineSettingsStore, statsReader: StatsReader,
    pollInterval: Duration = .seconds(2), unreachableLimit: Duration = .seconds(300),
    now: @escaping () -> Date = Date.init,
    machineAccess: (@MainActor (String, Bool) async throws -> DoctorReport)? = nil,
    request: @escaping @MainActor (String, [String: JSONValue]) async throws -> JSONValue = BuildMachinesModel.localRequest
  ) {
    self.cli = cli
    self.settings = settings
    self.statsReader = statsReader
    self.pollInterval = pollInterval
    self.unreachableLimit = unreachableLimit
    self.request = request
    self.now = now
    self.machineAccess = machineAccess ?? { try await cli.value.machineAccess(cwd: $0, ask: $1) }
  }

  static func localRequest(_ method: String, _ params: [String: JSONValue]) async throws -> JSONValue {
    guard let client = ServerSession.shared.client, client.isOpen else {
      throw ServerError(code: "not-connected", message: "The local Desktop connection is not ready. Try again.")
    }
    return try await client.request(method, params)
  }

  /// Asks `entry`'s stim-server, through the local one, to update to this Mac's build, and follows it until it ends.
  func update(_ entry: String, checkout: String?) async {
    guard updates[entry]?.isDone ?? true else { return }
    updates[entry] = .sending(0)
    let startedAt: String
    do {
      let result = try await request("machines.update.start", ["machine": .string(entry)])
      guard case .object(let started) = result, let at = started["startedAt"]?.string else {
        throw ServerError(code: "bad-reply", message: "stim-server did not say when the update started.")
      }
      startedAt = at
    } catch {
      updates[entry] = .failed(error.localizedDescription)
      return
    }
    let deadline = ContinuousClock.now + .seconds(45 * 60)
    var unreachableSince: ContinuousClock.Instant?
    var idleSince: ContinuousClock.Instant?
    while !Task.isCancelled {
      try? await Task.sleep(for: pollInterval)
      var phase: MachineUpdatePhase
      var unreachable: String?
      do {
        let result = try await request("machines.update.status", ["machine": .string(entry)])
        let status = try JSONDecoder().decode(MachineUpdateStatus.self, from: JSONEncoder().encode(result))
        phase = MachineUpdatePhase.from(status, startedAt: startedAt)
        unreachable = status.remote == nil ? status.unreachable : nil
        if status.remote != nil, phase == .restarting {
          let since = idleSince ?? ContinuousClock.now
          idleSince = since
          if ContinuousClock.now - since > .seconds(240) {
            phase = .failed(
              "\(entry) ended the update without recording an outcome. There, see ~/Library/Application Support/Stim/services/<label>/update.log."
            )
          }
        } else {
          idleSince = nil
        }
      } catch {
        phase = .restarting
        idleSince = nil
        unreachable = error.localizedDescription
      }
      if let unreachable, !phase.isDone {
        let since = unreachableSince ?? ContinuousClock.now
        unreachableSince = since
        if ContinuousClock.now - since > unreachableLimit {
          phase = .failed("\(entry) stopped answering: \(unreachable)")
        }
      } else {
        unreachableSince = nil
      }
      updates[entry] = phase
      if phase.isDone { break }
      if ContinuousClock.now > deadline {
        updates[entry] = .failed(
          "No outcome after 45 minutes. On \(entry), run stim-server service status to see what it runs.")
        break
      }
    }
    await refreshStatuses(checkout: checkout, ask: false)
  }

  private func updateAutomatically(_ statuses: [BuildMachineStatus], checkout: String?) {
    guard UserDefaults.standard.bool(forKey: AppPreferences.Key.updatesBuildMachines) else { return }
    for status in statuses where needsStimUpdate(status) {
      let key = ([status.machine] + (status.reasons ?? [])).joined(separator: "\n")
      guard !autoUpdated.contains(key), updates[status.machine]?.isDone ?? true else { continue }
      autoUpdated.insert(key)
      Task { await update(status.machine, checkout: checkout) }
    }
  }

  private(set) var sampleExists = FileManager.default.fileExists(atPath: WizardSample.desktop.folder.path)

  func deleteSample() async {
    let sample = SampleBuildModel(cli: cli)
    let location = sample.dependencies.sample
    guard location.permitsRemoval(location.folder) else {
      writeFailure = "Refused to remove a path outside the sample folder."
      return
    }
    do {
      try await sample.removeSample()
      sampleExists = false
      writeFailure = nil
    } catch { writeFailure = error.localizedDescription }
  }

  var entries: [String]? {
    settings.payload.map { $0.entry("offload.machines")?.value.strings ?? [] }
  }

  func addMachine(checkout: String?) -> AddMachineModel {
    let model = AddMachineModel(cli: cli, settings: settings, checkout: checkout)
    model.machines = self
    return model
  }

  var isBusy: Bool { working != nil || runs > 0 }

  func check(in checkout: String?) -> Check? { checkout.flatMap { checks[$0] } }

  func approvedHostingMachines(in checkout: String) -> [String]? {
    checks[checkout]?.hosts?.filter { $0.state == .approved }.map(\.machine)
  }

  func refreshHostingMachines(checkout: String) async {
    guard statusRefreshes[checkout] == nil else { return }
    if let checkedAt = hostingCheckedAt[checkout], now().timeIntervalSince(checkedAt) <= 300 { return }
    await refreshStatuses(checkout: checkout, ask: false)
  }

  func refreshHostingMachinesWaiting(checkout: String) async {
    if let pending = statusRefreshes[checkout] { return await pending.value }
    await refreshHostingMachines(checkout: checkout)
  }

  var settingsFailure: String? {
    if let error = settings.error { return error }
    guard let payload = settings.payload, payload.entry("offload.machines") == nil else { return nil }
    return "This stim has no offload.machines setting; update it."
  }

  func refresh(checkout: String?) async {
    sampleExists = FileManager.default.fileExists(atPath: WizardSample.desktop.folder.path)
    await settings.refresh()
    async let placements: Void = (entries ?? []).isEmpty ? () : refreshPlacements()
    await refreshStatuses(checkout: checkout, ask: false)
    await placements
  }

  private func refreshPlacements() async {
    latestStatsRun += 1
    let run = latestStatsRun
    let result = await Result.awaiting { try await statsReader.machine() }
    guard run == latestStatsRun, !Task.isCancelled else { return }
    stats.record(result)
  }

  func refreshTailnet() async {
    let environment = await cli.value.environment
    let found = await Task.detached { Tailnet.status(environment: environment).flatMap(Tailnet.macs(statusJSON:)) }.value
    macs = found ?? []
  }

  func load(checkout: String?) async {
    sampleExists = FileManager.default.fileExists(atPath: WizardSample.desktop.folder.path)
    async let settingsRead: Void = settings.refresh()
    await checkTailscale()
    await settingsRead
    await refreshStatuses(checkout: checkout, ask: false)
  }

  func checkTailscale() async {
    let environment = await cli.value.environment
    let status = await Task.detached { Tailnet.status(environment: environment) }.value
    let reachability = Tailnet.reachability(statusJSON: status, peer: nil)
    tailscaleRunning = reachability != .tailscaleMissing && reachability != .tailscaleStopped
  }

  func refreshStatuses(checkout: String?, ask: Bool) async {
    guard let checkout else { return }
    if let pending = statusRefreshes[checkout] {
      await pending.value
      if ask { await refreshStatuses(checkout: checkout, ask: true) }
      return
    }
    let task = Task {
      await fetchStatuses(checkout: checkout, ask: ask)
      hostingCheckedAt[checkout] = now()
      statusRefreshes[checkout] = nil
    }
    statusRefreshes[checkout] = task
    await task.value
  }

  private func fetchStatuses(checkout: String, ask: Bool) async {
    runs += 1
    defer { runs -= 1 }
    let result = await Result.awaiting { try await machineAccess(checkout, ask) }
    guard !Task.isCancelled else { return }
    switch result {
    case .success(let report):
      checks[checkout] = Check(
        statuses: report.buildMachines ?? [], hosts: report.deviceHosts,
        problem: report.buildMachines == nil ? .unsupported : nil)
      updateAutomatically(report.buildMachines ?? [], checkout: checkout)
    case .failure(let error):
      checks[checkout] = Check(
        statuses: check(in: checkout)?.statuses ?? [], hosts: check(in: checkout)?.hosts,
        problem: .failed(error.localizedDescription))
    }
  }

  func ask(_ entry: String, checkout: String?) async {
    working = entry
    progress = "Asking \(entry)\u{2026}"
    await refreshStatuses(checkout: checkout, ask: true)
    working = nil
    progress = nil
  }

  func remove(_ entry: String, checkout: String?) async {
    let repins = check(in: checkout)?.statuses.first { $0.machine == entry }?.state == .nodeChanged
    await write(entry, value: OffloadMachines.removing(entry, from: entries ?? []), ask: repins, checkout: checkout)
  }

  private func write(_ entry: String, value: String?, ask: Bool, checkout: String?) async {
    working = entry
    progress = "Removing \(entry)\u{2026}"
    defer { progress = nil }
    let result = await settings.write("offload.machines", value: value, scope: .machine, cwd: NSHomeDirectory())
    switch result {
    case .success(.written):
      writeFailure = nil
      let others = checks.keys.filter { $0 != checkout }
      await refreshStatuses(checkout: checkout, ask: ask)
      for other in others { await refreshStatuses(checkout: other, ask: false) }
    case .success(.refused(let refusal)):
      writeFailure = [refusal.message, refusal.remedy].compactMap { $0 }.joined(separator: " ")
    case .failure(let error): writeFailure = error.localizedDescription
    }
    working = nil
  }
}
