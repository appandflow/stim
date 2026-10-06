import Combine
import CoreGraphics
import Foundation
import StimKit
import StimStores

@MainActor
final class DiscoveryCoordinator: ObservableObject {
  private let status: StatusStore
  private let machines: BuildMachinesModel
  private let stats: StatsReader
  private let autopilot: AutopilotRunner
  private let gc: GcReportStore
  private let environment: Task<[String: String], Never>
  private let persistence: DiscoveryStore
  private let idleSeconds: () -> TimeInterval
  private var subscription: AnyCancellable?
  private var pollTimer: Timer?
  private var launchTimer: Timer?
  private static var countedLaunch = false
  private var latest: StatusPayload?
  private var placements: [BuildPlacements.Placement]?
  private var previous: StatusPayload?
  private var macs: [TailnetMac] = []
  private var pending: [DiscoveryType: (prompt: DiscoveryPrompt, rememberedAt: Date)] = [:]
  private var polling = false
  private var delivering = false

  init(
    status: StatusStore, machines: BuildMachinesModel, stats: StatsReader, autopilot: AutopilotRunner,
    gc: GcReportStore, environment: Task<[String: String], Never>,
    persistence: DiscoveryStore = DiscoveryStore(defaults: .standard),
    idleSeconds: @escaping () -> TimeInterval = {
      CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: UInt32.max)!)
    }
  ) {
    self.status = status
    self.machines = machines
    self.stats = stats
    self.autopilot = autopilot
    self.gc = gc
    self.environment = environment
    self.persistence = persistence
    self.idleSeconds = idleSeconds
  }

  func start(actions: ActionCenter) {
    guard subscription == nil else { return }
    if !Self.countedLaunch {
      persistence.launched()
      Self.countedLaunch = true
    }
    let onFinish = actions.onFinish
    actions.onFinish = { [weak self] run in
      onFinish?(run)
      guard let self, let exit = run.exitStatus else { return }
      let lines = run.lines.map(\.text) + String(decoding: run.stdout, as: UTF8.self).components(separatedBy: "\n")
      remember(Discovery.capHit(lines: lines, exitStatus: exit, mac: macs.first))
      evaluate()
    }
    NotificationResponder.shared.discoveryResponse = { [weak self] type, never in
      if never { self?.persistence.set(.never, for: type) } else { Self.open(.pairPhone) }
    }
    subscription = status.$payload.compactMap { $0 }.sink { [weak self] payload in self?.receive(payload) }
    launchTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated { self?.poll() }
    }
    pollTimer = Timer.scheduledTimer(withTimeInterval: 600, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.poll() }
    }
  }

  private func receive(_ payload: StatusPayload) {
    latest = payload
    defer { previous = payload }
    let before = Dictionary((previous?.environments ?? []).map { ($0.path, $0) }, uniquingKeysWith: { first, _ in first })
    var finished = false
    for workspace in payload.environments {
      guard let build = before[workspace.path]?.build, build.isRunning,
        workspace.build?.isRunning != true || workspace.build?.startedAt != build.startedAt
      else { continue }
      finished = true
      if let last = workspace.lastBuilds?.build(for: build.platform), last.startedAt == build.startedAt,
        let duration = last.durationMs, last.status == "ok" || last.status == "failed",
        let phones = ServerController.shared.pairedPhoneCount
      {
        remember(Discovery.away(pairedPhones: phones, durationMs: duration, idleSeconds: idleSeconds()))
      }
    }
    if finished {
      Task {
        await machines.settings.refresh()
        placements = try? await stats.machine().offload?.placements
        evaluate()
      }
    } else {
      evaluate()
    }
  }

  private func poll() {
    guard !polling else { return }
    polling = true
    Task {
      let environment = await environment.value
      let peers = await Task.detached { Tailnet.status(environment: environment).flatMap(Tailnet.macs(statusJSON:)) }.value
      await machines.settings.refresh()
      polling = false
      macs = peers ?? []
      if let peers {
        let result = Discovery.newMac(macs: peers, seen: persistence.seenPeers, machines: machines.entries ?? [], now: Date())
        persistence.seenPeers = result.seen
        if machines.entries != nil, machines.settings.error == nil { remember(result.prompt) }
      }
      evaluate()
    }
  }

  private func remember(_ prompt: DiscoveryPrompt?) {
    if let prompt { pending[prompt.type] = (prompt, Date()) }
  }

  private func allowed(now: Date) -> Bool {
    guard let payload = latest, status.error == nil else { return false }
    return Discovery.gate(
      workspaces: payload.environments, setupCompleted: persistence.setupCompleted, launches: persistence.launches,
      lastShown: persistence.lastShown, now: now, calendar: .current)
  }

  private func evaluate() {
    let now = Date()
    pending = pending.filter { Discovery.fresh($0.key, rememberedAt: $0.value.rememberedAt, now: now) }
    var candidates = pending.values.map(\.prompt).filter { prompt in
      if prompt.type == .newMac, case .addMachine(let mac?, _) = prompt.action {
        return macs.contains(where: { $0.id == mac.id }) && machines.settings.error == nil
          && machines.entries.map { entries in !entries.contains { OffloadMachines.names($0, mac) } } == true
      }
      if prompt.type == .away { return ServerController.shared.pairedPhoneCount == 0 }
      return true
    }
    if let placements {
      if let entries = machines.entries, machines.settings.error == nil,
        let prompt = Discovery.slowCold(placements: placements, machines: entries, macs: macs, now: now)
      {
        candidates.append(prompt)
      }
      if let prompt = Discovery.slotWait(placements: placements, macs: macs, now: now) { candidates.append(prompt) }
    }
    let sizes = gc.report?.sections.caches?.compactMap(\.bytes)
    if let prompt = Discovery.lowWithCaches(
      plan: autopilot.pressure, cacheBytes: sizes.map { $0.reduce(0, +) }, mac: macs.first)
    {
      candidates.append(prompt)
    }
    guard !delivering, allowed(now: now),
      let prompt = Discovery.select(candidates, states: persistence.states, now: now, bannersAvailable: MainWindow.isOpen)
    else { return }
    if prompt.surface == .banner {
      let previous = persistence.state(prompt.type)
      NoticeCenter.shared.show(
        Self.notice(
          prompt, perform: Self.open,
          snooze: { [persistence] in
            persistence.set(Discovery.dismissed(previous: previous, now: Date()), for: prompt.type)
          }, never: { [persistence] in persistence.set(.never, for: prompt.type) }))
      persistence.shown(prompt, now: now)
    } else {
      guard let event = pending[prompt.type] else { return }
      delivering = true
      Task {
        let posted = await Notifier.postDiscovery(prompt) { [self] in
          allowed(now: Date()) && Discovery.eligible(persistence.state(prompt.type), now: Date())
            && ServerController.shared.pairedPhoneCount == 0 && idleSeconds() > 300
            && Discovery.fresh(prompt.type, rememberedAt: event.rememberedAt, now: Date())
        }
        if posted { persistence.shown(prompt, now: Date()) }
        delivering = false
      }
    }
  }

  static func notice(
    _ prompt: DiscoveryPrompt, perform: @escaping @MainActor (DiscoveryAction) -> Void,
    snooze: @escaping @MainActor () -> Void, never: @escaping @MainActor () -> Void
  ) -> Notice {
    Notice(
      icon: "lightbulb", title: prompt.title, detail: prompt.detail, actionTitle: prompt.actionTitle,
      perform: { perform(prompt.action) }, onDismiss: snooze, key: AppPreferences.Key.discovery(prompt.type),
      secondaryAction: prompt.secondaryAction.map { action in
        Notice.Action(title: "Review caches", perform: { perform(action) })
      } ?? Notice.Action(title: "Don't suggest again", perform: never),
      alternateAction: prompt.secondaryAction == nil ? nil : Notice.Action(title: "Don't suggest again", perform: never))
  }

  static func open(_ action: DiscoveryAction) {
    switch action {
    case .addMachine(let mac, let hosted):
      OpenRequests.shared.addMachine = AddMachineRequest(machineID: mac?.id, hostedSimulators: hosted)
    case .reviewCaches: OpenRequests.shared.showsMachine = true
    case .pairPhone:
      MainWindow.show()
      OpenRequests.shared.pairsPhone = true
    }
  }
}
