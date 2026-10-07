import Combine
import Foundation
import Observation
import StimKit
import StimStores

@MainActor
final class TipCoordinator: ObservableObject {
  @Published private(set) var topic: TipTopic?
  @Published private(set) var hasNext = false
  @Published private(set) var usageGate = false
  private let status: StatusStore
  private let machines: BuildMachinesModel
  private let persistence: TipStore
  private let discovery: DiscoveryStore
  private let tutorial: TutorialRecordStore
  private let defaults: UserDefaults
  private var subscriptions: Set<AnyCancellable> = []
  private var launchTimer: Timer?
  private var pollTimer: Timer?
  private var polling = false

  init(status: StatusStore, machines: BuildMachinesModel, defaults: UserDefaults = .standard) {
    self.status = status
    self.machines = machines
    self.defaults = defaults
    persistence = TipStore(defaults: defaults)
    discovery = DiscoveryStore(defaults: defaults)
    tutorial = TutorialRecordStore(defaults)
  }

  func start() {
    guard subscriptions.isEmpty else { return }
    status.$payload.compactMap { $0 }.sink { [weak self] payload in
      guard let self else { return }
      var usage = persistence.usage
      usage.observe(payload.environments, now: Date(), calendar: .current)
      if usage != persistence.usage { persistence.usage = usage }
      scheduleEvaluation()
    }.store(in: &subscriptions)
    NoticeCenter.shared.objectWillChange.sink { [weak self] _ in self?.scheduleEvaluation() }.store(in: &subscriptions)
    ServerController.shared.objectWillChange.sink { [weak self] _ in self?.scheduleEvaluation() }.store(in: &subscriptions)
    NotificationCenter.default.publisher(for: UserDefaults.didChangeNotification, object: defaults)
      .receive(on: DispatchQueue.main)
      .sink { [weak self] _ in self?.scheduleEvaluation() }.store(in: &subscriptions)
    trackMachines()
    launchTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated { self?.poll() }
    }
    pollTimer = Timer.scheduledTimer(withTimeInterval: 600, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.poll() }
    }
    poll()
  }

  private func scheduleEvaluation() {
    Task { [weak self] in self?.evaluate() }
  }

  private func trackMachines() {
    withObservationTracking {
      _ = machines.entries
      _ = machines.macs
      _ = machines.settings.payload
      _ = machines.settings.error
    } onChange: { [weak self] in
      Task { @MainActor in
        self?.evaluate()
        self?.trackMachines()
      }
    }
  }

  private func poll() {
    guard !polling else { return }
    polling = true
    Task {
      await machines.refreshTailnet()
      await machines.settings.refresh()
      polling = false
      evaluate()
    }
  }

  private var inputs: TipInputs {
    var inputs = TipInputs()
    if machines.settings.error == nil {
      inputs.machines = machines.entries
      inputs.hosting = machines.settings.payload.map { $0.entry("hosting.machines")?.value.strings ?? [] }
    }
    inputs.macs = machines.macs
    inputs.pairedPhones = ServerController.shared.pairedPhoneCount
    inputs.tutorialCompleted = tutorial.completed
    inputs.sidebar = SidebarPreferences().options
    inputs.rows = status.sidebarList(inputs.sidebar).count
    inputs.workspaces = status.payload?.environments ?? []
    return inputs
  }

  private func evaluate(next: Bool = false) {
    let now = Date()
    let calendar = Calendar.current
    let inputs = inputs
    let gate =
      status.payload != nil && status.error == nil
      && Tips.gate(
        usage: persistence.usage, setupCompleted: discovery.setupCompleted,
        workspaces: inputs.workspaces, enabled: true)
    if usageGate != gate { usageGate = gate }
    var state = persistence.state
    var selected: TipTopic?
    var showsNext = false
    if Tips.visible(
      gate: gate && persistence.enabled, noticeCount: NoticeCenter.shared.notices.count, closedDay: state.closedDay, now: now,
      calendar: calendar)
    {
      selected =
        next
        ? Tips.next(inputs: inputs, state: &state, discoveries: discovery.states, now: now, calendar: calendar)
        : Tips.select(inputs: inputs, state: &state, discoveries: discovery.states, now: now, calendar: calendar)
      persistence.state = state
      showsNext =
        Tips.available(inputs: inputs, state: state, discoveries: discovery.states, now: now, calendar: calendar).count > 1
    }
    if topic != selected { topic = selected }
    if hasNext != showsNext { hasNext = showsNext }
  }

  func next() { evaluate(next: true) }

  func close() {
    persistence.close(now: Date(), calendar: .current)
    evaluate()
  }

  func perform() {
    guard let topic else { return }
    switch topic {
    case .buildMachine, .hostedSimulators:
      OpenRequests.shared.addMachine = AddMachineRequest(
        machineID: machines.macs?.first?.id, hostedSimulators: topic == .hostedSimulators)
    case .phone: OpenRequests.shared.pairsPhone = true
    case .tutorial: OpenRequests.shared.showTutorial()
    case .replay:
      OpenRequests.shared.workspacePath = inputs.workspaces.first { $0.recording?.enabled == true }?.path
    case .hideWorkspaces, .statusFilter: break
    }
  }
}
