import Foundation
import Observation
import StimKit
import StimStores

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
    var findings: [DoctorReport.Finding] = []
  }

  /// The Android doctor report of one checkout, read when a machine's page opens.
  struct AndroidCheck {
    var statuses: [BuildMachineStatus] = []
    var findings: [DoctorReport.Finding] = []
    var readAt: Date?
    var failure: String?
  }

  /// Whether Tailscale is running, once checked.
  private(set) var tailscaleRunning: Bool?
  private(set) var peers: [TailnetMac]?
  private(set) var androidOnlyNames: Set<String> = []
  private(set) var working: String?
  private(set) var progress: String?
  private(set) var writeFailure: String?
  private(set) var runs = 0
  private(set) var stats = Fetched<MachineStats>()
  private(set) var updates: [String: MachineUpdatePhase] = [:]
  private(set) var localStim: LocalStim?
  private var remoteServers: [String: MachineUpdateStatus] = [:]
  private var statusRefreshes: [String: Task<Void, Never>] = [:]
  private var refreshedEntries: [String: [String]] = [:]
  private var hostingCheckedAt: [String: Date] = [:]
  private var checks: [String: Check] = [:]
  private(set) var androidChecks: [String: AndroidCheck] = [:]
  private var serverVersions: [String: String] = [:]
  @ObservationIgnored private var androidLoads: [String: Task<Void, Never>] = [:]
  @ObservationIgnored private var lastMachineCheck: BuildMachineCheck?
  @ObservationIgnored private var localMissing = false
  @ObservationIgnored private var settingsReadAt: Date?

  let settings: MachineSettingsStore
  private let cli: Task<StimCLI, Never>
  private let statsReader: StatsReader
  @ObservationIgnored private var latestStatsRun = 0
  @ObservationIgnored private var autoUpdated: Set<String> = []
  private let request: @MainActor (String, [String: JSONValue]) async throws -> JSONValue
  private let readLocalStim: @MainActor () async -> LocalStim?
  private let now: () -> Date
  private let machineAccess: @MainActor (String, Bool) async throws -> DoctorReport
  private let androidDoctor: @MainActor (String) async throws -> DoctorReport
  private let serverVersion: @MainActor (String, Int) async -> String?
  private let pollInterval: Duration
  private let unreachableLimit: Duration

  init(
    cli: Task<StimCLI, Never>, settings: MachineSettingsStore, statsReader: StatsReader,
    pollInterval: Duration = .seconds(2), unreachableLimit: Duration = .seconds(300),
    now: @escaping () -> Date = Date.init,
    machineAccess: (@MainActor (String, Bool) async throws -> DoctorReport)? = nil,
    androidDoctor: (@MainActor (String) async throws -> DoctorReport)? = nil,
    serverVersion: @escaping @MainActor (String, Int) async -> String? = { await Tailnet.health(dnsName: $0, port: $1)?.version },
    localStim: @escaping @MainActor () async -> LocalStim? = BuildMachinesModel.currentLocalStim,
    request: @escaping @MainActor (String, [String: JSONValue]) async throws -> JSONValue = BuildMachinesModel.localRequest
  ) {
    self.cli = cli
    self.settings = settings
    self.statsReader = statsReader
    self.pollInterval = pollInterval
    self.unreachableLimit = unreachableLimit
    self.request = request
    self.readLocalStim = localStim
    self.now = now
    let reader = MachineAccessReader(cli: cli) { ServerSession.shared.statsConnection }
    self.machineAccess = machineAccess ?? { try await reader.report(cwd: $0, ask: $1) }
    self.serverVersion = serverVersion
    self.androidDoctor =
      androidDoctor ?? { cwd in
        try await readPlatformDoctor(
          cli: await cli.value, connection: ServerSession.shared.statsConnection, cwd: cwd, platform: "android")
      }
  }

  static func localRequest(_ method: String, _ params: [String: JSONValue]) async throws -> JSONValue {
    guard let client = ServerSession.shared.client, client.isOpen else {
      throw ServerError(code: "not-connected", message: "The local Desktop connection is not ready. Try again.")
    }
    return try await client.request(method, params)
  }

  static func currentLocalStim() async -> LocalStim? {
    guard let client = ServerSession.shared.client, case .open(let hello) = client.state else { return nil }
    let server = await ServerController.shared.cli()
    let script = server.launcher?.script ?? server.executable
    var adopted = false
    if case .running(_, owned: false) = ServerController.shared.state { adopted = true }
    return LocalStim(
      version: hello.server.version, isRelease: adopted || (script.map(LocalStim.isInstalledPackage) ?? false))
  }

  func install(for status: BuildMachineStatus) -> StimInstall? {
    stimInstall(for: status, remote: remoteServers[status.machine], local: localStim)
  }

  func readRemoteServers(_ statuses: [BuildMachineStatus]) async {
    localStim = await readLocalStim()
    localMissing = localStim == nil && statuses.contains(where: needsStimUpdate)
    for status in statuses.filter(needsStimUpdate) where updates[status.machine]?.isDone ?? true {
      do {
        let result = try await request("machines.update.status", ["machine": .string(status.machine)])
        remoteServers[status.machine] = try decodeReporting(MachineUpdateStatus.self, from: result, source: .server)
      } catch {
        remoteServers[status.machine] = MachineUpdateStatus(unreachable: error.localizedDescription)
      }
    }
  }

  /// Asks `entry`'s stim-server, through the local one, to update to this Mac's build, and follows it until it ends.
  func update(_ entry: String, checkout: String?, status known: BuildMachineStatus? = nil) async {
    guard updates[entry]?.isDone ?? true else { return }
    guard let status = known ?? check(in: checkout)?.statuses.first(where: { $0.machine == entry }),
      install(for: status) == .install
    else { return }
    updates[entry] = .sending(0)
    let expectedBuild = check(in: checkout)?.statuses.first { $0.machine == entry }.flatMap(stimBuildHere)
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
        let status = try decodeReporting(MachineUpdateStatus.self, from: result, source: .server)
        phase = MachineUpdatePhase.from(status, startedAt: startedAt, expectedBuild: expectedBuild)
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
    for status in statuses where install(for: status) == .install {
      let key = ([status.machine] + (status.reasons ?? [])).joined(separator: "\n")
      guard !autoUpdated.contains(key), updates[status.machine]?.isDone ?? true else { continue }
      autoUpdated.insert(key)
      Task { await update(status.machine, checkout: checkout) }
    }
  }

  func keepMachinesCurrent(status: StatusStore) {
    Task { [weak self, weak status] in
      while !Task.isCancelled {
        guard let self, let status else { return }
        let candidates = doctorCheckouts(status.payload?.environments ?? [], project: status.project(ofPath:)).map(\.path)
        let enabled = UserDefaults.standard.bool(forKey: AppPreferences.Key.updatesBuildMachines)
        let cli = await cli.value
        let launcher = cli.launcher
        let executable = cli.executable
        let (checkout, identity) = await Task.detached {
          (
            candidates.first { FileManager.default.fileExists(atPath: $0) },
            (launcher?.script ?? executable).flatMap(Self.identity(ofExecutable:))
          )
        }.value
        let current = now()
        if enabled, checkout != nil, !isBusy,
          settingsReadAt.map({ current.timeIntervalSince($0) >= BuildMachineCheckState.interval }) ?? true
        {
          settingsReadAt = current
          await settings.refresh()
        }
        await checkMachinesIfDue(checkout: checkout, enabled: enabled, identity: identity)
        try? await Task.sleep(for: .seconds(30))
      }
    }
  }

  nonisolated private static func identity(ofExecutable path: String) -> String? {
    let resolved = URL(fileURLWithPath: path).resolvingSymlinksInPath().path
    return (try? FileManager.default.attributesOfItem(atPath: resolved)[.modificationDate] as? Date)
      .map { "\(resolved)@\($0.timeIntervalSince1970)" }
  }

  func checkMachinesIfDue(checkout: String?, enabled: Bool, identity: String?) async {
    guard enabled else {
      lastMachineCheck = nil
      return
    }
    guard !isBusy, let checkout, let identity else { return }
    let due = shouldCheckBuildMachines(
      BuildMachineCheckState(
        entries: entries, checkout: checkout, last: lastMachineCheck, identity: identity, now: now()))
    guard due else { return }
    lastMachineCheck = BuildMachineCheck(at: now(), identity: identity, entries: entries ?? [])
    await refreshStatuses(checkout: checkout, ask: false)
    if localMissing { lastMachineCheck = nil }
  }

  var entries: [String]? {
    settings.payload.map { $0.entry("remote.machines")?.value.strings ?? [] }
  }

  var settingsReadFailure: String? { entries == nil ? settings.error : nil }

  var poolDisabled: [String: [String]]? {
    guard let build = settings.entry("remote.buildPoolDisabled")?.value.strings,
      let device = settings.entry("remote.devicePoolDisabled")?.value.strings
    else { return nil }
    return ["build": build, "device": device]
  }

  func setPool(_ role: String, machine: String, enabled: Bool) async {
    guard !isBusy, let disabled = poolDisabled?[role] else { return }
    working = machine
    defer { working = nil }
    let value = enabled ? OffloadMachines.removing(machine, from: disabled) : OffloadMachines.adding(machine, to: disabled)
    let result = await settings.write("remote.\(role)PoolDisabled", value: value, scope: .machine, cwd: NSHomeDirectory())
    switch result {
    case .success(.written): writeFailure = nil
    case .success(.refused(let refusal)):
      writeFailure = [refusal.message, refusal.remedy].compactMap { $0 }.joined(separator: " ")
    case .failure(let error): writeFailure = error.localizedDescription
    }
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
    guard let payload = settings.payload, payload.entry("remote.machines") == nil else { return nil }
    return "This stim has no remote.machines setting; update it."
  }

  func refresh(checkout: String?) async {
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
    let status = await Task.detached { Tailnet.status(environment: environment) }.value
    peers = status.flatMap(Tailnet.buildPeers(statusJSON:)) ?? []
    androidOnlyNames = Set(
      (status.map(Tailnet.peers(statusJSON:)) ?? []).filter(\.mac.buildsAndroidOnly).flatMap { [$0.mac.machine, $0.mac.dnsName] })
  }

  func load(checkout: String?) async {
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
      let started = refreshedEntries[checkout]
      await pending.value
      if ask || started != entries { await refreshStatuses(checkout: checkout, ask: ask) }
      return
    }
    refreshedEntries[checkout] = entries
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
    localMissing = false
    var result = await Result.awaiting { try await machineAccess(checkout, ask) }
    if ask, case .success(let asked) = result, let refreshed = try? await machineAccess(checkout, false) {
      result = .success(asked.refreshingApproved(from: refreshed))
    }
    guard !Task.isCancelled else { return }
    switch result {
    case .success(let report):
      checks[checkout] = Check(
        statuses: report.remoteMachines ?? [], hosts: report.deviceHosts,
        problem: report.remoteMachines == nil ? .unsupported : nil, findings: report.findings)
      await readRemoteServers(report.remoteMachines ?? [])
      guard !Task.isCancelled else { return }
      updateAutomatically(report.remoteMachines ?? [], checkout: checkout)
    case .failure(let error):
      checks[checkout] = Check(
        statuses: check(in: checkout)?.statuses ?? [], hosts: check(in: checkout)?.hosts,
        problem: .failed(error.localizedDescription), findings: check(in: checkout)?.findings ?? [])
    }
  }

  /// Reads what only the machine's page shows: the Android doctor report, which is slower than the list's, and the
  /// version its stim-server reports. The list's poll never calls it.
  /// Returns false while the list's report has no approved status for the machine yet, so a caller tries again soon.
  @discardableResult
  func loadDetails(_ entry: String, checkout: String?) async -> Bool {
    guard let checkout, let status = check(in: checkout)?.statuses.first(where: { $0.machine == entry }),
      status.state == .approved
    else { return false }
    async let android: Void = loadAndroid(checkout: checkout)
    async let version: Void = loadServerVersion(entry, status: status)
    _ = await (android, version)
    return true
  }

  private func loadAndroid(checkout: String) async {
    if let running = androidLoads[checkout] { return await running.value }
    if let readAt = androidChecks[checkout]?.readAt, now().timeIntervalSince(readAt) < 30 { return }
    let task = Task {
      let result = await Result.awaiting { try await androidDoctor(checkout) }
      androidLoads[checkout] = nil
      var next = androidChecks[checkout] ?? AndroidCheck()
      switch result {
      case .success(let report):
        next.statuses = report.remoteMachines ?? []
        next.findings = report.findings
        next.failure = report.remoteMachines == nil ? "This stim does not report remote machines; update it." : nil
        next.readAt = now()
      case .failure(let error): next.failure = error.localizedDescription
      }
      androidChecks[checkout] = next
    }
    androidLoads[checkout] = task
    await task.value
  }

  private func loadServerVersion(_ entry: String, status: BuildMachineStatus) async {
    guard let dnsName = status.dnsName else { return }
    let port = entry.split(separator: ":").dropFirst().first.flatMap { Int($0) } ?? Tailnet.servePort
    if let version = await serverVersion(dnsName, port) { serverVersions[entry] = version }
  }

  func detail(for entry: String, checkout: String?) -> MachineDetail {
    let check = checkout.flatMap { checks[$0] }
    let status = check?.statuses.first { $0.machine == entry }
    var input = MachineDetail.Input(entry: entry, status: status)
    input.findings = check?.findings ?? []
    input.host = check?.hosts?.first { OffloadMachines.name($0.machine) == OffloadMachines.name(entry) }
    input.hostsSimulators = !androidOnlyNames.contains(OffloadMachines.name(entry))
    input.hostsKnown = check?.hosts != nil
    if let status {
      input.install = install(for: status)
      input.update = updates[entry]
      if status.state == .approved, let checkout {
        let android = androidChecks[checkout]
        if let failure = android?.failure {
          input.android = .failed(failure)
        } else if android?.readAt == nil {
          input.android = .loading
        } else if let android {
          input.android = .loaded(android.statuses.first { $0.machine == entry }, android.findings)
        }
      }
    }
    input.thisMacVersion = localStim?.version
    input.serverVersion = serverVersions[entry] ?? remoteServers[entry]?.remote?.server?.version
    return MachineDetail(input)
  }

  func ask(_ entry: String, checkout: String?) async {
    working = entry
    progress = "Asking \(entry)\u{2026}"
    await refreshStatuses(checkout: checkout, ask: true)
    working = nil
    progress = nil
  }

  func remove(_ entry: String, checkout: String?) async {
    let repins = check(in: checkout)?.statuses.first { $0.machine == entry }?.state == .keyChanged
    await write(entry, value: OffloadMachines.removing(entry, from: entries ?? []), ask: repins, checkout: checkout)
  }

  func move(_ entry: String, by offset: Int) async {
    guard !isBusy, let value = OffloadMachines.moving(entry, by: offset, in: entries ?? []) else { return }
    working = entry
    defer { working = nil }
    switch await settings.write("remote.machines", value: value, scope: .machine, cwd: NSHomeDirectory()) {
    case .success(.written): writeFailure = nil
    case .success(.refused(let refusal)):
      writeFailure = [refusal.message, refusal.remedy].compactMap { $0 }.joined(separator: " ")
    case .failure(let error): writeFailure = error.localizedDescription
    }
  }

  private func write(_ entry: String, value: String?, ask: Bool, checkout: String?) async {
    working = entry
    progress = "Removing \(entry)\u{2026}"
    defer { progress = nil }
    let result = await settings.write("remote.machines", value: value, scope: .machine, cwd: NSHomeDirectory())
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

struct BuildMachineCheck: Equatable {
  var at: Date
  var identity: String?
  var entries: [String]
}

struct BuildMachineCheckState {
  var entries: [String]?
  var checkout: String?
  var last: BuildMachineCheck?
  var identity: String?
  var now: Date

  static let interval: TimeInterval = 15 * 60
}

/// Whether the automatic install should look at the build machines now. Callers pass `enabled` separately: a
/// disabled setting never checks.
func shouldCheckBuildMachines(_ state: BuildMachineCheckState) -> Bool {
  guard let entries = state.entries, !entries.isEmpty, state.checkout != nil else { return false }
  guard let last = state.last else { return true }
  return last.identity != state.identity || last.entries != entries
    || state.now.timeIntervalSince(last.at) >= BuildMachineCheckState.interval
}
