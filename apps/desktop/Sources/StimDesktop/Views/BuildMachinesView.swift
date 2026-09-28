import StimKit
import SwiftUI

/// This Mac's side of build offload: the `offload.machines` it builds on, with each one's state from `stim doctor`,
/// and the other Macs on the tailnet that run stim-server. It changes the setting with `stim settings` and asks for
/// access with `stim doctor --fix`; approving happens on the other Mac.
struct BuildMachinesView: View {
  var cli: Task<StimCLI, Never>
  @ObservedObject var store: StatusStore
  var onSettingChanged: () -> Void

  @State private var entries: [String]?
  @State private var statuses: [BuildMachineStatus]?
  @State private var macs: [TailnetMac]?
  @State private var stimMacs: Set<String> = []
  @State private var probing = false
  @State private var working: String?
  @State private var failure: String?
  @State private var removing: String?
  @State private var runs = 0
  @State private var latestRun = 0

  private var checkout: String? {
    doctorCheckouts(store.payload?.environments ?? [], project: store.project(ofPath:)).first?.path
  }

  var body: some View {
    Form {
      Section {
        if let failure {
          Text(failure).foregroundStyle(Palette.error).textSelection(.enabled)
        }
        if let entries {
          if entries.isEmpty {
            Text("This Mac builds only on itself.").foregroundStyle(Palette.secondary)
          }
          ForEach(entries, id: \.self) { entry in
            MachineRow(
              entry: entry, status: statuses?.first { $0.machine == entry }, checking: statuses == nil,
              working: working == entry, canAsk: checkout != nil
            ) {
              ask(entry)
            } remove: {
              removing = entry
            }
          }
        } else {
          ProgressView().frame(maxWidth: .infinity)
        }
      } header: {
        HStack {
          Text("This Mac builds on")
          Spacer()
          Button("Refresh") { Task { await load() } }
            .disabled(working != nil || runs > 0 || probing)
        }
      } footer: {
        Text(footer)
          .foregroundStyle(Palette.tertiary)
          .multilineTextAlignment(.leading)
          .frame(maxWidth: .infinity, alignment: .leading)
      }

      Section {
        discovered
      } header: {
        Text("Macs on your tailnet")
      } footer: {
        Text(
          "Macs that answer as stim-server on their tailscale serve route, port \(String(Tailnet.servePort)). On a Mac that should build for others, turn on Serve to phones in Stim Desktop's Phones tab and add the route it shows."
        )
        .foregroundStyle(Palette.tertiary)
        .multilineTextAlignment(.leading)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .formStyle(.grouped)
    .scrollContentBackground(.hidden)
    .background(Palette.background)
    .task { await load() }
    .task(id: waiting) {
      while waiting, !Task.isCancelled {
        try? await Task.sleep(for: .seconds(15))
        if working == nil, runs == 0, !Task.isCancelled { await refreshStatuses(ask: false) }
      }
    }
    .confirmationDialog(
      "Stop building on \(removing ?? "")?", isPresented: .init(get: { removing != nil }, set: { if !$0 { removing = nil } }),
      presenting: removing
    ) { entry in
      Button("Remove", role: .destructive) { remove(entry) }
    } message: { entry in
      Text(removalMessage(entry))
    }
  }

  private func removalMessage(_ entry: String) -> String {
    guard statuses?.first(where: { $0.machine == entry })?.state == .nodeChanged else {
      return "Removes it from offload.machines. The next stim doctor --fix forgets its pairing."
    }
    return
      "Removes it from offload.machines and runs stim doctor --fix, which forgets the old node and asks again any listed Mac that has not approved this one."
  }

  private var waiting: Bool { statuses?.contains { $0.state == .pending } == true }

  private var footer: String {
    let base =
      "offload.machines on this Mac. Use for builds adds a Mac and asks it for access with stim doctor --fix, which also asks again any listed Mac that has not approved this one. A person on that Mac allows it."
    guard let checkout else {
      return base + " Stim runs doctor in a workspace, and none is listed yet: start one with Stim first."
    }
    return base + " Doctor runs in \(abbreviatingHome(checkout))."
  }

  @ViewBuilder private var discovered: some View {
    let listed = entries ?? []
    if let macs {
      let candidates = macs.filter { mac in stimMacs.contains(mac.id) && !listed.contains { OffloadMachines.names($0, mac) } }
      if candidates.isEmpty {
        HStack(spacing: Space.md) {
          if probing { ProgressView().controlSize(.small) }
          Text(
            probing
              ? "Looking for stim-server on \(macs.count) \(macs.count == 1 ? "Mac" : "Macs")\u{2026}"
              : macs.isEmpty ? "No other Mac on your tailnet is online." : "No other Mac on your tailnet runs stim-server."
          )
          .foregroundStyle(Palette.secondary)
        }
      }
      ForEach(candidates) { mac in
        HStack(spacing: Space.lg) {
          Image(systemName: "desktopcomputer").font(.system(size: 18)).foregroundStyle(Palette.accent)
          VStack(alignment: .leading, spacing: Space.xxs) {
            Text(verbatim: mac.hostName).font(.stim(.body, weight: .semibold)).lineLimit(1)
            Text(verbatim: mac.dnsName).font(.stim(.caption, mono: true)).foregroundStyle(Palette.secondary)
              .lineLimit(1).truncationMode(.middle)
          }
          Spacer()
          if working == mac.machine { ProgressView().controlSize(.small) }
          Button("Use for Builds") { use(mac) }
            .disabled(working != nil || checkout == nil)
        }
        .padding(.vertical, Space.xxs)
      }
    } else if probing {
      ProgressView().frame(maxWidth: .infinity)
    } else {
      Text("Tailscale is not running, so Stim cannot find other Macs.").foregroundStyle(Palette.secondary)
    }
  }

  private func load() async {
    let cli = await cli.value
    async let settings = Task.detached { Result { try cli.settings(cwd: NSHomeDirectory()) } }.value
    probing = true
    let environment = cli.environment
    let found = await Task.detached { Tailnet.status(environment: environment).flatMap(Tailnet.macs(statusJSON:)) }.value
    macs = found
    switch await settings {
    case .success(let payload):
      entries = payload.entry("offload.machines")?.value.strings ?? []
      failure = payload.entry("offload.machines") == nil ? "This stim has no offload.machines setting; update it." : nil
    case .failure(let error): failure = error.localizedDescription
    }
    await refreshStatuses(ask: false)
    var serving: Set<String> = []
    await withTaskGroup(of: (String, Bool).self) { group in
      for mac in found ?? [] { group.addTask { (mac.id, await Tailnet.servesStim(dnsName: mac.dnsName)) } }
      for await (id, serves) in group where serves { serving.insert(id) }
    }
    stimMacs = serving
    probing = false
  }

  private func refreshStatuses(ask: Bool) async {
    guard let checkout, ask || !(entries ?? []).isEmpty else {
      statuses = []
      return
    }
    runs += 1
    latestRun += 1
    let run = latestRun
    defer { runs -= 1 }
    let cli = await cli.value
    let result = await Task.detached(operation: { Result { try cli.buildMachines(cwd: checkout, ask: ask) } }).value
    guard run == latestRun else { return }
    switch result {
    case .success(let reported):
      statuses = reported ?? []
      if reported == nil { failure = "This stim does not report build machines; update it." }
    case .failure(let error):
      statuses = []
      failure = "stim doctor failed in \(abbreviatingHome(checkout)): \(error.localizedDescription)"
    }
  }

  private func use(_ mac: TailnetMac) {
    write(mac.machine, value: OffloadMachines.adding(mac.machine, to: entries ?? []), ask: true)
  }

  private func ask(_ entry: String) {
    working = entry
    Task {
      await refreshStatuses(ask: true)
      working = nil
    }
  }

  /// Removing a machine pinned to a node that changed runs `doctor --fix`, which forgets the old pin, so the Mac
  /// can be used for builds again.
  private func remove(_ entry: String) {
    let repins = statuses?.first { $0.machine == entry }?.state == .nodeChanged
    write(entry, value: OffloadMachines.removing(entry, from: entries ?? []), ask: repins)
  }

  private func write(_ entry: String, value: String?, ask: Bool) {
    working = entry
    Task {
      let cli = await cli.value
      let result = await Task.detached {
        Result { try cli.writeSetting("offload.machines", value: value, scope: .machine, cwd: NSHomeDirectory()) }
      }.value
      switch result {
      case .success(.written(let setting)):
        failure = nil
        entries = setting.value.strings ?? []
        onSettingChanged()
        statuses = nil
        await refreshStatuses(ask: ask)
      case .success(.refused(let refusal)):
        failure = [refusal.message, refusal.remedy].compactMap { $0 }.joined(separator: " ")
      case .failure(let error): failure = error.localizedDescription
      }
      working = nil
    }
  }
}

private struct MachineRow: View {
  var entry: String
  var status: BuildMachineStatus?
  var checking: Bool
  var working: Bool
  var canAsk: Bool
  var ask: () -> Void
  var remove: () -> Void

  var body: some View {
    HStack(alignment: .top, spacing: Space.lg) {
      Image(systemName: "desktopcomputer").font(.system(size: 18)).foregroundStyle(Palette.accent)
      VStack(alignment: .leading, spacing: Space.xxs) {
        HStack(spacing: Space.sm) {
          Text(verbatim: entry).font(.stim(.body, weight: .semibold)).lineLimit(1)
          if let status {
            Pill(status.state.title, tone: tone(status.state), size: .small)
          } else if checking {
            Pill("Checking\u{2026}", size: .small)
          }
        }
        if let status {
          Text(verbatim: status.detail).font(.stim(.footnote)).foregroundStyle(Palette.secondary)
            .fixedSize(horizontal: false, vertical: true)
          if let dnsName = status.dnsName {
            Text(verbatim: dnsName).font(.stim(.caption, mono: true)).foregroundStyle(Palette.tertiary)
              .lineLimit(1).truncationMode(.middle)
          }
        }
      }
      Spacer()
      if working { ProgressView().controlSize(.small) }
      if let status, status.state.canAsk(requested: status.deviceId != nil) {
        Button(status.state == .notAsked ? "Ask" : "Ask Again", action: ask).disabled(working || !canAsk)
      }
      Button("Remove", role: .destructive, action: remove)
        .disabled(working || (status?.state == .nodeChanged && !canAsk))
    }
    .padding(.vertical, Space.xxs)
  }

  private func tone(_ state: BuildMachineStatus.State) -> PillTone {
    switch state {
    case .approved: return .success
    case .pending: return .warning
    case .notAsked, .unknown: return .neutral
    case .revoked, .nodeChanged, .invalid: return .error
    case .notOnTailnet, .tailscaleOff, .unreachable: return .warning
    }
  }
}
