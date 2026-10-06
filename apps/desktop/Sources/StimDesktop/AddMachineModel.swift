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
    var now: () -> Date = Date.init
    var ticket: (Date) -> SetupTicket = { SetupTicket.generate(now: $0) }
  }

  enum Page { case setup, tools, test, summary }
  var page: Page = .setup
  var mode: WizardMode = .off
  private(set) var toolsStatus: BuildMachineStatus?
  private(set) var androidStatus: BuildMachineStatus?
  private(set) var toolFindings: [DoctorReport.Finding] = []
  private(set) var androidFindings: [DoctorReport.Finding] = []
  private(set) var checksAndroid = false
  let sample: SampleBuildModel?
  var machines: BuildMachinesModel?
  private(set) var summary: [String] = []
  private(set) var finished = false
  private(set) var wizard: SetupWizard
  private(set) var peers: [Tailnet.Peer] = []
  private(set) var selfNode: TailnetMac?
  private(set) var statusJSON: Data?
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
  @ObservationIgnored private var lastToolsPoll = Date.distantPast

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
  var reachability: Tailnet.Reachability { Tailnet.reachability(statusJSON: statusJSON, peer: selected) }
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
    polling = Task { [weak self] in
      var lastPeerPoll = self?.dependencies.now() ?? Date()
      var lastDoctorPoll = Date.distantPast
      while !Task.isCancelled {
        guard let self, !self.stopped else { return }
        self.now = self.dependencies.now()
        if self.wizard.phase == .choose, let draft = self.draftTicket, self.now >= draft.expiresAt {
          self.draftTicket = self.dependencies.ticket(self.now)
        }
        if !self.busy {
          if self.page == .tools {
            if self.now.timeIntervalSince(self.lastToolsPoll) >= 30 {
              await self.refreshTools()
            }
          } else if self.page != .setup {
          } else if self.wizard.phase == .pick {
            if self.now.timeIntervalSince(lastPeerPoll) >= 5 {
              lastPeerPoll = self.now
              await self.refreshPeers()
            }
          } else if self.wizard.ticket != nil, self.wizard.phase != .cancelled {
            if self.doctorPath != nil { self.wizard.hasWorkspace = true }
            await self.checkJournal()
            if self.now.timeIntervalSince(lastDoctorPoll) >= 5, self.wizard.journal != nil, self.wizard.entriesWritten {
              lastDoctorPoll = self.now
              await self.reportDoctor(ask: false)
            }
            await self.send(.tick)
          }
        }
        try? await Task.sleep(for: .seconds(1))
      }
    }
  }

  func stop() {
    stopped = true
    polling?.cancel()
    polling = nil
    Task { await sample?.end() }
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
    if let checkout {
      do {
        let report = try await dependencies.doctor(checkout, false, [:])
        await send(.doctorReported(build: match(report.buildMachines), host: match(report.deviceHosts)))
      } catch { self.error = error.localizedDescription }
    }
  }

  func setCapability(_ capability: SetupCapability, enabled: Bool) {
    var chosen = wizard.capabilities
    if enabled { chosen.insert(capability) } else { chosen.remove(capability) }
    _ = wizard.apply(.capabilitiesChanged(chosen), now: now)
  }

  func next() async {
    guard version != nil, selfNode != nil else { return }
    do {
      let payload = try await dependencies.readSettings()
      wizard.settings = SetupWizard.Settings(
        builds: payload.entry("offload.machines")?.value.strings ?? [],
        hosts: payload.entry("hosting.machines")?.value.strings ?? [],
        mode: payload.entry("offload.mode")?.value.string, modeOrigin: payload.entry("offload.mode")?.origin)
      commandKnown = known
      sample?.prepare()
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

  func checkAgain() async {
    if page == .tools {
      await refreshTools()
      return
    }
    if doctorPath != nil { wizard.hasWorkspace = true }
    if wizard.phase == .cancelled {
      await send(.cancel)
      return
    }
    if wizard.phase == .pick {
      await refreshPeers()
      return
    }
    if wizard.phase == .choose {
      if version == nil { version = await dependencies.version() }
      await reportDoctor(ask: false)
      return
    }
    await checkJournal()
    if wizard.entriesWritten { await reportDoctor(ask: false) }
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
            builds: payload.entry("offload.machines")?.value.strings ?? [],
            hosts: payload.entry("hosting.machines")?.value.strings ?? [],
            mode: payload.entry("offload.mode")?.value.string, modeOrigin: payload.entry("offload.mode")?.origin)
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
    return statuses?.first { $0.machine == entry && ($0.dnsName == nil || $0.dnsName == mac.dnsName) }
  }

  private func runDoctor(ask: Bool, ticket: String? = nil) async throws {
    guard !isFixture, let checkout = doctorPath else { return }
    let report = try await dependencies.doctor(checkout, ask, ticket.map { ["STIM_ACCESS_TICKET": $0] } ?? [:])
    await send(.doctorReported(build: match(report.buildMachines), host: match(report.deviceHosts)))
  }

  private func reportDoctor(ask: Bool) async {
    do {
      try await runDoctor(ask: ask)
      error = nil
    } catch { self.error = error.localizedDescription }
  }

  func send(_ event: SetupWizard.Event) async {
    guard !cancelling else { return }
    defer { if case .cancel = event { cancelling = false } }
    if case .cancel = event {
      cancelling = true
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
    if checksAndroid {
      let androidRows = toolsReport(
        journal: wizard.journal, status: androidStatus, capabilities: wizard.capabilities, android: true,
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
      lastToolsPoll = dependencies.now()
    }
    do {
      let report = try await doctor(cwd, "ios")
      toolsStatus = match(report.buildMachines)
      toolFindings = report.findings
      if checksAndroid {
        let report = try await doctor(cwd, "android")
        androidStatus = match(report.buildMachines)
        androidFindings = report.findings
      }
      error = nil
    } catch { self.error = error.localizedDescription }
  }
  func checkAndroid() async {
    checksAndroid = true
    await refreshTools()
  }
  func openTest() {
    guard !toolsBlock else { return }
    page = .test
    if wizard.capabilities.contains(.build), let entry = machineEntry {
      sample?.run(entry: entry)
    }
  }
  func openSummary() async {
    await sample?.end()
    do {
      let payload = try await dependencies.readSettings()
      mode = WizardMode.defaultChoice(
        passed: sample?.test.passed == true, changedMode: wizard.modeChanged, current: payload.entry("offload.mode")?.value.string
      )
      updateSummary()
      page = .summary
    } catch { self.error = error.localizedDescription }
  }
  private func updateSummary() {
    summary = summaryLines(addedEntries: addedEntries, mode: mode)
  }
  func finish() async {
    guard page == .summary, wizard.phase == .approved, !busy else { return }
    busy = true
    defer { busy = false }
    do {
      let payload = try await dependencies.readSettings()
      if payload.entry("offload.mode")?.value.string != mode.rawValue {
        try await dependencies.writeSetting("offload.mode", mode.rawValue)
      }
      updateSummary()
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
          try await dependencies.writeSetting("offload.mode", "off")
          modeWritten = true
        }
        for capability in SetupCapability.allCases where wizard.capabilities.contains(capability) {
          let key = capability == .build ? "offload.machines" : "hosting.machines"
          let entries = payload.entry(key)?.value.strings ?? []
          if !entries.contains(entry) {
            try await dependencies.writeSetting(key, OffloadMachines.adding(entry, to: entries))
            addedEntries[key] = entry
          }
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
          try await dependencies.writeSetting("offload.mode", nil)
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
            {"code":"bundler","reason":"no Bundler there to run the CocoaPods this project's Gemfile.lock pins"},
            {"code":"stim-build","reason":"Stim build old there, current here"}]}
            """.utf8))
        toolFindings = try! JSONDecoder().decode(
          DoctorReport.self,
          from: Data(
            """
            {"project":"/fixture","findings":[
            {"code":"build-machine-xcode","level":"cost","title":"Build machine mini has a different Xcode","detail":"Xcode mismatch","fix":"Install and select the same Xcode on mini and this Mac (`xcode-select -p` on each)."},
            {"code":"build-machine-bundler","level":"cost","title":"Build machine mini lacks Bundler","detail":"No Bundler","fix":"Install Bundler (`gem install bundler`) on mini, on the PATH its stim-server's login shell sets."},
            {"code":"build-machine-stim-build","level":"cost","title":"Build machine mini has a different Stim build","detail":"Stim build mismatch","fix":"Update stim-server on mini to the same Stim build as this Mac."}]}
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
        checksAndroid = true
        androidStatus = status
      default:
        page = [.summaryAuto, .summaryNever, .summaryUndo].contains(fixture) ? .summary : .test
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
        default: break
        }
        sample?.fixture(
          events,
          lines: fixture == .offloading || fixture == .localBuilding
            ? [
              .init(text: "$ stim ios --build-machine mini --no-build-cache --json", kind: .command),
              .init(text: "offer accepted; syncing checkout", kind: .output),
              .init(text: "built on mini in 2:52: offer 0:01, sync 0:03, build 2:41, fetch 0:04", kind: .ok),
            ] : [])
        mode = fixture == .summaryNever ? .off : .auto
        summary = summaryLines(addedEntries: ["offload.machines": "mini", "hosting.machines": "mini"], mode: mode)
      }
    }

    func configureFixture(status: Data?, health: [String: Tailnet.Health], selfNode: TailnetMac, ticket: SetupTicket) {
      isFixture = true
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
