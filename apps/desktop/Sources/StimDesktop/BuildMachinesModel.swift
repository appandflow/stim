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
    var problem: Problem?
  }

  private(set) var macs: [TailnetMac]?
  private(set) var stimMacs: Set<String> = []
  private(set) var probing = false
  private(set) var working: String?
  private(set) var writeFailure: String?
  private(set) var runs = 0
  private(set) var stats = Fetched<MachineStats>()
  private var checks: [String: Check] = [:]

  let settings: MachineSettingsStore
  private let cli: Task<StimCLI, Never>
  @ObservationIgnored private var latestRun: [String: Int] = [:]
  @ObservationIgnored private var latestStatsRun = 0

  init(cli: Task<StimCLI, Never>, settings: MachineSettingsStore) {
    self.cli = cli
    self.settings = settings
  }

  var entries: [String]? {
    settings.payload.map { $0.entry("offload.machines")?.value.strings ?? [] }
  }

  var isBusy: Bool { working != nil || runs > 0 }

  func check(in checkout: String?) -> Check? { checkout.flatMap { checks[$0] } }

  var settingsFailure: String? {
    if let error = settings.error { return error }
    guard let payload = settings.payload, payload.entry("offload.machines") == nil else { return nil }
    return "This stim has no offload.machines setting; update it."
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
    let cli = await cli.value
    let result = await Result.awaiting { try await cli.machineStats() }
    guard run == latestStatsRun, !Task.isCancelled else { return }
    stats.record(result)
  }

  func load(checkout: String?) async {
    let cli = await cli.value
    probing = true
    let environment = cli.environment
    async let settingsRead: Void = settings.refresh()
    let found = await Task.detached { Tailnet.status(environment: environment).flatMap(Tailnet.macs(statusJSON:)) }.value
    macs = found
    await settingsRead
    await refreshStatuses(checkout: checkout, ask: false)
    var serving: Set<String> = []
    await withTaskGroup(of: (String, Bool).self) { group in
      for mac in found ?? [] { group.addTask { (mac.id, await Tailnet.servesStim(dnsName: mac.dnsName)) } }
      for await (id, serves) in group where serves { serving.insert(id) }
    }
    stimMacs = serving
    probing = false
  }

  func refreshStatuses(checkout: String?, ask: Bool) async {
    guard let checkout else { return }
    let run = (latestRun[checkout] ?? 0) + 1
    latestRun[checkout] = run
    guard ask || !(entries ?? []).isEmpty else {
      checks[checkout] = Check(statuses: [], problem: nil)
      return
    }
    runs += 1
    defer { runs -= 1 }
    let cli = await cli.value
    let result = await Result.awaiting { try await cli.buildMachines(cwd: checkout, ask: ask) }
    guard run == latestRun[checkout], !Task.isCancelled else { return }
    switch result {
    case .success(let reported?): checks[checkout] = Check(statuses: reported, problem: nil)
    case .success(nil): checks[checkout] = Check(statuses: [], problem: .unsupported)
    case .failure(let error):
      checks[checkout] = Check(statuses: check(in: checkout)?.statuses ?? [], problem: .failed(error.localizedDescription))
    }
  }

  func ask(_ entry: String, checkout: String?) async {
    working = entry
    await refreshStatuses(checkout: checkout, ask: true)
    working = nil
  }

  func use(_ mac: TailnetMac, checkout: String?) async {
    await write(mac.machine, value: OffloadMachines.adding(mac.machine, to: entries ?? []), ask: true, checkout: checkout)
  }

  func remove(_ entry: String, checkout: String?) async {
    let repins = check(in: checkout)?.statuses.first { $0.machine == entry }?.state == .nodeChanged
    await write(entry, value: OffloadMachines.removing(entry, from: entries ?? []), ask: repins, checkout: checkout)
  }

  private func write(_ entry: String, value: String?, ask: Bool, checkout: String?) async {
    working = entry
    let result = await settings.write("offload.machines", value: value, scope: .machine, cwd: NSHomeDirectory())
    switch result {
    case .success(.written):
      writeFailure = nil
      let others = checks.keys.filter { $0 != checkout }
      checks = checks.filter { others.contains($0.key) }
      await refreshStatuses(checkout: checkout, ask: ask)
      for other in others { await refreshStatuses(checkout: other, ask: false) }
    case .success(.refused(let refusal)):
      writeFailure = [refusal.message, refusal.remedy].compactMap { $0 }.joined(separator: " ")
    case .failure(let error): writeFailure = error.localizedDescription
    }
    working = nil
  }
}
