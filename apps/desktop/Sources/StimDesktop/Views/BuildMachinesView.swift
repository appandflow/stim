import StimKit
import StimStores
import SwiftUI

/// This Mac's remote Macs: the `remote.machines` it builds on, each with its state from `stim doctor`. Adding
/// one opens the wizard, which does the tailnet discovery and the setup. Stim Desktop changes the setting with
/// `stim settings` and asks for access with `stim doctor --fix`; approving happens on the other Mac.
struct BuildMachinesView: View {
  var model: BuildMachinesModel
  @ObservedObject var store: StatusStore
  var workspace: String?
  var actions: ActionCenter?

  @State private var removing: String?
  @State private var adding: AddMachineModel?
  @AppStorage(AppPreferences.Key.updatesBuildMachines) private var updatesAutomatically = false
  @ObservedObject private var server = ServerController.shared
  @State private var hosted = HostedSessionsModel()
  @State private var revokingClient: PairedDevice?
  @State private var stoppingSession: HostedSession?

  private var hostClients: [PairedDevice] { server.devices.filter { $0.isBuildClient || $0.isDeviceHostClient } }

  private var checkout: String? {
    doctorCheckout(for: workspace, in: store.payload?.environments ?? [], project: store.project(ofPath:))?.path
  }

  var body: some View {
    BuildMachinesContent(
      entries: model.entries, statuses: statuses, hosts: model.check(in: checkout)?.hosts, updates: model.updates,
      working: model.working, progress: model.progress, refreshing: model.isBusy, failure: failure,
      tailscaleRunning: model.tailscaleRunning,
      canAsk: checkout != nil,
      addDisabled: model.working != nil,
      updatesAutomatically: $updatesAutomatically,
      add: { adding = model.addMachine(checkout: checkout) },
      ask: { entry in Task { await model.ask(entry, checkout: checkout) } },
      update: { entry in Task { await model.update(entry, checkout: checkout) } },
      remove: { entry in removing = entry },
      poolDisabled: model.poolDisabled,
      setPool: { role, machine, enabled in Task { await model.setPool(role, machine: machine, enabled: enabled) } },
      hosted: { hostedDevices(on: $0, in: store.payload?.environments ?? []) },
      stopHosted: { entry, devices in
        var steps: [StimCommand] = []
        for device in devices where !steps.contains(device.stop) { steps.append(device.stop) }
        guard !steps.isEmpty else { return }
        actions?.run("Stop hosted devices on \(entry)", steps: steps, key: "stop-hosted:\(entry)", present: false)
      },
      showsThisMac: ThisMacAccessSections.shows(clients: hostClients, sessions: hosted.sessions ?? []),
      thisMac: ThisMacAccessSections(
        clients: hostClients, sessions: hosted.sessions ?? [], stopping: hosted.stopping,
        review: { BuildRequestPrompt.present(id: $0.id) }, revoke: { revokingClient = $0 },
        stop: { stoppingSession = $0 })
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
    .task {
      while !Task.isCancelled {
        server.reloadDevices()
        await hosted.refresh()
        try? await Task.sleep(for: .seconds(5))
      }
    }
    .confirmationDialog(
      revokingClient.map { "\($0.pendingUntil == nil ? "Revoke" : "Deny") \($0.name)?" } ?? "",
      isPresented: .init(get: { revokingClient != nil }, set: { if !$0 { revokingClient = nil } }),
      presenting: revokingClient
    ) { device in
      Button(device.pendingUntil == nil ? "Revoke" : "Deny", role: .destructive) { server.revoke(device) }
    } message: { device in
      Text(
        device.isDeviceHostClient
          ? "That Mac's device hosting approval is removed. It must ask again."
          : device.pendingUntil != nil
            ? "That Mac cannot build here unless it asks again." : "That Mac can no longer build here and must ask again.")
    }
    .confirmationDialog(
      stoppingSession.map { "Stop \($0.client.name)'s \($0.device ?? $0.app ?? "session")?" } ?? "",
      isPresented: .init(get: { stoppingSession != nil }, set: { if !$0 { stoppingSession = nil } }),
      presenting: stoppingSession
    ) { session in
      Button("Stop", role: .destructive) { Task { await hosted.stop(session) } }
    } message: { _ in
      Text("This ends the session and deletes or parks its device on this Mac.")
    }
    .task(id: PollKey(waiting: waiting, checkout: checkout)) {
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(waiting ? 15 : 60))
        guard !model.isBusy, !Task.isCancelled, model.entries != nil else { continue }
        await model.checkTailscale()
        guard !(model.entries ?? []).isEmpty else { continue }
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
    .onQuitRequested {
      adding?.stop()
      adding = nil
    }
    .sheet(isPresented: .init(get: { removing != nil }, set: { if !$0 { removing = nil } })) {
      if let entry = removing {
        RemoveMachineSheet(
          entry: entry, message: removalMessage(entry),
          requests: [statuses?.first { $0.machine == entry }?.deviceId, hostRequest(entry)].compactMap { $0 },
          cancel: { removing = nil },
          remove: {
            removing = nil
            Task { await model.remove(entry, checkout: checkout) }
          })
      }
    }
  }

  private func hostRequest(_ entry: String) -> String? {
    model.check(in: checkout)?.hosts?.first { OffloadMachines.name($0.machine) == OffloadMachines.name(entry) }?.deviceId
  }

  private func removalMessage(_ entry: String) -> String {
    guard statuses?.first(where: { $0.machine == entry })?.state == .nodeChanged else {
      return "Removes it from remote.machines. Builds and hosted simulators stop going to it."
    }
    return
      "Builds stop going to it, and this Mac forgets the old node and asks again any listed machine that has not approved it."
  }

  private var statuses: [BuildMachineStatus]? {
    guard let check = model.check(in: checkout) else { return nil }
    return check.problem == nil ? check.statuses : []
  }

  private var failure: String? {
    if let failure = model.writeFailure ?? model.settingsFailure { return failure }
    guard checkout != nil, let problem = model.check(in: checkout)?.problem else { return nil }
    switch problem {
    case .unsupported: return "This stim does not report remote machines; update it."
    case .failed(let message): return "stim doctor failed: \(message)"
    }
  }

  private var waiting: Bool { statuses?.contains { $0.state == .pending } == true }
}

private struct PollKey: Hashable {
  var waiting: Bool
  var checkout: String?
}

/// The Remote Macs tab for the state it is given: a progress view, the empty state, or the list.
struct BuildMachinesContent<ThisMac: View>: View {
  var entries: [String]?
  var statuses: [BuildMachineStatus]?
  var hosts: [BuildMachineStatus]?
  var updates: [String: MachineUpdatePhase]
  var working: String?
  var progress: String?
  var refreshing: Bool
  var failure: String?
  var tailscaleRunning: Bool?
  var canAsk: Bool
  var addDisabled: Bool
  @Binding var updatesAutomatically: Bool
  var add: () -> Void
  var ask: (String) -> Void
  var update: (String) -> Void
  var remove: (String) -> Void
  var poolDisabled: [String: [String]]? = nil
  var setPool: (String, String, Bool) -> Void = { _, _, _ in }
  var hosted: (String) -> [HostedOnMachine] = { _ in [] }
  var stopHosted: (String, [HostedOnMachine]) -> Void = { _, _ in }
  var showsThisMac = false
  var thisMacName = Host.current().localizedName ?? "This Mac"
  var thisMac: ThisMac

  var body: some View {
    if let entries {
      if entries.isEmpty, showsThisMac || poolDisabled != nil {
        Form {
          localPool
          Section {
            notices
            BuildMachinesEmptyState(
              add: add, addDisabled: addDisabled, tailscaleOff: tailscaleRunning == false,
              checking: tailscaleRunning == nil)
          }
          thisMac
        }
        .formStyle(.grouped)
        .scrollContentBackground(.hidden)
      } else if entries.isEmpty {
        VStack(spacing: 0) {
          notices.padding([.horizontal, .top], Space.xl)
          BuildMachinesEmptyState(
            add: add, addDisabled: addDisabled, tailscaleOff: tailscaleRunning == false,
            checking: tailscaleRunning == nil)
        }
      } else {
        list(entries)
      }
    } else if showsThisMac {
      Form {
        Section { ProgressView().frame(maxWidth: .infinity) }
        thisMac
      }
      .formStyle(.grouped)
      .scrollContentBackground(.hidden)
    } else {
      ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
    }
  }

  @ViewBuilder private var notices: some View {
    VStack(alignment: .leading, spacing: Space.md) {
      if let failure {
        Text(failure).foregroundStyle(Palette.error).textSelection(.enabled)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  @ViewBuilder private var localPool: some View {
    if poolDisabled != nil {
      Section {
        HStack(alignment: .top, spacing: Space.lg) {
          Image(systemName: "laptopcomputer").font(.system(size: 18)).foregroundStyle(Palette.accent)
            .frame(width: 24).accessibilityHidden(true)
          VStack(alignment: .leading, spacing: Space.lg) {
            Text(verbatim: thisMacName).font(.stim(.body, weight: .semibold)).lineLimit(1)
            poolToggles("local")
          }
          Spacer(minLength: 0)
        }
        .padding(.vertical, Space.sm)
      } header: {
        Text("This Machine")
      }
    }
  }

  @ViewBuilder private func poolToggles(_ machine: String) -> some View {
    if let poolDisabled {
      HStack(spacing: Space.xxxl) {
        ForEach(["build", "device"], id: \.self) { role in
          let title = role == "build" ? "Builds enabled" : "Simulators enabled"
          HStack(spacing: Space.md) {
            Text(title).font(.stim(.callout)).foregroundStyle(Palette.secondary)
            Toggle(
              title,
              isOn: Binding(
                get: { !(poolDisabled[role] ?? []).contains(machine) },
                set: { setPool(role, machine, $0) })
            )
            .labelsHidden()
            .toggleStyle(.switch)
            .controlSize(.mini)
          }
          .disabled(refreshing)
        }
        Spacer(minLength: 0)
      }
    }
  }

  private func list(_ entries: [String]) -> some View {
    Form {
      localPool
      if failure != nil { Section { notices } }
      Section {
        ForEach(entries, id: \.self) { entry in
          let status = statuses?.first { $0.machine == entry }
          BuildMachineRow(
            entry: entry, status: status, checking: canAsk && (statuses == nil || (status == nil && refreshing)),
            failed: canAsk && failure != nil && status == nil,
            refreshing: canAsk && refreshing && status != nil && working != entry,
            capabilities: buildMachineCapabilities(entry, hosts: hosts), working: working == entry,
            progress: working == entry ? progress : nil,
            canAsk: canAsk, update: updates[entry], hosted: hosted(entry), ask: { ask(entry) },
            startUpdate: { update(entry) }, stopHosted: { stopHosted(entry, $0) },
            remove: { remove(entry) }, toggles: poolToggles(entry))
        }
      } header: {
        HStack {
          Text("Remote Machines")
          Spacer()
          Button("Add Remote Machine\u{2026}", action: add).buttonStyle(.stim(.primary)).disabled(addDisabled)
        }
      } footer: {
        if !canAsk {
          Text("Start a workspace with Stim to check these machines.").foregroundStyle(Palette.tertiary)
        }
      }
      Section {
        VStack(alignment: .leading, spacing: Space.xxs) {
          Toggle("Keep remote machines on this Mac's Stim version", isOn: $updatesAutomatically)
          Text("When this Mac's Stim changes, update stim-server on approved remote machines so builds can keep offloading.")
            .font(.stim(.footnote)).foregroundStyle(Palette.secondary)
        }
      }
      thisMac
    }
    .formStyle(.grouped)
    .scrollContentBackground(.hidden)
  }
}

private struct BuildMachineRow<Toggles: View>: View {
  var entry: String
  var status: BuildMachineStatus?
  var checking: Bool
  var failed: Bool
  var refreshing: Bool
  var capabilities: [String]
  var working: Bool
  var progress: String?
  var canAsk: Bool
  var update: MachineUpdatePhase?
  var hosted: [HostedOnMachine]
  var ask: () -> Void
  var startUpdate: () -> Void
  var stopHosted: ([HostedOnMachine]) -> Void
  var remove: () -> Void
  var toggles: Toggles

  var body: some View {
    HStack(alignment: .top, spacing: Space.lg) {
      Image(systemName: "desktopcomputer").font(.system(size: 18)).foregroundStyle(Palette.accent)
        .frame(width: 24).accessibilityHidden(true)
      VStack(alignment: .leading, spacing: Space.lg) {
        HStack(spacing: Space.sm) {
          Text(verbatim: entry).font(.stim(.body, weight: .semibold)).lineLimit(1)
          if let status {
            let listed = status.listStatus
            let updating = update.map { !$0.isDone } == true && needsStimUpdate(status)
            Pill(updating ? "Updating" : listed.title, tone: updating ? .warning : listed.tone, size: .small)
              .help(status.readiness.reasons ?? status.detail)
            if refreshing { ProgressView().controlSize(.mini).help("Checking again") }
          } else if checking {
            Pill("Checking\u{2026}", size: .small)
          } else if failed {
            Pill("Couldn\u{2019}t check", tone: .warning, size: .small)
          }
        }
        VStack(alignment: .leading, spacing: Space.md) {
          if let identity = status?.identityLine {
            Text(verbatim: identity).font(.stim(.footnote)).foregroundStyle(Palette.tertiary).lineLimit(1)
              .textSelection(.enabled)
          }
          if let status, !status.rowDetail.isEmpty {
            Text(verbatim: status.rowDetail).font(.stim(.footnote)).foregroundStyle(Palette.secondary)
              .fixedSize(horizontal: false, vertical: true)
          }
          if let resources = status?.capacity?.resources, !resources.isEmpty {
            RemoteResourceSummary(resources: resources)
          }
          HStack(spacing: Space.xs) {
            ForEach(capabilities, id: \.self) { name in
              Pill(tone: .neutral, size: .small, outlined: true) { Text(verbatim: name) }
            }
          }
        }
        let problems = status?.problemLines ?? []
        let needed = status.map(needsStimUpdate) ?? false
        if !problems.isEmpty || update != nil || needed {
          VStack(alignment: .leading, spacing: Space.sm) {
            ForEach(Array(problems.enumerated()), id: \.offset) { _, line in
              VStack(alignment: .leading, spacing: Space.xs) {
                Text(verbatim: line.reason).font(.stim(.footnote)).foregroundStyle(Palette.warning)
                  .textSelection(.enabled)
                switch line.fix {
                case .command(let command)?: CopyableCommand(command: command)
                case .advice(let advice)? where line.code != "stim-build" || update?.isDone ?? true:
                  Text(verbatim: advice).font(.stim(.footnote)).foregroundStyle(Palette.secondary)
                default: EmptyView()
                }
              }
            }
            MachineUpdateLine(phase: update, needed: needed, update: startUpdate)
            if case .waiting(_, let sessions)? = update, sessions > 0 {
              WaitingSessions(machine: entry, sessions: sessions, hosted: hosted, stop: stopHosted)
            }
          }
        }
        if let command = status?.approvalCommand, let status {
          VStack(alignment: .leading, spacing: Space.xs) {
            Text(verbatim: "\(status.approvalPrompt), or runs this there:")
              .font(.stim(.footnote)).foregroundStyle(Palette.secondary).fixedSize(horizontal: false, vertical: true)
            CopyableCommand(command: command)
            Text(verbatim: status.lapseLine()).font(.stim(.footnote)).foregroundStyle(Palette.secondary)
          }
        }
        toggles
      }
      Spacer(minLength: 0)
      if working {
        if let progress { Text(verbatim: progress).font(.stim(.footnote)).foregroundStyle(Palette.secondary) }
        ProgressView().controlSize(.small)
      }
      if let status, status.state.canAsk(requested: status.deviceId != nil) {
        Button(status.state == .notAsked ? "Ask" : "Ask Again", action: ask).disabled(working || !canAsk)
      }
      Button("Remove\u{2026}", action: remove)
        .buttonStyle(.stim(.secondary))
        .fixedSize()
        .disabled(working || (status?.state == .nodeChanged && !canAsk))
        .accessibilityLabel("Remove \(entry)")
    }
    .padding(.vertical, Space.sm)
  }
}

/// A remote Mac's CPU load, RAM and disk with the icons and spacing of the toolbar's resource summary.
private struct RemoteResourceSummary: View {
  var resources: [MachineResource]

  var body: some View {
    HStack(spacing: Space.md) {
      ForEach(
        Array(
          ResourceSummary.entries(
            cpu: resources.contains { $0.kind == .cpu }, memory: resources.contains { $0.kind == .memory },
            disk: resources.contains { $0.kind == .disk }
          ).enumerated()), id: \.offset
      ) { _, entry in
        switch entry {
        case .divider:
          Rectangle().fill(Palette.secondary.opacity(0.3)).frame(width: 1, height: 12)
        case .item(let kind):
          if let resource = resources.first(where: { $0.kind == kind }) {
            HStack(spacing: Space.sm) {
              Image(systemName: kind.icon).foregroundStyle(Palette.secondary)
              Text(resource.label).font(.stim(.caption)).foregroundStyle(Palette.secondary)
              Text(resource.value).font(.stim(.caption, mono: true)).fontWeight(.semibold)
                .foregroundStyle(Color(resource.tone))
            }
            .fixedSize()
          }
        }
      }
    }
  }
}

/// Removing a remote Mac: what changes on this Mac, and the optional cleanup to run on that Mac itself.
private struct RemoveMachineSheet: View {
  var entry: String
  var message: String
  var requests: [String]
  var cancel: () -> Void
  var remove: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: Space.lg) {
      Text("Stop using \(entry)?").font(.stim(.headline))
      Text(message).foregroundStyle(Palette.secondary).fixedSize(horizontal: false, vertical: true)
      VStack(alignment: .leading, spacing: Space.sm) {
        Text("Optional, on \(entry):").font(.stim(.footnote, weight: .semibold))
        if !requests.isEmpty {
          Text("Revoke this Mac's access").font(.stim(.footnote)).foregroundStyle(Palette.secondary)
          ForEach(requests, id: \.self) { CopyableCommand(command: "stim-server devices revoke \($0)") }
        }
        Text("Stop stim-server there if nothing else uses it").font(.stim(.footnote)).foregroundStyle(Palette.secondary)
        CopyableCommand(command: "stim-server service uninstall")
      }
      Text(
        "If ios.remote or android.remote names \(entry), simulators stop starting until you change it, for example with stim settings unset ios.remote."
      )
      .font(.stim(.footnote)).foregroundStyle(Palette.secondary).fixedSize(horizontal: false, vertical: true)
      HStack {
        Spacer()
        Button("Cancel", action: cancel).buttonStyle(.stim(.secondary)).keyboardShortcut(.cancelAction)
        Button("Remove", action: remove).buttonStyle(.stim(.destructive))
      }
    }
    .padding(Space.xxl)
    .frame(width: 460)
  }
}

private struct WaitingSessions: View {
  var machine: String
  var sessions: Int
  var hosted: [HostedOnMachine]
  var stop: ([HostedOnMachine]) -> Void
  @State private var confirming = false

  var body: some View {
    VStack(alignment: .leading, spacing: Space.sm) {
      if !hosted.isEmpty {
        Button("Stop and Update\u{2026}") { confirming = true }
          .buttonStyle(.stim(.secondary))
          .fixedSize()
          .help("Stops this Mac's hosted devices on \(machine) so its update can restart stim-server.")
      }
      let others = sessions - hosted.count
      if others > 0 {
        Text(
          verbatim:
            "\(others) hosted \(others == 1 ? "simulator belongs" : "simulators belong") to another Mac. Only someone on \(machine) can stop \(others == 1 ? "it" : "them")."
        )
        .font(.stim(.footnote)).foregroundStyle(Palette.secondary).fixedSize(horizontal: false, vertical: true)
      }
    }
    .confirmationDialog(
      "Stop \(hosted.count == 1 ? "this hosted device" : "these hosted devices") on \(machine)?", isPresented: $confirming
    ) {
      Button("Stop and Update", role: .destructive) { stop(hosted) }
    } message: {
      Text(
        verbatim: (hosted.map { "\($0.device) in \($0.workspace)" } + [
          "The app running there stops, even if someone else is using it. The update then continues."
        ]).joined(separator: "\n"))
    }
  }
}
