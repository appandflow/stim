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
    var now: () -> Date = Date.init
    var ticket: (Date) -> SetupTicket = { SetupTicket.generate(now: $0) }
  }

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
  private(set) var error: String?
  private(set) var serverNotReady = false
  private(set) var now: Date
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

  init(checkout: String?, dependencies: Dependencies, wizard: SetupWizard? = nil) {
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
        }
      ))
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
        if !self.busy {
          if self.wizard.phase == .pick {
            if self.now.timeIntervalSince(lastPeerPoll) >= 5 {
              lastPeerPoll = self.now
              await self.refreshPeers()
            }
          } else if self.wizard.ticket != nil, self.wizard.phase != .cancelled {
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
  }

  func refreshPeers() async {
    guard !isFixture else { return }
    statusJSON = await dependencies.status()
    peers = statusJSON.map(Tailnet.peers) ?? []
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
      await send(.next(dependencies.ticket(dependencies.now())))
    } catch { self.error = error.localizedDescription }
  }

  func newCommand() async {
    commandKnown = known
    await send(.newCommand(dependencies.ticket(dependencies.now())))
  }

  func checkAgain() async {
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
    guard !isFixture, let checkout else { return }
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
    now = dependencies.now()
    let effects = wizard.apply(event, now: now)
    if !isFixture {
      do { try await perform(effects) } catch { self.error = error.localizedDescription }
    }
    if error == nil {
      switch event {
      case .cancel, .done: stop()
      default: break
      }
    }
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
      case .restoreMode:
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
