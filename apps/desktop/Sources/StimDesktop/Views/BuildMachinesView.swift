import StimKit
import StimStores
import SwiftUI

/// The "This machine uses" side of Settings > Connections: the `remote.machines` it builds on and runs devices on,
/// each with its state from `stim doctor`, and the machines it paired with to view or control their work, one row per
/// pinned server key. Adding a remote machine opens the wizard; pairing opens the pairing sheet. Stim Desktop changes
/// the setting with `stim settings` and asks for access with `stim doctor --fix`; approving happens on the other
/// machine.
struct BuildMachinesView: View {
  var model: BuildMachinesModel
  @ObservedObject var ledger: BuildLedgerModel
  @ObservedObject var store: StatusStore
  var workspace: String?
  var actions: ActionCenter?
  var servers: PairedServers = .shared

  @State private var removing: OutgoingConnection?
  @State private var opened: String?
  @State private var adding: AddMachineModel?
  @State private var pairing = false
  @AppStorage(AppPreferences.Key.updatesBuildMachines) private var updatesAutomatically = false

  private var checkout: String? {
    doctorCheckout(for: workspace, in: store.payload?.environments ?? [], project: store.project(ofPath:))?.path
  }

  private var connections: [OutgoingConnection] {
    Connections.outgoing(
      entries: model.entries ?? [], statuses: statuses, hosts: model.check(in: checkout)?.hosts, listing: model.listing,
      paired: servers.entries)
  }

  var body: some View {
    Group {
      if let opened, model.entries?.contains(opened) == true {
        detailPage(opened)
      } else {
        list
      }
    }
    .background(Palette.background)
    .onChange(of: model.entries) {
      if let opened, model.entries?.contains(opened) != true { self.opened = nil }
    }
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
    .task { await model.refreshTailnet() }
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
    .sheet(isPresented: $pairing) { PairMachineSheet(servers: servers) }
    .onQuitRequested {
      adding?.stop()
      adding = nil
      pairing = false
    }
    .sheet(item: $removing) { connection in
      RemoveMachineSheet(
        connection: connection, message: removalMessage(connection),
        cancel: { removing = nil },
        remove: {
          removing = nil
          if let pairing = connection.pairing { servers.forget(id: pairing.id) }
          if let entry = connection.entry { Task { await model.remove(entry, checkout: checkout) } }
        })
    }
  }

  private func detailPage(_ entry: String) -> some View {
    let status = statuses?.first { $0.machine == entry }
    let update = model.updates[entry]
    return MachineDetailPage(
      entry: entry, detail: model.detail(for: entry, checkout: checkout), status: status,
      capabilities: buildMachineCapabilities(entry, hosts: model.check(in: checkout)?.hosts),
      working: model.working == entry, progress: model.working == entry ? model.progress : nil, canAsk: checkout != nil,
      hosted: hostedDevices(on: entry, in: store.payload?.environments ?? []),
      builds: BuildLedger.items(on: entry, in: ledger.items), buildsNote: buildsNote(ledger), update: update,
      install: status.flatMap { model.install(for: $0) }, back: { opened = nil },
      ask: { Task { await model.ask(entry, checkout: checkout) } },
      startUpdate: { Task { await model.update(entry, checkout: checkout) } },
      stopHosted: { stopHosted(entry, $0) },
      remove: { removing = connections.first { $0.entry == entry } }, showsToggles: model.poolDisabled != nil,
      toggles: BuildMachinePoolToggles(
        machine: entry, poolDisabled: model.poolDisabled,
        hostsSimulators: !model.androidOnlyNames.contains(OffloadMachines.name(entry)), disabled: model.isBusy,
        setPool: { role, machine, enabled in Task { await model.setPool(role, machine: machine, enabled: enabled) } })
    )
    .task { await ledger.poll() }
    .task(id: DetailKey(entry: entry, checkout: checkout)) {
      while !Task.isCancelled {
        let loaded = await model.loadDetails(entry, checkout: checkout)
        try? await Task.sleep(for: .seconds(loaded ? 60 : 3))
      }
    }
  }

  private func buildsNote(_ ledger: BuildLedgerModel) -> String {
    if ledger.error != nil && ledger.items.isEmpty {
      return "Builds could not be read. If this stim is 1.26.0 or older, update it: the build history needs a newer stim."
    }
    return ledger.loaded ? "No recorded build ran on this machine yet." : "Loading\u{2026}"
  }

  private func stopHosted(_ entry: String, _ devices: [HostedOnMachine]) {
    var steps: [StimCommand] = []
    for device in devices where !steps.contains(device.stop) { steps.append(device.stop) }
    guard !steps.isEmpty else { return }
    actions?.run("Stop hosted devices on \(entry)", steps: steps, key: "stop-hosted:\(entry)", present: false)
  }

  private var list: some View {
    BuildMachinesContent(
      entries: model.entries, statuses: statuses, connections: connections, updates: model.updates,
      installs: Dictionary(
        (statuses ?? []).compactMap { status in model.install(for: status).map { (status.machine, $0) } },
        uniquingKeysWith: { first, _ in first }),
      working: model.working, progress: model.progress, refreshing: model.isBusy, failure: failure,
      tailscaleRunning: model.tailscaleRunning,
      settingsReadFailure: model.settingsReadFailure,
      retry: { Task { await model.load(checkout: checkout) } },
      canAsk: checkout != nil,
      addDisabled: model.working != nil,
      pairingBusy: servers.isPairing,
      updatesAutomatically: $updatesAutomatically,
      add: { adding = model.addMachine(checkout: checkout) },
      pair: { pairing = true },
      ask: { entry in Task { await model.ask(entry, checkout: checkout) } },
      update: { entry in Task { await model.update(entry, checkout: checkout) } },
      remove: { removing = $0 },
      reconnect: { servers.reconnect(id: $0) },
      move: { entry, offset in Task { await model.move(entry, by: offset) } },
      open: { opened = $0 },
      poolDisabled: model.poolDisabled,
      setPool: { role, machine, enabled in Task { await model.setPool(role, machine: machine, enabled: enabled) } },
      hostsSimulators: { !model.androidOnlyNames.contains(OffloadMachines.name($0)) },
      hosted: { hostedDevices(on: $0, in: store.payload?.environments ?? []) },
      stopHosted: { stopHosted($0, $1) },
      showsNotices: !servers.keepsPairings || servers.storeError != nil || servers.forgotten != nil,
      notices: PairingNotices(servers: servers)
    )
  }

  private func removalMessage(_ connection: OutgoingConnection) -> String {
    var parts: [String] = []
    if let entry = connection.entry {
      parts.append(
        statuses?.first(where: { $0.machine == entry })?.state == .keyChanged
          ? "Builds stop going to it, and this machine forgets the old key and asks again any listed machine that has not approved it."
          : "Removes it from remote.machines. Builds and hosted simulators stop going to it.")
    }
    if connection.pairing != nil {
      parts.append("Stim Desktop deletes this machine's key for it, so its workspaces stop showing here.")
    }
    return parts.joined(separator: " ")
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

private struct DetailKey: Hashable {
  var entry: String
  var checkout: String?
}

/// The Keychain notices of the pairings: a build that cannot keep them, a store error, and the revoke command of the
/// pairing just removed.
struct PairingNotices: View {
  var servers: PairedServers

  var body: some View {
    if !servers.keepsPairings {
      Banner(tone: .warning, icon: "exclamationmark.triangle.fill") {
        Text("Pairings are not kept in this build").font(.stim(.body, weight: .semibold))
        Text(
          "This copy of Stim Desktop is not signed with the entitlement the Keychain needs, so a pairing ends when it quits."
        )
        .foregroundStyle(Palette.secondary)
      }
    }
    if let error = servers.storeError {
      Text(error).foregroundStyle(Palette.error).textSelection(.enabled)
    }
    if let forgotten = servers.forgotten {
      Banner(tone: .info, icon: "key.slash", onDismiss: servers.dismissForgotten) {
        Text("Removed \(forgotten.name)").font(.stim(.body, weight: .semibold))
        Text(
          forgotten.revokes
            ? "\(forgotten.name.capitalizedFirst) still lists this machine. To revoke it there too, run this there."
            : "\(forgotten.name.capitalizedFirst) still lists this machine. Run this there to find it, then revoke it with stim pairings revoke and its id."
        )
        .foregroundStyle(Palette.secondary)
        CopyableCommand(command: forgotten.command, runsOn: forgotten.name)
      }
    }
  }
}

extension String {
  fileprivate var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() }
}

/// The "This machine uses" list for the state it is given: a progress view, or the machines with the Add menu.
struct BuildMachinesContent<Notices: View>: View {
  var entries: [String]?
  var statuses: [BuildMachineStatus]?
  var connections: [OutgoingConnection]
  var updates: [String: MachineUpdatePhase]
  var installs: [String: StimInstall] = [:]
  var working: String?
  var progress: String?
  var refreshing: Bool
  var failure: String?
  var tailscaleRunning: Bool?
  var settingsReadFailure: String? = nil
  var retry: () -> Void = {}
  var canAsk: Bool
  var addDisabled: Bool
  var pairingBusy = false
  @Binding var updatesAutomatically: Bool
  var add: () -> Void
  var pair: () -> Void = {}
  var ask: (String) -> Void
  var update: (String) -> Void
  var remove: (OutgoingConnection) -> Void
  var reconnect: (String) -> Void = { _ in }
  var move: (String, Int) -> Void = { _, _ in }
  var open: (String) -> Void = { _ in }
  var poolDisabled: [String: [String]]? = nil
  var setPool: (String, String, Bool) -> Void = { _, _, _ in }
  var hostsSimulators: (String) -> Bool = { _ in true }
  var hosted: (String) -> [HostedOnMachine] = { _ in [] }
  var stopHosted: (String, [HostedOnMachine]) -> Void = { _, _ in }
  var thisMachineName = Host.current().localizedName ?? "This machine"
  var showsNotices = false
  var notices: Notices

  var body: some View {
    if let entries {
      list(entries)
    } else if let settingsReadFailure {
      EmptyState(title: "Settings Unavailable", message: settingsReadFailure, actionTitle: "Try Again", action: retry)
    } else {
      ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
    }
  }

  @ViewBuilder private var failureNotice: some View {
    if let failure {
      Text(failure).foregroundStyle(Palette.error).textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  @ViewBuilder private var localPool: some View {
    if poolDisabled != nil {
      Section {
        HStack(alignment: .top, spacing: Space.lg) {
          Image(systemName: "laptopcomputer").iconFont(IconSize.large).foregroundStyle(Palette.accent)
            .frame(width: 24).accessibilityHidden(true)
          VStack(alignment: .leading, spacing: Space.lg) {
            Text(verbatim: thisMachineName).font(.stim(.body, weight: .semibold)).lineLimit(1)
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

  private func poolToggles(_ machine: String) -> some View {
    BuildMachinePoolToggles(
      machine: machine, poolDisabled: poolDisabled, hostsSimulators: hostsSimulators(machine), disabled: refreshing,
      setPool: setPool)
  }

  private var addMenu: some View {
    Menu("Add\u{2026}") {
      Button("Build or Run Simulators There\u{2026}", action: add).disabled(addDisabled)
      Button("View or Control Its Work\u{2026}", action: pair).disabled(pairingBusy)
    }
    .menuStyle(.button)
    .buttonStyle(.stim(.primary))
    .fixedSize()
    .accessibilityLabel("Add a machine this machine uses")
  }

  private func list(_ entries: [String]) -> some View {
    Form {
      if showsNotices { Section { notices } }
      localPool
      if failure != nil { Section { failureNotice } }
      Section {
        if connections.isEmpty {
          BuildMachinesEmptyState(
            add: add, compact: true, addDisabled: addDisabled, tailscaleOff: tailscaleRunning == false,
            checking: tailscaleRunning == nil)
        }
        ForEach(connections) { connection in
          if let entry = connection.entry, let position = entries.firstIndex(of: entry) {
            entryRow(entry, position: position, count: entries.count, connection: connection)
          } else {
            PairedConnectionRow(
              connection: connection, busy: pairingBusy, reconnect: { connection.pairing.map { reconnect($0.id) } },
              remove: { remove(connection) })
          }
        }
      } header: {
        HStack {
          Text("Machines this machine uses")
          Spacer()
          addMenu
        }
      } footer: {
        VStack(alignment: .leading, spacing: Space.xs) {
          if entries.count > 1 {
            Text(
              "Builds, simulators and macOS apps go to the first machine here that has room and a load under its own limit, and to the next only when it has none."
            )
            .foregroundStyle(Palette.secondary)
          }
          if !canAsk, !entries.isEmpty {
            Text("Start a workspace with Stim to check these machines.").foregroundStyle(Palette.tertiary)
          }
        }
      }
      if !entries.isEmpty {
        Section {
          VStack(alignment: .leading, spacing: Space.xxs) {
            Toggle("Keep remote machines on this machine's Stim version", isOn: $updatesAutomatically)
            Text(
              "When this machine's Stim changes, update stim-server on approved remote machines so builds can keep offloading."
            )
            .font(.stim(.footnote)).foregroundStyle(Palette.secondary)
          }
        }
      }
    }
    .formStyle(.grouped)
    .scrollContentBackground(.hidden)
  }

  private func entryRow(_ entry: String, position: Int, count: Int, connection: OutgoingConnection) -> some View {
    let status = statuses?.first { $0.machine == entry }
    return BuildMachineRow(
      entry: entry, position: position + 1, count: count, move: { move(entry, $0) }, status: status,
      checking: canAsk && (statuses == nil || (status == nil && refreshing)),
      failed: canAsk && failure != nil && status == nil,
      refreshing: canAsk && refreshing && status != nil && working != entry,
      access: connection.access, pairing: connection.pairing, working: working == entry,
      progress: working == entry ? progress : nil,
      canAsk: canAsk, update: updates[entry], install: installs[entry], hosted: hosted(entry), ask: { ask(entry) },
      startUpdate: { update(entry) }, stopHosted: { stopHosted(entry, $0) },
      open: { open(entry) }, reconnect: { connection.pairing.map { reconnect($0.id) } },
      remove: { remove(connection) }, toggles: poolToggles(entry))
  }
}

/// The access levels a connection holds, in one row of pills; Build and Run devices in the warning tone.
struct AccessPills: View {
  var access: [ConnectionAccess]

  var body: some View {
    HStack(spacing: Space.xs) {
      ForEach(access, id: \.self) { level in
        Pill(level.title, tone: level.tone, size: .small)
      }
    }
  }
}

/// A machine this machine paired with to view or control its work, and nothing else.
private struct PairedConnectionRow: View {
  var connection: OutgoingConnection
  var busy: Bool
  var reconnect: () -> Void
  var remove: () -> Void

  var body: some View {
    let status = connection.pairing?.status
    HStack(alignment: .top, spacing: Space.lg) {
      Image(systemName: connection.pairing?.pairing == nil ? "exclamationmark.triangle.fill" : "desktopcomputer")
        .iconFont(IconSize.large)
        .foregroundStyle(connection.pairing?.pairing == nil ? Palette.warning : Palette.accent)
        .frame(width: 24).accessibilityHidden(true)
      VStack(alignment: .leading, spacing: Space.xs) {
        HStack(spacing: Space.sm) {
          Text(verbatim: connection.name).font(.stim(.body, weight: .semibold)).lineLimit(1)
          if let status { Pill(status.title, tone: status.tone, size: .small) }
        }
        if let endpoint = connection.pairing?.pairing?.endpoint {
          Text(verbatim: endpoint.absoluteString)
            .font(.stim(.caption, mono: true)).foregroundStyle(Palette.tertiary).lineLimit(1).truncationMode(.middle)
            .textSelection(.enabled)
        }
        if let detail = status?.detail, !detail.isEmpty {
          Text(detail).font(.stim(.footnote)).foregroundStyle(Palette.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        if let command = status?.command { CopyableCommand(command: command, runsOn: connection.name) }
        AccessPills(access: connection.access)
      }
      Spacer(minLength: 0)
      if connection.pairing?.pairing != nil {
        Menu {
          Button("Reconnect", action: reconnect)
        } label: {
          Image(systemName: "ellipsis.circle")
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .accessibilityLabel("More actions for \(connection.name)")
      }
      Button("Remove\u{2026}", action: remove)
        .buttonStyle(.stim(.secondary))
        .fixedSize()
        .disabled(busy)
        .accessibilityLabel("Remove \(connection.name)")
    }
    .padding(.vertical, Space.sm)
  }
}

/// The Builds enabled and Simulators enabled switches of a machine in the pools `remote.buildPoolDisabled` and
/// `remote.devicePoolDisabled` describe; `machine` is `local` for this Mac.
struct BuildMachinePoolToggles: View {
  var machine: String
  var poolDisabled: [String: [String]]?
  var hostsSimulators: Bool
  var disabled: Bool
  var setPool: (String, String, Bool) -> Void

  var body: some View {
    if let poolDisabled {
      HStack(spacing: Space.xxxl) {
        ForEach(hostsSimulators ? ["build", "device"] : ["build"], id: \.self) { role in
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
          .disabled(disabled)
        }
        Spacer(minLength: 0)
      }
    }
  }
}

private struct BuildMachineRow<Toggles: View>: View {
  var entry: String
  var position: Int
  var count: Int
  var move: (Int) -> Void
  var status: BuildMachineStatus?
  var checking: Bool
  var failed: Bool
  var refreshing: Bool
  var access: [ConnectionAccess]
  var pairing: PairedServers.Entry?
  var working: Bool
  var progress: String?
  var canAsk: Bool
  var update: MachineUpdatePhase?
  var install: StimInstall?
  var hosted: [HostedOnMachine]
  var ask: () -> Void
  var startUpdate: () -> Void
  var stopHosted: ([HostedOnMachine]) -> Void
  var open: () -> Void
  var reconnect: () -> Void
  var remove: () -> Void
  var toggles: Toggles

  var body: some View {
    HStack(alignment: .top, spacing: Space.lg) {
      Image(systemName: "desktopcomputer").iconFont(IconSize.large).foregroundStyle(Palette.accent)
        .frame(width: 24).accessibilityHidden(true)
      VStack(alignment: .leading, spacing: Space.lg) {
        HStack(spacing: Space.sm) {
          if count > 1 {
            Pill("\(position)", tone: .neutral, size: .small)
              .help("Placement order: Stim tries the machine at 1 first and uses the next only when it has no room.")
              .accessibilityLabel("Priority \(position) of \(count)")
          }
          Text(verbatim: entry).font(.stim(.body, weight: .semibold)).lineLimit(1)
          if let status {
            let pill = status.pill(install: install, update: update)
            Pill(pill.title, tone: pill.tone, size: .small)
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
          if let status = pairing?.status, status.tone != .success {
            Text(verbatim: "Viewing: \(status.title)").font(.stim(.footnote)).foregroundStyle(Color(status.tone))
          }
          AccessPills(access: access)
        }
        if update != nil || install != nil {
          VStack(alignment: .leading, spacing: Space.sm) {
            MachineUpdateLine(machine: entry, phase: update, install: install, update: startUpdate)
            if case .waiting(_, let sessions)? = update, sessions > 0 {
              WaitingSessions(machine: entry, sessions: sessions, hosted: hosted, stop: stopHosted)
            }
          }
        }
        toggles
      }
      Spacer(minLength: 0)
      if working {
        if let progress { Text(verbatim: progress).font(.stim(.footnote)).foregroundStyle(Palette.secondary) }
        ProgressView().controlSize(.small)
      }
      if let status, status.state.canAsk(requested: status.requestedAt != nil) {
        Button(status.state == .notAsked ? "Ask" : "Ask Again", action: ask).disabled(working || !canAsk)
      }
      if count > 1 {
        VStack(spacing: 0) {
          Button {
            move(-1)
          } label: {
            Image(systemName: "chevron.up")
          }
          .disabled(working || position == 1)
          .accessibilityLabel("Move \(entry) up")
          .help("Try \(entry) earlier")
          Button {
            move(1)
          } label: {
            Image(systemName: "chevron.down")
          }
          .disabled(working || position == count)
          .accessibilityLabel("Move \(entry) down")
          .help("Try \(entry) later")
        }
        .buttonStyle(.borderless)
      }
      Button("Details", action: open)
        .buttonStyle(.stim(.secondary))
        .fixedSize()
        .accessibilityLabel("Details of \(entry)")
      Button("Remove\u{2026}", action: remove)
        .buttonStyle(.stim(.secondary))
        .fixedSize()
        .disabled(working || (status?.state == .keyChanged && !canAsk))
        .accessibilityLabel("Remove \(entry)")
    }
    .padding(.vertical, Space.sm)
    .contextMenu {
      if let status, status.state.canAsk(requested: status.requestedAt != nil) {
        Button(status.state == .notAsked ? "Ask" : "Ask Again", systemImage: "paperplane", action: ask)
          .disabled(working || !canAsk)
      }
      Button("Details", systemImage: "info.circle", action: open)
      if pairing?.pairing != nil { Button("Reconnect", systemImage: "arrow.clockwise", action: reconnect) }
      if count > 1 {
        Divider()
        Button("Move Up", systemImage: "chevron.up") { move(-1) }.disabled(working || position == 1)
        Button("Move Down", systemImage: "chevron.down") { move(1) }.disabled(working || position == count)
      }
      Divider()
      Button("Remove\u{2026}", systemImage: "trash", role: .destructive, action: remove)
        .disabled(working || (status?.state == .keyChanged && !canAsk))
    }
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

/// Removing a machine this machine uses: what changes here, and the revoke commands to run on that machine, since
/// removing it here never revokes this machine there.
private struct RemoveMachineSheet: View {
  var connection: OutgoingConnection
  var message: String
  var cancel: () -> Void
  var remove: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: Space.lg) {
      Text("Remove \(connection.name) from this machine?").font(.stim(.headline))
      Text(message).foregroundStyle(Palette.secondary).fixedSize(horizontal: false, vertical: true)
      VStack(alignment: .leading, spacing: Space.sm) {
        if !connection.revokeCommands.isEmpty {
          Text("To revoke it on \(connection.name) too, run there:").font(.stim(.footnote, weight: .semibold))
          ForEach(connection.revokeCommands, id: \.self) { CopyableCommand(command: $0, runsOn: connection.name) }
        }
        if connection.entry != nil {
          Text("To stop stim-server there if nothing else uses it:").font(.stim(.footnote)).foregroundStyle(Palette.secondary)
          CopyableCommand(command: "stim service uninstall", runsOn: connection.name)
        }
      }
      if let entry = connection.entry {
        Text(
          "If ios.remote or android.remote names \(entry), simulators stop starting until you change it, for example with stim settings unset ios.remote."
        )
        .font(.stim(.footnote)).foregroundStyle(Palette.secondary).fixedSize(horizontal: false, vertical: true)
      }
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

struct WaitingSessions: View {
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
          .help("Stops this machine's hosted devices on \(machine) so its update can restart stim-server.")
      }
      let others = sessions - hosted.count
      if others > 0 {
        Text(
          verbatim:
            "\(others) hosted \(others == 1 ? "simulator belongs" : "simulators belong") to another machine. Only someone on \(machine) can stop \(others == 1 ? "it" : "them")."
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
