import Foundation
import Observation
import StimKit

@MainActor @Observable
final class AddMachineModel {
  struct Dependencies {
    var status: () async -> Data?
    var health: (String, Int) async -> Tailnet.Health?
    var journal: (String, Int, String) async -> SetupPortProbe.Outcome
    var doctor: (String, Bool, [String: String]) async throws -> DoctorReport
    var readSettings: () async throws -> SettingsPayload
    var writeSetting: (String, String?) async throws -> Void
    var version: () async -> String?
    var toolsDoctor: ((String, String) async throws -> DoctorReport)? = nil
    var tailscaleInstall: () async -> Tailnet.Install = { .none }
    var now: () -> Date = Date.init
    var ticket: (Date) -> SetupTicket = { SetupTicket.generate(now: $0) }
  }

  typealias Page = SetupPage
  var page: Page = .setup
  var mode: WizardMode = .off
  private(set) var toolsStatus: BuildMachineStatus?
  private(set) var androidStatus: BuildMachineStatus?
  private(set) var toolFindings: [DoctorReport.Finding] = []
  private(set) var androidFindings: [DoctorReport.Finding] = []
  var checksAndroid: Bool { wizard.capabilities.contains(.build) }
  let sample: SampleBuildModel?
  var preparingSample: Bool { sample?.preparing == true }
  var testOutcome: BuildTest.Outcome {
    wizard.capabilities.contains(.build) ? sample?.test.outcome ?? .notRun : .notRun
  }
  var machines: BuildMachinesModel?
  /// Where hosted simulators run for this Mac; nil keeps a current value the wizard does not offer, like `eas`.
  var simulators: SimulatorPlacement? = .auto
  private(set) var simulatorsCurrent: [String: String?] = [:]
  private(set) var finished = false
  private(set) var wizard: SetupWizard
  private(set) var peers: [Tailnet.Peer] = []
  private(set) var selfNode: TailnetMac?
  private(set) var statusJSON: Data?
  private(set) var tailscaleInstall: Tailnet.Install = .none
  private(set) var health: [String: Tailnet.Health] = [:]
  private(set) var healthChecked: Set<String> = []
  private(set) var version: String?
  private(set) var draftTicket: SetupTicket?
  private var commandKnown: SetupKnown?
  private(set) var busy = false
  private(set) var cancelling = false
  private(set) var error: String?
  private(set) var serverNotReady = false
  private(set) var now: Date
  private var preferredMachineID: String?
  private var prefersHostedSimulators = false
  var selectedId: String?
  var manualPort = ""
  var isFixture = false
  private let checkout: String?
  @ObservationIgnored private let dependencies: Dependencies
  @ObservationIgnored private var polling: Task<Void, Never>?
  @ObservationIgnored private var addedEntries: [String: String] = [:]
  @ObservationIgnored private var modeWritten = false
  @ObservationIgnored private var stopped = false
  @ObservationIgnored private var checkingJournal = false
  @ObservationIgnored private var checkingTools = false
  @ObservationIgnored private var clock = SetupRefreshClock()

  init(checkout: String?, dependencies: Dependencies, wizard: SetupWizard? = nil, sample: SampleBuildModel? = nil) {
    self.sample = sample
    self.checkout = checkout
    self.dependencies = dependencies
    self.wizard = wizard ?? SetupWizard(hasWorkspace: checkout != nil)
    now = dependencies.now()
  }

  convenience init(cli: Task<StimCLI, Never>, settings: MachineSettingsStore, checkout: String?) {
    self.init(
      checkout: checkout,
      dependencies: Dependencies(
        status: {
          let environment = await cli.value.environment
          return await Task.detached { Tailnet.status(environment: environment) }.value
        },
        health: { await Tailnet.health(dnsName: $0, port: $1) },
        journal: Self.fetchJournal,
        doctor: { cwd, ask, environment in
          try await cli.value.machineAccess(cwd: cwd, ask: ask, extraEnvironment: environment)
        },
        readSettings: { try await cli.value.settings(cwd: NSHomeDirectory()) },
        writeSetting: { key, value in
          switch await settings.write(key, value: value, scope: .machine, cwd: NSHomeDirectory()) {
          case .success(.written): return
          case .success(.refused(let refusal)): throw refusal
          case .failure(let error): throw error
          }
        },
        version: {
          let cli = await cli.value
          let server = await StimServerCLI.resolve(
            environment: cli.environment,
            override: UserDefaults.standard.string(forKey: AppPreferences.Key.stimServerExecutable))
          var output = await server.versionOutput()
          if output == nil { output = await cli.versionOutput() }
          return output?.trimmingCharacters(in: .whitespacesAndNewlines)
        },
        toolsDoctor: { cwd, platform in
          let output = try await WizardToolsDoctor.read(cli: await cli.value, cwd: cwd, platform: platform)
          return output
        },
        tailscaleInstall: {
          let environment = await cli.value.environment
          return Tailnet.Install.detect(environment: environment)
        }
      ), sample: SampleBuildModel(cli: cli))
  }

  static func fetchJournal(dnsName: String, port: Int, hash: String) async -> SetupPortProbe.Outcome {
    guard let url = URL(string: "https://\(dnsName):\(port)/setup/\(hash)") else { return .unreachable }
    var request = URLRequest(url: url)
    request.timeoutInterval = 3
    request.cachePolicy = .reloadIgnoringLocalCacheData
    guard let (data, response) = try? await URLSession.shared.data(for: request),
      let response = response as? HTTPURLResponse
    else { return .unreachable }
    if response.statusCode == 503 { return .notReady }
    if response.statusCode == 200, let journal = try? JSONDecoder().decode(SetupJournal.self, from: data), journal.v == 1 {
      return .journal(journal)
    }
    return .notFound
  }

  var selected: Tailnet.Peer? { peers.first { $0.id == selectedId } }
  var reachability: Tailnet.Reachability {
    Tailnet.reachability(statusJSON: statusJSON, peer: selected, install: tailscaleInstall)
  }
  enum MacList: Equatable { case empty, offlineOnly, available }
  var macList: MacList {
    peers.isEmpty ? .empty : peers.contains(where: \.online) ? .available : .offlineOnly
  }
  var tailscaleRunning: Bool { reachability != .tailscaleMissing && reachability != .tailscaleStopped }
  var known: SetupKnown {
    var known = wizard.known
    known.serverVersion = wizard.mac.flatMap { health[$0.id]?.version }
    known.clientName = selfNode?.hostName ?? "this Mac"
    return known
  }
  var olderThanSetup: String? {
    guard let text = wizard.mac.flatMap({ health[$0.id]?.version }), let found = SemanticVersion(text),
      found < SemanticVersion("1.16.0")!
    else { return nil }
    return text
  }
  var command: String? {
    if checkout == nil, sample != nil, commandKnown == nil { return nil }
    guard let version, let selfNode, let ticket = wizard.ticket ?? draftTicket else { return nil }
    return setupCommand(
      version: version, client: selfNode.id, ticket: ticket,
      capabilities: wizard.capabilities, known: commandKnown ?? known)
  }

  func start() async {
    guard !isFixture, polling == nil else { return }
    stopped = false
    version = await dependencies.version()
    await refreshPeers()
    clock.ran(.peers, now: dependencies.now())
    polling = Task { [weak self] in
      while !Task.isCancelled {
        guard let self, !self.stopped else { return }
        await self.poll()
        try? await Task.sleep(for: .seconds(1))
      }
    }
  }

  private func poll() async {
    now = dependencies.now()
    if wizard.phase == .choose, let draft = draftTicket, now >= draft.expiresAt {
      draftTicket = dependencies.ticket(now)
    }
    await refresh(dueOnly: true)
  }

  /// Runs the reads the current step keeps fresh: only those whose interval has passed when `dueOnly`, as the
  /// background poll does, or all of them.
  func refresh(dueOnly: Bool = false) async {
    guard !busy else { return }
    if doctorPath != nil, wizard.ticket != nil { wizard.hasWorkspace = true }
    if dueOnly {
      for read in clock.due(wizard.refreshes(page: page), now: now) { await refresh(read) }
    } else {
      var done: Set<SetupRefresh> = []
      while let read = wizard.refreshes(page: page).first(where: { !done.contains($0) }) {
        done.insert(read)
        clock.ran(read, now: now)
        await refresh(read)
      }
    }
    if page == .setup, wizard.ticket != nil, wizard.phase != .cancelled { await send(.tick) }
  }

  private func refresh(_ read: SetupRefresh) async {
    switch read {
    case .peers: await refreshPeers()
    case .approvals:
      if version == nil { version = await dependencies.version() }
      await reportDoctor(ask: false)
    case .journal:
      if doctorPath != nil { wizard.hasWorkspace = true }
      await checkJournal()
    case .doctor: await reportDoctor(ask: false)
    case .tools: await refreshTools()
    }
  }

  func stop() {
    stopped = true
    polling?.cancel()
    polling = nil
    Task { await sample?.end() }
    if modeWritten, !finished {
      modeWritten = false
      Task { await restoreMode() }
    }
  }

  private func restoreMode() async {
    do { try await dependencies.writeSetting("remote.buildMode", nil) } catch { modeWritten = true }
  }

  func preselect(machineID: String?, hostedSimulators: Bool) {
    preferredMachineID = machineID
    prefersHostedSimulators = hostedSimulators
    applyPreselection()
  }

  private func applyPreselection() {
    if selectedId == nil, let preferredMachineID, peers.contains(where: { $0.id == preferredMachineID }) {
      selectedId = preferredMachineID
    }
  }

  func refreshPeers() async {
    guard !isFixture else { return }
    statusJSON = await dependencies.status()
    tailscaleInstall = await dependencies.tailscaleInstall()
    peers = statusJSON.map(Tailnet.peers) ?? []
    applyPreselection()
    selfNode = statusJSON.flatMap(Tailnet.selfNode)
    await withTaskGroup(of: (String, Tailnet.Health?).self) { group in
      for peer in peers where peer.online {
        for port in 7443...7445 {
          group.addTask { (peer.id, await self.dependencies.health(peer.mac.dnsName, port)) }
        }
      }
      var found: [String: Tailnet.Health] = [:]
      for await (id, answer) in group {
        if let answer { found[id] = answer }
      }
      health = found
      healthChecked = Set(peers.filter(\.online).map(\.id))
    }
  }

  func pick() async {
    guard reachability == .ready, let selected, selfNode != nil else { return }
    await send(.macChosen(selected.mac))
    if wizard.phase == .choose, prefersHostedSimulators {
      setCapability(.deviceHost, enabled: true)
      setCapability(.build, enabled: false)
    }
    draftTicket = dependencies.ticket(dependencies.now())
    clock.ran(.approvals, now: dependencies.now())
    if let checkout {
      do {
        let report = try await dependencies.doctor(checkout, false, [:])
        await send(.doctorReported(build: match(report.remoteMachines), host: match(report.deviceHosts)))
      } catch { self.error = error.localizedDescription }
    } else {
      sample?.prepare()
    }
  }

  func setCapability(_ capability: SetupCapability, enabled: Bool) {
    var chosen = wizard.capabilities
    if enabled { chosen.insert(capability) } else { chosen.remove(capability) }
    _ = wizard.apply(.capabilitiesChanged(chosen), now: now)
  }

  func next() async {
    guard version != nil, selfNode != nil, !busy else { return }
    busy = true
    defer { busy = false }
    do {
      sample?.prepare()
      if checkout == nil, let sample {
        await sample.waitForPreparation()
        guard sample.sampleReady else { return }
        let report = try await dependencies.doctor(sample.folder, false, [:])
        await send(.doctorReported(build: match(report.remoteMachines), host: match(report.deviceHosts)))
        wizard.hasWorkspace = true
      }
      let payload = try await dependencies.readSettings()
      wizard.settings = SetupWizard.Settings(
        builds: payload.entry("remote.machines")?.value.strings ?? [],
        hosts: payload.entry("remote.machines")?.value.strings ?? [],
        mode: payload.entry("remote.buildMode")?.value.string, modeOrigin: payload.entry("remote.buildMode")?.origin)
      commandKnown = known
      let current = dependencies.now()
      if let draft = draftTicket, current < draft.expiresAt {
        await send(.next(draft))
      } else {
        await send(.next(dependencies.ticket(current)))
      }
      if wizard.phase == .approved { await openTools() }
    } catch { self.error = error.localizedDescription }
  }

  func newCommand() async {
    commandKnown = known
    await send(.newCommand(dependencies.ticket(dependencies.now())))
  }

  func useManualPort() async {
    guard let port = SetupPortProbe.manualPort(manualPort) else {
      error = "Enter a port from 1 to 65535."
      return
    }
    await send(.manualPort(port))
    await checkJournal()
  }

  private func checkJournal() async {
    guard !isFixture, !busy, !checkingJournal, wizard.phase != .expiredCommand,
      let mac = wizard.mac, let ticket = wizard.ticket, selfNode != nil
    else { return }
    guard wizard.hasWorkspace else { return }
    checkingJournal = true
    defer { checkingJournal = false }
    let status = await dependencies.status()
    guard let status, Tailnet.selfNode(statusJSON: status)?.id == selfNode?.id,
      Tailnet.peers(statusJSON: status).contains(where: { $0.mac == mac && $0.online })
    else {
      error = "The selected Mac is no longer reachable as the pinned tailnet node. Check Tailscale on \(mac.hostName)."
      return
    }
    let ports = wizard.port.map { [$0] } ?? Array(7443...7452)
    let outcomes = await withTaskGroup(of: (Int, SetupPortProbe.Outcome).self) { group in
      for port in ports {
        group.addTask { (port, await self.dependencies.journal(mac.dnsName, port, ticket.hash)) }
      }
      var results: [Int: SetupPortProbe.Outcome] = [:]
      for await (port, answer) in group { results[port] = answer }
      return results
    }
    guard !Task.isCancelled, !stopped, wizard.ticket == ticket, wizard.phase != .cancelled else { return }
    switch SetupPortProbe.resolve(outcomes) {
    case .found(let port, let journal):
      guard journal.client.nodeId == selfNode?.id, journal.expiresAt == ticket.isoExpires else { return }
      if wizard.journal == nil, !wizard.entriesWritten {
        do {
          let payload = try await dependencies.readSettings()
          wizard.settings = SetupWizard.Settings(
            builds: payload.entry("remote.machines")?.value.strings ?? [],
            hosts: payload.entry("remote.machines")?.value.strings ?? [],
            mode: payload.entry("remote.buildMode")?.value.string, modeOrigin: payload.entry("remote.buildMode")?.origin)
        } catch {
          self.error = error.localizedDescription
          return
        }
      }
      guard !stopped, wizard.ticket == ticket, wizard.phase != .cancelled else { return }
      serverNotReady = false
      await send(.journalAnswered(port: port, journal: journal))
      if error != nil, !wizard.entriesWritten {
        do { try await perform([.writeEntries(port: port)]) } catch { self.error = error.localizedDescription }
      }
    case .serverNotReady: serverNotReady = true
    case .notYet: await send(.journalUnavailable)
    }
  }

  private func match(_ statuses: [BuildMachineStatus]?) -> BuildMachineStatus? {
    guard let mac = wizard.mac else { return nil }
    let entry = SetupPortProbe.entry(machine: mac.machine, port: wizard.port ?? 7443)
    let sameMac = { (status: BuildMachineStatus) in status.dnsName == nil || status.dnsName == mac.dnsName }
    return statuses?.first { $0.machine == entry && sameMac($0) }
      ?? statuses?.first { ($0.machine == mac.machine || $0.machine.hasPrefix(mac.machine + ":")) && sameMac($0) }
  }

  @discardableResult private func runDoctor(ask: Bool, ticket: String? = nil) async throws -> Bool {
    guard !isFixture, let checkout = doctorPath else { return false }
    let report = try await dependencies.doctor(checkout, ask, ticket.map { ["STIM_ACCESS_TICKET": $0] } ?? [:])
    await send(.doctorReported(build: match(report.remoteMachines), host: match(report.deviceHosts)))
    return true
  }

  private func reportDoctor(ask: Bool) async {
    do {
      if try await runDoctor(ask: ask) { error = nil }
    } catch { self.error = error.localizedDescription }
  }

  func send(_ event: SetupWizard.Event) async {
    guard !cancelling else { return }
    defer { if case .cancel = event { cancelling = false } }
    if case .cancel = event {
      cancelling = true
      error = nil
      await sample?.end()
      page = .setup
    }
    now = dependencies.now()
    let effects = wizard.apply(event, now: now)
    if !isFixture {
      do { try await perform(effects) } catch { self.error = error.localizedDescription }
    }
    if error == nil {
      switch event {
      case .cancel: stop()
      default: break
      }
    }
  }

  var doctorPath: String? { checkout ?? (sample?.sampleReady == true ? sample?.folder : nil) }
  var machineEntry: String? {
    wizard.mac.map { SetupPortProbe.entry(machine: $0.machine, port: wizard.port ?? 7443) }
  }
  var tools: [WizardTool] {
    var rows = toolsReport(
      journal: wizard.journal, status: toolsStatus, capabilities: wizard.capabilities, findings: toolFindings)
    if checksAndroid, androidStatus != nil || wizard.journal != nil {
      let androidRows = toolsReport(
        journal: wizard.journal, status: androidStatus, capabilities: wizard.capabilities, android: androidStatus != nil,
        findings: androidFindings)
      let codes: Set<String> = ["jdk", "android-sdk", "ndk", "build-tools", "compile-sdk"]
      rows.removeAll { codes.contains($0.id) }
      rows.append(contentsOf: androidRows.filter { codes.contains($0.id) })
    }
    return rows
  }
  var toolsBlock: Bool { tools.contains { $0.blocks } }

  func openTools() async {
    guard wizard.phase == .approved else { return }
    page = .tools
    await refreshTools()
  }
  func refreshTools() async {
    guard !isFixture, !checkingTools, let doctor = dependencies.toolsDoctor,
      let cwd = sample?.sampleReady == true ? sample?.folder : doctorPath
    else { return }
    checkingTools = true
    defer {
      checkingTools = false
      clock.ran(.tools, now: dependencies.now())
    }
    do {
      let report = try await doctor(cwd, "ios")
      toolsStatus = match(report.remoteMachines)
      toolFindings = report.findings
      error = nil
    } catch {
      self.error = error.localizedDescription
      return
    }
    if checksAndroid, let report = try? await doctor(cwd, "android") {
      androidStatus = match(report.remoteMachines)
      androidFindings = report.findings
    }
  }
  func openTest() {
    page = .test
    if wizard.capabilities.contains(.build), let entry = machineEntry {
      sample?.run(entry: entry)
    }
  }
  func closeTest() async {
    await sample?.end()
    page = .summary
  }
  func openSummary() async {
    await sample?.end()
    do {
      let payload = try await dependencies.readSettings()
      mode = WizardMode.defaultChoice(
        changedMode: wizard.modeChanged, current: payload.entry("remote.buildMode")?.value.string)
      if choosesSimulators, let entry = machineEntry {
        let ios = payload.entry("ios.remote")?.value.string
        let android = payload.entry("android.remote")?.value.string
        simulatorsCurrent = ["ios.remote": ios, "android.remote": android]
        simulators = ios != android ? nil : ios == nil ? .auto : SimulatorPlacement(current: ios, machine: entry)
      }
      page = .summary
    } catch { self.error = error.localizedDescription }
  }
  /// Whether the summary sets this Mac's `ios.remote` and `android.remote` (machine scope).
  var choosesSimulators: Bool { wizard.capabilities.contains(.deviceHost) }
  func finish() async {
    guard page == .summary, wizard.phase == .approved, !busy else { return }
    busy = true
    defer { busy = false }
    do {
      let payload = try await dependencies.readSettings()
      if payload.entry("remote.buildMode")?.value.string != mode.rawValue {
        try await dependencies.writeSetting("remote.buildMode", mode.rawValue)
      }
      modeWritten = false
      if choosesSimulators, let entry = machineEntry, let simulators {
        let value = simulators.value(machine: entry)
        for key in ["ios.remote", "android.remote"] where payload.entry(key)?.value.string != value {
          try await dependencies.writeSetting(key, value)
        }
      }
      error = nil
      finished = true
      stop()
    } catch { self.error = error.localizedDescription }
  }

  private func perform(_ effects: [SetupWizard.Effect]) async throws {
    guard !effects.isEmpty else { return }
    busy = true
    defer { busy = false }
    for effect in effects {
      switch effect {
      case .writeEntries(let port):
        guard let mac = wizard.mac, wizard.hasWorkspace else { return }
        let payload = try await dependencies.readSettings()
        let entry = SetupPortProbe.entry(machine: mac.machine, port: port)
        if wizard.modeChanged, !modeWritten {
          try await dependencies.writeSetting("remote.buildMode", "off")
          modeWritten = true
        }
        let entries = payload.entry("remote.machines")?.value.strings ?? []
        if !entries.contains(entry) {
          try await dependencies.writeSetting("remote.machines", OffloadMachines.adding(entry, to: entries))
          addedEntries["remote.machines"] = entry
        }
        error = nil
        let effects = wizard.apply(.entriesWritten, now: dependencies.now())
        try await perform(effects)
      case .askDoctor(let ticket): try await runDoctor(ask: true, ticket: ticket)
      case .restoreSettings:
        let payload = try await dependencies.readSettings()
        for (key, entry) in addedEntries {
          try await dependencies.writeSetting(
            key, OffloadMachines.removing(entry, from: payload.entry(key)?.value.strings ?? []))
        }
        addedEntries = [:]
        if modeWritten {
          try await dependencies.writeSetting("remote.buildMode", nil)
          modeWritten = false
        }
      case .forgetPairing: try await runDoctor(ask: true)
      }
    }
    error = nil
  }
}

#if DEBUG
  extension AddMachineModel {
    func configureLaterFixture(_ fixture: AddMachineFixture) {
      let times = BuildTimings(offerMs: 1000, syncMs: 3000, workerMs: 161000, fetchMs: 4000, totalMs: 172000)
      var status = wizard.build!
      status.offloadable = true
      toolsStatus = status
      switch fixture {
      case .toolsOK: page = .tools
      case .toolsFixes:
        page = .tools
        toolsStatus = try! JSONDecoder().decode(
          BuildMachineStatus.self,
          from: Data(
            """
            {"machine":"mini","state":"approved","offloadable":false,"problems":[
            {"code":"xcode","reason":"Xcode 26.0 there, Xcode 27.0 here"},
            {"code":"cocoapods","reason":"CocoaPods 1.17.0 there, 1.16.2 here"},
            {"code":"stim-build","reason":"Stim build old there, current here"}]}
            """.utf8))
        toolFindings = try! JSONDecoder().decode(
          DoctorReport.self,
          from: Data(
            """
            {"project":"/fixture","findings":[
            {"code":"build-machine-xcode","level":"cost","title":"Remote Mac mini has a different Xcode","detail":"Xcode mismatch","fix":"Install and select the same Xcode on mini and this Mac (`xcode-select -p` on each)."},
            {"code":"build-machine-bundler","level":"cost","title":"Remote Mac mini lacks Bundler","detail":"No Bundler","fix":"Install Bundler (`gem install bundler`) on mini, on the PATH its stim-server's login shell sets."},
            {"code":"build-machine-stim-build","level":"cost","title":"Remote Mac mini has a different Stim build","detail":"Stim build mismatch","fix":"Update stim-server on mini to the same Stim build as this Mac."}]}
            """.utf8)
        ).findings
      case .toolsBusy:
        page = .tools
        toolsStatus = try! JSONDecoder().decode(
          BuildMachineStatus.self,
          from: Data(
            """
            {"machine":"mini","state":"approved","offloadable":false,"problems":[{"code":"busy","reason":"Build Mac is taking another build; this does not block Next."}]}
            """.utf8))
      case .toolsAndroid:
        page = .tools
        androidStatus = try! JSONDecoder().decode(
          BuildMachineStatus.self,
          from: Data(
            """
            {"machine":"mini","state":"approved","offloadable":false,"problems":[{"code":"jdk","reason":"no JDK there, 17 here"}]}
            """.utf8))
      default:
        page = [.summaryAuto, .summaryNever, .summaryUndo, .summarySkippedAfterFailure].contains(fixture) ? .summary : .test
        var events: [BuildTest.Event] = [
          .prepared, .start, .offload(.success), .timings(times), .localStart, .localFinished(passed: true, ms: 250000),
        ]
        switch fixture {
        case .testPreparingSample: events = []
        case .sampleFailed:
          events = [
            .fail(
              code: "SAMPLE_PREPARE_FAILED", message: "Could not create the sample app: npm could not reach the registry.",
              remedy: nil)
          ]
        case .offloading: events = [.prepared, .start, .progress("Syncing the sample checkout")]
        case .offloaded: events.removeLast(2)
        case .localBuilding: events.removeLast()
        case .testFailed:
          let refusal = try! JSONDecoder().decode(
            CommandRefusal.self,
            from: Data(
              """
              {"code":"STIM_OFFLOAD_REFUSED","message":"mini refused this build: no iOS runtime there","remedy":"xcodebuild -downloadPlatform iOS"}
              """.utf8))
          events = [.prepared, .start, .offload(.refused(refusal))]
        case .testSkipped, .summaryNever: events = [.skip]
        case .summarySkippedAfterFailure:
          events = [
            .prepared, .start,
            .fail(code: "STIM_OFFLOAD_REFUSED", message: "mini refused this build: no iOS runtime there", remedy: nil), .skip,
          ]
        default: break
        }
        sample?.fixture(
          events,
          lines: fixture == .offloading || fixture == .localBuilding
            ? [
              .init(text: "$ stim ios --remote-build mini --no-build-cache --json", kind: .command),
              .init(text: "offer accepted; syncing checkout", kind: .output),
              .init(text: "built on mini in 2:52: offer 0:01, sync 0:03, build 2:41, fetch 0:04", kind: .ok),
            ] : [])
        mode = fixture == .summaryNever || fixture == .summarySkippedAfterFailure ? .off : .auto
      }
    }

    func configureFixture(
      status: Data?, health: [String: Tailnet.Health], selfNode: TailnetMac, ticket: SetupTicket, install: Tailnet.Install
    ) {
      isFixture = true
      tailscaleInstall = install
      statusJSON = status
      peers = status.map(Tailnet.peers) ?? []
      self.selfNode = selfNode
      selectedId = peers.first?.id
      self.health = health
      healthChecked = Set(peers.filter(\.online).map(\.id))
      version = "1.16.0"
      draftTicket = ticket
    }
  }
#endif
