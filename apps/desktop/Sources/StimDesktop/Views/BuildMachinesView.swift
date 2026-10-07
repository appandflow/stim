import StimKit
import StimStores
import SwiftUI

/// This Mac's build machines: the `offload.machines` it builds on, each with its state from `stim doctor`. Adding
/// one opens the wizard, which does the tailnet discovery and the setup. Stim Desktop changes the setting with
/// `stim settings` and asks for access with `stim doctor --fix`; approving happens on the other Mac.
struct BuildMachinesView: View {
  var model: BuildMachinesModel
  @ObservedObject var store: StatusStore
  var workspace: String?

  @State private var confirmsDeleteSample = false
  @State private var removing: String?
  @State private var detailed: String?
  @State private var adding: AddMachineModel?
  @AppStorage(AppPreferences.Key.updatesBuildMachines) private var updatesAutomatically = false

  private var checkout: String? {
    doctorCheckout(for: workspace, in: store.payload?.environments ?? [], project: store.project(ofPath:))?.path
  }

  var body: some View {
    BuildMachinesContent(
      entries: model.entries, statuses: statuses, hosts: model.check(in: checkout)?.hosts, updates: model.updates,
      working: model.working, refreshing: model.isBusy, failure: failure, tailscaleRunning: model.tailscaleRunning,
      canAsk: checkout != nil,
      addDisabled: model.isBusy || model.updates.values.contains { !$0.isDone }, sampleExists: model.sampleExists,
      updatesAutomatically: $updatesAutomatically,
      add: { adding = model.addMachine(checkout: checkout) },
      ask: { entry in Task { await model.ask(entry, checkout: checkout) } },
      update: { entry in Task { await model.update(entry, checkout: checkout) } },
      showDetails: { entry in detailed = entry }, remove: { entry in removing = entry },
      deleteSample: { confirmsDeleteSample = true }
    )
    .background(Palette.background)
    .onReceive(OpenRequests.shared.$addMachine) { request in
      guard let request else { return }
      Task { @MainActor in
        OpenRequests.shared.addMachine = nil
        guard adding == nil else { return }
        let wizard = model.addMachine(checkout: request.checkout ?? checkout)
        wizard.preselect(machineID: request.machineID, hostedSimulators: request.hostedSimulators)
        adding = wizard
      }
    }
    .task { await model.load(checkout: checkout) }
    .task(id: PollKey(waiting: waiting, checkout: checkout)) {
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(waiting ? 15 : 60))
        guard !model.isBusy, !Task.isCancelled, !(model.entries ?? []).isEmpty else { continue }
        await model.checkTailscale()
        await model.refreshStatuses(checkout: checkout, ask: false)
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
    .sheet(
      isPresented: .init(get: { detailed != nil }, set: { if !$0 { detailed = nil } })
    ) {
      if let entry = detailed {
        BuildMachineDetails(
          entry: entry, status: statuses?.first { $0.machine == entry },
          capabilities: buildMachineCapabilities(entry, hosts: model.check(in: checkout)?.hosts)
        ) { detailed = nil }
      }
    }
    .onQuitRequested {
      adding?.stop()
      adding = nil
    }
    .confirmationDialog("Delete the wizard's sample app?", isPresented: $confirmsDeleteSample) {
      Button("Delete sample app", role: .destructive) { Task { await model.deleteSample() } }
    } message: {
      Text(
        "Stops the sample workspace and removes its Stim workspace and Stim Desktop's SDK 58 sample folder, and releases its owned simulator: Stim parks it for reuse within the parked-simulator limit and deletes it otherwise. The next wizard creates the sample again."
      )
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
      return "Builds on this Mac stop going to it."
    }
    return "Builds stop going to it, and this Mac forgets the old node and asks again any listed Mac that has not approved it."
  }

  private var statuses: [BuildMachineStatus]? {
    guard let check = model.check(in: checkout) else { return nil }
    return check.problem == nil ? check.statuses : []
  }

  private var failure: String? {
    if let failure = model.writeFailure ?? model.settingsFailure { return failure }
    guard checkout != nil, let problem = model.check(in: checkout)?.problem else { return nil }
    switch problem {
    case .unsupported: return "This stim does not report build machines; update it."
    case .failed(let message): return "stim doctor failed: \(message)"
    }
  }

  private var waiting: Bool { statuses?.contains { $0.state == .pending } == true }
}

private struct PollKey: Hashable {
  var waiting: Bool
  var checkout: String?
}

/// The Build Machines tab for the state it is given: a progress view, the empty state, or the list.
struct BuildMachinesContent: View {
  var entries: [String]?
  var statuses: [BuildMachineStatus]?
  var hosts: [BuildMachineStatus]?
  var updates: [String: MachineUpdatePhase]
  var working: String?
  var refreshing: Bool
  var failure: String?
  var tailscaleRunning: Bool?
  var canAsk: Bool
  var addDisabled: Bool
  var sampleExists: Bool
  @Binding var updatesAutomatically: Bool
  var add: () -> Void
  var ask: (String) -> Void
  var update: (String) -> Void
  var showDetails: (String) -> Void
  var remove: (String) -> Void
  var deleteSample: () -> Void

  var body: some View {
    if let entries {
      if entries.isEmpty {
        VStack(spacing: 0) {
          notices.padding([.horizontal, .top], Space.xl)
          BuildMachinesEmptyState(add: add, addDisabled: addDisabled)
          if sampleExists { deleteSampleButton.padding(.bottom, Space.xl) }
        }
      } else {
        list(entries)
      }
    } else {
      ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
    }
  }

  @ViewBuilder private var notices: some View {
    VStack(alignment: .leading, spacing: Space.md) {
      if let failure {
        Text(failure).foregroundStyle(Palette.error).textSelection(.enabled)
      }
      if tailscaleRunning == false {
        Label("Tailscale is not running, so Stim cannot reach other Macs.", systemImage: "exclamationmark.triangle.fill")
          .foregroundStyle(Palette.warning)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func list(_ entries: [String]) -> some View {
    Form {
      if failure != nil || tailscaleRunning == false { Section { notices } }
      Section {
        ForEach(entries, id: \.self) { entry in
          let status = statuses?.first { $0.machine == entry }
          BuildMachineRow(
            entry: entry, status: status, checking: canAsk && (statuses == nil || (status == nil && refreshing)),
            failed: canAsk && failure != nil && status == nil,
            refreshing: canAsk && refreshing && status != nil && working != entry,
            capabilities: buildMachineCapabilities(entry, hosts: hosts), working: working == entry,
            canAsk: canAsk, update: updates[entry], ask: { ask(entry) }, startUpdate: { update(entry) },
            showDetails: { showDetails(entry) }, remove: { remove(entry) })
        }
      } header: {
        HStack {
          Text("Build machines")
          Spacer()
          Button("Add Build Machine\u{2026}", action: add).buttonStyle(.stim(.primary)).disabled(addDisabled)
        }
      } footer: {
        if !canAsk {
          Text("Start a workspace with Stim to check these machines.").foregroundStyle(Palette.tertiary)
        }
      }
      Section {
        VStack(alignment: .leading, spacing: Space.xxs) {
          Toggle("Keep build machines on this Mac's Stim version", isOn: $updatesAutomatically)
          Text("When this Mac's Stim changes, update stim-server on approved build machines so builds can keep offloading.")
            .font(.stim(.footnote)).foregroundStyle(Palette.secondary)
        }
      }
      if sampleExists { Section { deleteSampleButton } }
    }
    .formStyle(.grouped)
    .scrollContentBackground(.hidden)
  }

  private var deleteSampleButton: some View {
    Button("Delete sample app", role: .destructive, action: deleteSample)
  }
}

private struct BuildMachineRow: View {
  var entry: String
  var status: BuildMachineStatus?
  var checking: Bool
  var failed: Bool
  var refreshing: Bool
  var capabilities: [String]
  var working: Bool
  var canAsk: Bool
  var update: MachineUpdatePhase?
  var ask: () -> Void
  var startUpdate: () -> Void
  var showDetails: () -> Void
  var remove: () -> Void

  var body: some View {
    HStack(alignment: .top, spacing: Space.lg) {
      Image(systemName: "desktopcomputer").font(.system(size: 18)).foregroundStyle(Palette.accent)
      VStack(alignment: .leading, spacing: Space.xs) {
        HStack(spacing: Space.sm) {
          Text(verbatim: entry).font(.stim(.body, weight: .semibold)).lineLimit(1)
          if let status {
            let listed = status.listStatus
            Pill(listed.title, tone: listed.tone, size: .small).help(status.readiness.reasons ?? status.detail)
            if refreshing { ProgressView().controlSize(.mini).help("Checking again") }
          } else if checking {
            Pill("Checking\u{2026}", size: .small)
          } else if failed {
            Pill("Couldn\u{2019}t check", tone: .warning, size: .small)
          }
        }
        if let status {
          if !status.rowDetail.isEmpty {
            Text(verbatim: status.rowDetail).font(.stim(.footnote)).foregroundStyle(Palette.secondary)
              .fixedSize(horizontal: false, vertical: true)
          }
          ForEach(Array(status.problemLines.enumerated()), id: \.offset) { _, line in
            VStack(alignment: .leading, spacing: Space.xxs) {
              Text(verbatim: line.reason).font(.stim(.footnote)).foregroundStyle(Palette.warning).textSelection(.enabled)
              switch line.fix {
              case .command(let command)?: CopyableCommand(command: command)
              case .advice(let advice)?:
                Text(verbatim: advice).font(.stim(.footnote)).foregroundStyle(Palette.secondary)
              case nil: EmptyView()
              }
            }
          }
        }
        HStack(spacing: Space.xs) {
          ForEach(capabilities, id: \.self) { name in Pill(tone: .neutral, size: .small, outlined: true) { Text(verbatim: name) }
          }
        }
        if let command = status?.approvalCommand, let status {
          Text(verbatim: "\(status.approvalPrompt), or runs this there:")
            .font(.stim(.footnote)).foregroundStyle(Palette.secondary).fixedSize(horizontal: false, vertical: true)
          CopyableCommand(command: command)
          Text(BuildMachineStatus.requestLapse).font(.stim(.footnote)).foregroundStyle(Palette.secondary)
        }
        MachineUpdateLine(phase: update, needed: status.map(needsStimUpdate) ?? false, update: startUpdate)
      }
      Spacer()
      if working { ProgressView().controlSize(.small) }
      if let status, status.state.canAsk(requested: status.deviceId != nil) {
        Button(status.state == .notAsked ? "Ask" : "Ask Again", action: ask).disabled(working || !canAsk)
      }
      Menu {
        Button("Details\u{2026}", action: showDetails)
        Button("Remove", role: .destructive, action: remove)
          .disabled(working || (status?.state == .nodeChanged && !canAsk))
      } label: {
        Image(systemName: "ellipsis.circle")
      }
      .menuStyle(.borderlessButton)
      .menuIndicator(.hidden)
      .fixedSize()
      .accessibilityLabel("More actions for \(entry)")
    }
    .padding(.vertical, Space.xxs)
  }
}

private struct BuildMachineDetails: View {
  var entry: String
  var status: BuildMachineStatus?
  var capabilities: [String]
  var done: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: Space.lg) {
      MachineHeading(icon: "desktopcomputer", title: entry, subtitle: status?.dnsName) {
        if let status {
          let listed = status.listStatus
          Pill(listed.title, tone: listed.tone, size: .small)
        }
      }
      if let status {
        Text(verbatim: status.detail).foregroundStyle(Palette.secondary).textSelection(.enabled)
        if let reasons = status.readiness.reasons {
          Text(verbatim: reasons).font(.stim(.footnote)).foregroundStyle(Palette.secondary).textSelection(.enabled)
        }
        if let capacity = status.capacity?.line, !capacity.isEmpty {
          Text(verbatim: capacity).font(.stim(.footnote)).foregroundStyle(Palette.tertiary)
        }
      } else {
        Text("Checking\u{2026}").foregroundStyle(Palette.secondary)
      }
      HStack(spacing: Space.xs) {
        ForEach(capabilities, id: \.self) { name in Pill(tone: .neutral, size: .small, outlined: true) { Text(verbatim: name) } }
      }
      HStack {
        Spacer()
        Button("Done", action: done).buttonStyle(.stim(.primary)).keyboardShortcut(.defaultAction)
      }
    }
    .padding(Space.xxl)
    .frame(width: 440)
  }
}
