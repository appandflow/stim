import AppKit
import StimKit
import SwiftUI

struct PhonesView: View {
  @ObservedObject var server: ServerController
  var settings: MachineSettingsStore
  let stimHome: String
  @AppStorage(AppPreferences.Key.servesPhones) private var servesPhones = false
  @ObservedObject private var flags = FeatureFlagStore.shared
  @AppStorage(AppPreferences.Key.stimServerExecutable) private var executable = ""
  @State private var pairing = false
  @State private var pairingModel: PairPhoneModel?
  @State private var revoking: PairedDevice?

  var body: some View {
    Form {
      if flags.phoneApp {
        if let problem {
          Section { problemRow(problem) }
        }
        phones
      } else {
        if !serverErrors.isEmpty {
          Section { ForEach(serverErrors, id: \.self) { Text(abbreviatingHome($0)).foregroundStyle(Palette.error) } }
        }
        if case .running(let health, _) = server.state, !health.tailscale.isRunning {
          TailscaleSetup(tailscale: health.tailscale, port: server.port, canRestart: server.canRestart) {
            server.restart()
          }
        }
        if case .running(let health, _) = server.state, let route = health.route, let dnsName = health.tailscale.dnsName {
          RouteSection(server: server, route: route, dnsName: dnsName)
        }
      }
      Section("Server") {
        Toggle(PhoneApp.serverPage(phoneApp: flags.phoneApp).serveToggleTitle, isOn: $servesPhones)
          .onChange(of: servesPhones) { _, on in on ? server.start() : server.stop() }
        serverState
        HStack {
          TextField("stim-server executable", text: $executable, prompt: Text("stim-server on the login shell's PATH"))
          Button("Choose\u{2026}", action: chooseExecutable).buttonStyle(.stim())
        }
        .help("Overrides PATH the next time the server starts.")
      }
      RecordingSection(settings: settings)
    }
    .formStyle(.grouped)
    .scrollContentBackground(.hidden)
    .background(Palette.background)
    .task {
      while !Task.isCancelled {
        server.refresh()
        try? await Task.sleep(for: .seconds(5))
      }
    }
    .sheet(isPresented: $pairing, onDismiss: server.reloadDevices) {
      if let pairingModel { PairPhoneSheet(model: pairingModel) }
    }
    .onQuitRequested { pairing = false }
    .onReceive(OpenRequests.shared.$pairsPhone) { pairs in
      guard pairs else { return }
      OpenRequests.shared.pairsPhone = false
      guard flags.phoneApp else { return }
      pair()
    }
    .confirmationDialog(
      revoking.map { "Revoke \($0.name)?" } ?? "",
      isPresented: .init(get: { revoking != nil }, set: { if !$0 { revoking = nil } }),
      presenting: revoking
    ) { device in
      Button("Revoke", role: .destructive) { server.revoke(device) }
    } message: { _ in
      Text("The phone disconnects and must pair again to reconnect.")
    }
  }

  @ViewBuilder private var phones: some View {
    let errors = serverErrors
    if server.phones.isEmpty {
      Section {
        ForEach(errors, id: \.self) { Text(abbreviatingHome($0)).foregroundStyle(Palette.error) }
        VStack(spacing: Space.lg) {
          ZStack {
            BrandHalo(size: 130)
            BrandBadge(systemImage: "iphone", size: 64)
          }
          .accessibilityHidden(true)
          Text("No paired phones").font(.stim(.headline))
          Text("See this Mac's workspaces, devices and logs on your phone.")
            .foregroundStyle(Palette.secondary)
            .multilineTextAlignment(.center)
          Button("Pair a Phone\u{2026}", action: pair).buttonStyle(.stim(.primary, .regular))
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, Space.xl)
      }
    } else {
      Section {
        ForEach(errors, id: \.self) { Text(abbreviatingHome($0)).foregroundStyle(Palette.error) }
        ForEach(server.phones) { device in
          PhoneRow(
            device: device, changing: server.pendingGrants[device.id] != nil,
            allowControl: { server.grant(device, control: $0) }, revoke: { revoking = device })
        }
      } header: {
        HStack {
          Text("Paired phones")
          Spacer()
          Button("Pair a Phone\u{2026}", action: pair).buttonStyle(.stim(.primary))
        }
      }
    }
  }

  private var serverErrors: [String] { [server.devicesError, server.changeError].compactMap { $0 } }

  private func pair(fixing: Bool) {
    pairingModel = PairPhoneModel(stimHome: stimHome, fixing: fixing)
    pairing = true
  }

  private func pair() { pair(fixing: false) }

  private enum Problem {
    case servingOff, tailscaleOff, funneled, noRoute

    var text: String {
      switch self {
      case .servingOff: return "Serving is off, so paired phones can't connect."
      case .tailscaleOff: return "Tailscale is off on this Mac, so phones can't connect."
      case .funneled: return "Tailscale Funnel makes the Stim server public, so phones are refused."
      case .noRoute: return "Phones can't reach this Mac yet: its private tailnet route is not set up."
      }
    }
  }

  private var problem: Problem? {
    guard servesPhones else { return server.phones.isEmpty ? nil : .servingOff }
    guard case .running(let health, _) = server.state else { return nil }
    if !health.tailscale.isRunning { return .tailscaleOff }
    switch health.route?.state {
    case "funneled": return .funneled
    case "missing", "unknown": return .noRoute
    default: return nil
    }
  }

  private func problemRow(_ problem: Problem) -> some View {
    HStack(spacing: Space.md) {
      Label(problem.text, systemImage: "exclamationmark.triangle.fill").foregroundStyle(Palette.warning)
      Spacer()
      if problem == .servingOff {
        Button("Turn On") { servesPhones = true }.buttonStyle(.stim())
      } else {
        Button("Fix\u{2026}") { pair(fixing: true) }.buttonStyle(.stim())
      }
    }
  }

  @ViewBuilder private var serverState: some View {
    switch server.state {
    case .off:
      EmptyView()
    case .starting, .notReady(.pending, _):
      HStack(spacing: Space.md) {
        ProgressView().controlSize(.small)
        Text("Starting").foregroundStyle(Palette.secondary)
      }
    case .notReady(.degraded(let reason), _):
      Text("Degraded: \(abbreviatingHome(reason)). It retries every 30 seconds.")
        .foregroundStyle(Palette.warning).textSelection(.enabled)
    case .running(let health, let owned):
      Text("stim-server \(health.version) on port \(String(server.port))\(owned ? "" : ", started outside Stim Desktop")")
        .font(.stim(.footnote)).foregroundStyle(Palette.secondary)
      if StimHome.isDefault(stimHome), !health.servesDefaultHome() {
        Text(
          "This server keeps pairings in \(abbreviatingHome(health.stimHome)), not ~/.stim. Phones paired now stop working when Stim Desktop serves ~/.stim again."
        )
        .foregroundStyle(Palette.warning)
        .textSelection(.enabled)
      }
    case .failed(let message):
      HStack {
        Text(abbreviatingHome(message)).foregroundStyle(Palette.error).textSelection(.enabled)
        Spacer()
        Button("Try Again") { server.start() }.buttonStyle(.stim())
      }
    }
  }

  private func chooseExecutable() {
    let panel = NSOpenPanel()
    panel.canChooseFiles = true
    panel.canChooseDirectories = false
    panel.prompt = "Choose"
    if panel.runModal() == .OK, let url = panel.url { executable = url.path }
  }
}

private struct TailscaleSetup: View {
  var tailscale: TailscaleState
  var port: Int
  var canRestart: Bool
  var restart: () -> Void

  var body: some View {
    Section {
      VStack(alignment: .leading, spacing: Space.md) {
        Label(tailscale.summary, systemImage: "exclamationmark.triangle.fill")
          .foregroundStyle(Palette.warning)
        Text(PhoneApp.Copy.tailscaleDown(phoneApp: FeatureFlags.isEnabled(.phoneApp)))
          .foregroundStyle(Palette.secondary)
        step("1. Start Tailscale.", command: "tailscale up")
        Text(
          canRestart
            ? "2. Restart the server so it listens on the Tailscale address."
            : "2. Restart stim-server so it listens on the Tailscale address."
        )
        if canRestart {
          Button("Restart Server", action: restart)
        }
        Text("3. Choose Set up connection in this tab.")
      }
      .padding(.vertical, Space.xs)
    }
  }

  private func step(_ title: String, command: String) -> some View {
    VStack(alignment: .leading, spacing: Space.sm) {
      Text(title)
      HStack {
        CommandText(command: command)
        CopyButton(command)
      }
    }
  }
}

struct RouteSection: View {
  @ObservedObject var server: ServerController
  var route: ServeRoute
  var dnsName: String
  private var port: Int { server.port }

  var body: some View {
    Section("Tailscale route") {
      VStack(alignment: .leading, spacing: Space.md) {
        switch route.state {
        case "routed":
          Label(
            "\(PhoneApp.Copy.clients(phoneApp: FeatureFlags.isEnabled(.phoneApp))) connect to \(route.endpoint(dnsName: dnsName)), tailnet only.",
            systemImage: "checkmark.circle.fill"
          )
          .foregroundStyle(Palette.success)
          Text("tailscale serve forwards HTTPS port \(String(route.port)) to 127.0.0.1:\(String(port)).")
            .foregroundStyle(Palette.secondary)
        case "funneled":
          Label(
            "Tailscale Funnel is on for port \((route.ports ?? []).map(String.init).joined(separator: ", ")), which forwards to stim-server, so the server is reachable from the public internet. Pairing is refused.",
            systemImage: "exclamationmark.octagon.fill"
          )
          .foregroundStyle(Palette.error)
          .fixedSize(horizontal: false, vertical: true)
          Text("Remove that handler (see tailscale serve status), then serve stim-server on a tailnet-only port:")
            .foregroundStyle(Palette.secondary)
          command
        case "missing":
          Label(
            "No tailscale serve route reaches port \(String(port)), so \(PhoneApp.Copy.clients(phoneApp: FeatureFlags.isEnabled(.phoneApp)).lowercased()) cannot connect yet.",
            systemImage: "exclamationmark.triangle.fill"
          )
          .foregroundStyle(Palette.warning)
          Text("Set up a dedicated tailnet-only connection. Tailscale may ask you to enable HTTPS in your browser.")
            .foregroundStyle(Palette.secondary)
          setup
        default:
          Label(
            "Could not read tailscale serve status: \(route.reason ?? "unknown reason"). Pairing waits until the connection is verified.",
            systemImage: "exclamationmark.triangle.fill"
          )
          .foregroundStyle(Palette.warning)
          .fixedSize(horizontal: false, vertical: true)
          setup
        }
        if let error = server.connectionError {
          Text(abbreviatingHome(error)).foregroundStyle(Palette.error).textSelection(.enabled)
          if let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue),
            let url = detector.matches(in: error, range: NSRange(error.startIndex..., in: error))
              .compactMap(\.url).first(where: { $0.scheme == "https" && $0.host == "login.tailscale.com" })
          {
            Link("Open Tailscale setup", destination: url)
          }
        }
      }
      .padding(.vertical, Space.xs)
    }
  }

  private var setup: some View {
    HStack {
      Button(server.connectionError == nil ? "Set up connection" : "Try Again") { server.setupConnection() }
        .disabled(server.settingUpConnection)
      if server.settingUpConnection { ProgressView().controlSize(.small) }
    }
  }

  private var command: some View {
    let command = route.setupCommand(serverPort: port)
    return HStack {
      CommandText(command: command)
      CopyButton(command)
    }
  }
}

private struct PhoneRow: View {
  var device: PairedDevice
  var changing: Bool
  var allowControl: (Bool) -> Void
  var revoke: () -> Void

  var body: some View {
    HStack(spacing: Space.lg) {
      Image(systemName: "iphone").iconFont(IconSize.large).foregroundStyle(Palette.accent)
      VStack(alignment: .leading, spacing: Space.xxs) {
        Text(verbatim: device.name).font(.stim(.body, weight: .semibold)).lineLimit(1)
        Text(lastSeen).font(.stim(.footnote)).foregroundStyle(Palette.secondary)
      }
      Spacer()
      Pill(device.canControl ? "Can control" : "View only", tone: device.canControl ? .success : .neutral, size: .small)
      Menu {
        Button(device.canControl ? "View Only" : "Allow Control") { allowControl(!device.canControl) }
          .disabled(changing)
        Divider()
        Button("Revoke\u{2026}", role: .destructive, action: revoke)
      } label: {
        Image(systemName: "ellipsis.circle")
      }
      .menuStyle(.borderlessButton)
      .menuIndicator(.hidden)
      .fixedSize()
      .accessibilityLabel("More actions for \(device.name)")
    }
    .padding(.vertical, Space.xxs)
  }

  private var lastSeen: String {
    guard let at = device.lastSeenAt else { return "Never seen" }
    return "Seen \(at.formatted(.relative(presentation: .named)))"
  }
}

/// `recording.enabled` in the machine layer: whether stim-server records device screens on this Mac for replay.
private struct RecordingSection: View {
  var settings: MachineSettingsStore
  @State private var writing = false
  @State private var writeFailure: String?
  @State private var confirmingOff = false

  private var entry: SettingEntry? { settings.entry("recording.enabled") }

  private var failure: String? {
    writeFailure ?? settings.error
      ?? (settings.payload != nil && entry == nil
        ? "This stim has no recording.enabled setting; update it to replay devices." : nil)
  }

  private var enabled: Bool { entry?.layer(.machine)?.bool ?? true }

  var body: some View {
    Section {
      Toggle(
        "Record device screens for replay",
        isOn: Binding(
          get: { enabled },
          set: { on in
            if on {
              write(true)
            } else {
              confirmingOff = true
            }
          })
      )
      .disabled(entry == nil || writing || entry?.env != nil)
      if let override = entry?.env {
        Text("\(override.name)=\(override.value) overrides this setting.").foregroundStyle(Palette.warning)
      }
      if let failure {
        Text(failure).foregroundStyle(Palette.error)
      }
    } footer: {
      Text(PhoneApp.Copy.recordingFooter(phoneApp: FeatureFlags.isEnabled(.phoneApp)))
        .foregroundStyle(Palette.tertiary)
        .multilineTextAlignment(.leading)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .task { await settings.refresh() }
    .confirmationDialog("Stop recording device screens?", isPresented: $confirmingOff, titleVisibility: .visible) {
      Button("Turn off and delete recordings", role: .destructive) { write(false) }
    } message: {
      Text("stim settings set recording.enabled false --scope machine deletes the recordings of every workspace it turns off.")
    }
  }

  private func write(_ on: Bool) {
    writing = true
    Task {
      let result = await settings.write(
        "recording.enabled", value: on ? "true" : "false", scope: .machine, cwd: NSHomeDirectory())
      switch result {
      case .success(.written): writeFailure = nil
      case .success(.refused(let refusal)):
        writeFailure = [refusal.message, refusal.remedy].compactMap { $0 }.joined(separator: " ")
      case .failure(let error): writeFailure = error.localizedDescription
      }
      writing = false
    }
  }
}
