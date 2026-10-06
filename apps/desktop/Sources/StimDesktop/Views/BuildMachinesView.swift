import StimKit
import StimStores
import SwiftUI

/// This Mac's side of build offload: the `offload.machines` it builds on, with each one's state from `stim doctor`,
/// and the other Macs on the tailnet that run stim-server. It changes the setting with `stim settings` and asks for
/// access with `stim doctor --fix`; approving happens on the other Mac.
struct BuildMachinesView: View {
  var model: BuildMachinesModel
  @ObservedObject var store: StatusStore
  var workspace: String?

  @State private var confirmsDeleteSample = false
  @State private var removing: String?
  @State private var adding: AddMachineModel?
  @AppStorage(AppPreferences.Key.updatesBuildMachines) private var updatesAutomatically = false

  private var checkout: String? {
    doctorCheckout(for: workspace, in: store.payload?.environments ?? [], project: store.project(ofPath:))?.path
  }

  var body: some View {
    Form {
      Section {
        if let failure {
          Text(failure).foregroundStyle(Palette.error).textSelection(.enabled)
        }
        if let entries = model.entries {
          if entries.isEmpty {
            Text("This Mac builds only on itself.").foregroundStyle(Palette.secondary)
          }
          ForEach(entries, id: \.self) { entry in
            MachineRow(
              entry: entry, status: statuses?.first { $0.machine == entry }, checking: statuses == nil,
              working: model.working == entry, canAsk: checkout != nil, update: model.updates[entry]
            ) {
              Task { await model.ask(entry, checkout: checkout) }
            } remove: {
              removing = entry
            } startUpdate: {
              Task { await model.update(entry, checkout: checkout) }
            }
          }
          if !entries.isEmpty {
            Toggle("Install this Mac's build on build machines automatically", isOn: $updatesAutomatically)
              .help(
                "When a build machine runs another Stim build than this Mac, Desktop installs this Mac's build there the next time it checks the machine."
              )
          }
        } else {
          ProgressView().frame(maxWidth: .infinity)
        }
      } header: {
        HStack {
          Text("This Mac builds on")
          Spacer()
          Button("Add\u{2026}") { adding = model.addMachine(checkout: checkout) }
            .disabled(model.isBusy || model.probing || model.updates.values.contains { !$0.isDone })
          Button("Refresh") { Task { await model.load(checkout: checkout) } }
            .disabled(model.isBusy || model.probing)
        }
      } footer: {
        Text(footer)
          .foregroundStyle(Palette.tertiary)
          .multilineTextAlignment(.leading)
          .frame(maxWidth: .infinity, alignment: .leading)
      }

      if model.sampleExists {
        Section {
          Button("Delete sample app", role: .destructive) { confirmsDeleteSample = true }
        }
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
    .task { await model.load(checkout: checkout) }
    .task(id: waiting) {
      while waiting, !Task.isCancelled {
        try? await Task.sleep(for: .seconds(15))
        if !model.isBusy, !Task.isCancelled { await model.refreshStatuses(checkout: checkout, ask: false) }
      }
    }
    .sheet(
      isPresented: Binding(
        get: { adding != nil },
        set: {
          if !$0 {
            adding?.stop()
            adding = nil
          }
        }),
      onDismiss: {
        Task { await model.load(checkout: checkout) }
      }
    ) {
      if let adding { AddMachineSheet(model: adding) }
    }
    .onQuitRequested {
      adding?.stop()
      adding = nil
    }
    .confirmationDialog("Delete the wizard's sample app?", isPresented: $confirmsDeleteSample) {
      Button("Delete sample app", role: .destructive) { Task { await model.deleteSample() } }
    } message: {
      Text("Stops the sample workspace and removes only Stim Desktop's SDK 57 sample folder. The next wizard creates it again.")
    }
    .confirmationDialog(
      "Stop building on \(removing ?? "")?", isPresented: .init(get: { removing != nil }, set: { if !$0 { removing = nil } }),
      presenting: removing
    ) { entry in
      Button("Remove", role: .destructive) { Task { await model.remove(entry, checkout: checkout) } }
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

  private var statuses: [BuildMachineStatus]? {
    guard let check = model.check(in: checkout) else { return nil }
    return check.problem == nil ? check.statuses : []
  }

  private var failure: String? {
    if let failure = model.writeFailure ?? model.settingsFailure { return failure }
    guard let checkout, let problem = model.check(in: checkout)?.problem else { return nil }
    switch problem {
    case .unsupported: return "This stim does not report build machines; update it."
    case .failed(let message): return "stim doctor failed in \(abbreviatingHome(checkout)): \(message)"
    }
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
    let listed = model.entries ?? []
    if let macs = model.macs {
      let candidates = macs.filter { mac in model.stimMacs.contains(mac.id) && !listed.contains { OffloadMachines.names($0, mac) }
      }
      if candidates.isEmpty {
        HStack(spacing: Space.md) {
          if model.probing { ProgressView().controlSize(.small) }
          Text(
            model.probing
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
          if model.working == mac.machine { ProgressView().controlSize(.small) }
          Button("Use for Builds") { Task { await model.use(mac, checkout: checkout) } }
            .disabled(model.working != nil || checkout == nil)
        }
        .padding(.vertical, Space.xxs)
      }
    } else if model.probing {
      ProgressView().frame(maxWidth: .infinity)
    } else {
      Text("Tailscale is not running, so Stim cannot find other Macs.").foregroundStyle(Palette.secondary)
    }
  }
}

private struct MachineRow: View {
  var entry: String
  var status: BuildMachineStatus?
  var checking: Bool
  var working: Bool
  var canAsk: Bool
  var update: MachineUpdatePhase?
  var ask: () -> Void
  var remove: () -> Void
  var startUpdate: () -> Void

  var body: some View {
    HStack(alignment: .top, spacing: Space.lg) {
      Image(systemName: "desktopcomputer").font(.system(size: 18)).foregroundStyle(Palette.accent)
      VStack(alignment: .leading, spacing: Space.xxs) {
        HStack(spacing: Space.sm) {
          Text(verbatim: entry).font(.stim(.body, weight: .semibold)).lineLimit(1)
          if let status {
            if status.state == .approved, status.offloadable != nil {
              let ready = status.readiness
              Pill(ready.title, tone: ready.tone, size: .small).help(ready.reasons ?? "")
            } else {
              Pill(status.state.title, tone: tone(status.state), size: .small)
            }
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
          MachineUpdateLine(phase: update, needed: needsStimUpdate(status), update: startUpdate)
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

  private func tone(_ state: BuildMachineStatus.State) -> Tone {
    switch state {
    case .approved: return .success
    case .pending: return .warning
    case .notAsked, .unknown: return .neutral
    case .revoked, .nodeChanged, .invalid: return .error
    case .notOnTailnet, .tailscaleOff, .unreachable: return .warning
    }
  }
}
