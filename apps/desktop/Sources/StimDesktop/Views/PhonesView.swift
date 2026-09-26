import AppKit
import CoreImage
import CoreImage.CIFilterBuiltins
import StimKit
import SwiftUI

struct PhonesView: View {
  @ObservedObject var server: ServerController
  @AppStorage(AppPreferences.Key.servesPhones) private var servesPhones = false
  @AppStorage(AppPreferences.Key.stimServerExecutable) private var executable = ""
  @State private var pairing = false
  @State private var revoking: PairedDevice?

  var body: some View {
    Form {
      Section {
        Toggle("Serve to phones", isOn: $servesPhones)
          .onChange(of: servesPhones) { _, on in on ? server.start() : server.stop() }
        serverState
      } footer: {
        Text(
          "Runs stim-server on port \(String(server.port)) while Stim Desktop is open, or uses one that is already running. Phones connect through Tailscale. A read-only phone sees workspaces, devices and logs; a phone allowed to control can also drive simulators and emulators and run reload and stop."
        )
        .foregroundStyle(Palette.tertiary)
        .multilineTextAlignment(.leading)
        .frame(maxWidth: .infinity, alignment: .leading)
      }

      if case .running(let health, _) = server.state, !health.tailscale.isRunning {
        TailscaleSetup(tailscale: health.tailscale, port: server.port, canRestart: server.canRestart) {
          server.restart()
        }
      }

      if case .running(let health, _) = server.state, let route = health.route, let dnsName = health.tailscale.dnsName {
        RouteSection(route: route, dnsName: dnsName, port: server.port)
      }

      Section {
        ForEach([server.devicesError, server.changeError].compactMap { $0 }, id: \.self) { error in
          Text(abbreviatingHome(error)).foregroundStyle(Palette.error)
        }
        if server.devices.isEmpty {
          Text("No paired phones.").foregroundStyle(Palette.secondary)
        }
        ForEach(server.devices) { device in
          DeviceRow(
            device: device, changing: server.pendingGrants[device.id] != nil,
            allowControl: { server.grant(device, control: $0) }
          ) { revoking = device }
        }
      } header: {
        HStack {
          Text("Paired phones")
          Spacer()
          Button("Pair a Phone\u{2026}") { pairing = true }
            .disabled(!server.isRunning)
        }
      }

      Section("stim-server executable") {
        HStack {
          TextField("stim-server on the login shell's PATH", text: $executable)
          Button("Choose\u{2026}", action: chooseExecutable)
        }
        Text("Overrides PATH the next time the server starts.")
          .foregroundStyle(Palette.tertiary)
      }
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
      PairSheet(server: server)
    }
    .onReceive(OpenRequests.shared.$pairsPhone) { pairs in
      guard pairs else { return }
      OpenRequests.shared.pairsPhone = false
      pairing = server.isRunning
    }
    .confirmationDialog(
      "Revoke \(revoking?.name ?? "")?", isPresented: .init(get: { revoking != nil }, set: { if !$0 { revoking = nil } }),
      presenting: revoking
    ) { device in
      Button("Revoke", role: .destructive) { server.revoke(device) }
    } message: { _ in
      Text("The phone disconnects and must pair again to reconnect.")
    }
  }

  @ViewBuilder private var serverState: some View {
    switch server.state {
    case .off:
      Label("Not serving", systemImage: "circle").foregroundStyle(Palette.secondary)
    case .starting:
      HStack(spacing: Space.md) {
        ProgressView().controlSize(.small)
        Text("Starting stim-server\u{2026}").foregroundStyle(Palette.secondary)
      }
    case .running(let health, let owned):
      VStack(alignment: .leading, spacing: Space.md) {
        HStack(spacing: Space.md) {
          StatusDot(color: health.tailscale.isRunning ? Palette.success : Palette.warning)
          Text(
            "stim-server \(health.version) on port \(String(server.port))\(owned ? "" : ", started outside Stim Desktop")"
          )
          Spacer()
          Text(health.tailscale.isRunning ? "Tailscale" : "This Mac only")
            .font(.stim(.caption, mono: true))
            .foregroundStyle(Palette.tertiary)
        }
        if !health.servesDefaultHome() {
          Text(
            "This server keeps pairings in \(abbreviatingHome(health.stimHome)), not ~/.stim. Phones paired now stop working when Stim Desktop serves ~/.stim again."
          )
          .foregroundStyle(Palette.warning)
          .textSelection(.enabled)
        }
      }
    case .failed(let message):
      VStack(alignment: .leading, spacing: Space.md) {
        Text(abbreviatingHome(message)).foregroundStyle(Palette.error).textSelection(.enabled)
        Button("Try Again") { server.start() }
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
        Text("Phones cannot connect until Tailscale runs. Only a client on this Mac, such as an iOS Simulator, can pair now.")
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
        Text("3. Run the tailscale serve command this tab then shows, once.")
      }
      .padding(.vertical, Space.xs)
    }
  }

  private func step(_ title: String, command: String) -> some View {
    VStack(alignment: .leading, spacing: Space.sm) {
      Text(title)
      HStack {
        CommandText(command: command)
        Button("Copy") { copy(command) }
      }
    }
  }
}

private struct RouteSection: View {
  var route: ServeRoute
  var dnsName: String
  var port: Int

  var body: some View {
    Section("Tailscale route") {
      VStack(alignment: .leading, spacing: Space.md) {
        switch route.state {
        case "routed":
          Label("Phones connect to \(route.endpoint(dnsName: dnsName)), tailnet only.", systemImage: "checkmark.circle.fill")
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
          Label("No tailscale serve route reaches port \(String(port)), so phones cannot connect yet.", systemImage: "exclamationmark.triangle.fill")
            .foregroundStyle(Palette.warning)
          Text("Once, serve it on a dedicated tailnet-only port. Phones then connect to \(route.endpoint(dnsName: dnsName)).")
            .foregroundStyle(Palette.secondary)
          command
        default:
          Label(
            "Could not read tailscale serve status: \(route.reason ?? "unknown reason"). Pairing assumes \(route.endpoint(dnsName: dnsName)).",
            systemImage: "exclamationmark.triangle.fill"
          )
          .foregroundStyle(Palette.warning)
          .fixedSize(horizontal: false, vertical: true)
        }
      }
      .padding(.vertical, Space.xs)
    }
  }

  private var command: some View {
    let command = route.setupCommand(serverPort: port)
    return HStack {
      CommandText(command: command)
      Button("Copy") { copy(command) }
    }
  }
}

private struct DeviceRow: View {
  var device: PairedDevice
  var changing: Bool
  var allowControl: (Bool) -> Void
  var revoke: () -> Void

  var body: some View {
    HStack(spacing: Space.lg) {
      Image(systemName: "iphone").font(.system(size: 18)).foregroundStyle(Palette.accent)
      VStack(alignment: .leading, spacing: Space.xxs) {
        HStack(spacing: Space.sm) {
          Text(device.name).font(.stim(.body, weight: .semibold))
          ScopeBadge(canControl: device.canControl)
        }
        Text("\(device.id) \u{00B7} \(device.node)").font(.stim(.caption, mono: true)).foregroundStyle(Palette.secondary)
      }
      Spacer()
      VStack(alignment: .trailing, spacing: Space.xxs) {
        Text(lastSeen).foregroundStyle(Palette.secondary)
        Text("Paired \(device.pairedAt.formatted(date: .abbreviated, time: .shortened))")
          .foregroundStyle(Palette.tertiary)
      }
      .font(.stim(.footnote))
      Toggle("Allow control", isOn: .init(get: { device.canControl }, set: allowControl))
        .toggleStyle(.checkbox)
        .disabled(changing)
        .help("Let this phone drive simulators and emulators and run reload and stop.")
      Button("Revoke", role: .destructive, action: revoke)
    }
    .padding(.vertical, Space.xxs)
  }

  private var lastSeen: String {
    guard let at = device.lastSeenAt else { return "Never seen" }
    return "Seen \(at.formatted(.relative(presentation: .named)))"
  }
}

private struct ScopeBadge: View {
  var canControl: Bool

  var body: some View {
    Pill(canControl ? "Can control" : "Read-only", tone: canControl ? .success : .neutral, size: .small)
  }
}

struct PairSheet: View {
  @ObservedObject var server: ServerController
  @Environment(\.dismiss) private var dismiss
  @State private var code: PairingCode?
  @State private var error: String?
  @State private var paired: PairedDevice?
  @State private var openedAt = Date()
  @State private var showsToken = false
  @State private var allowsControl = true

  var body: some View {
    VStack(spacing: Space.xl) {
      Text("Pair a Phone").font(.stim(.title))
      if let paired {
        Image(systemName: "checkmark.circle.fill").font(.system(size: 56)).foregroundStyle(Palette.success)
        HStack(spacing: Space.sm) {
          Text("Paired \(paired.name)").font(.stim(.headline))
          ScopeBadge(canControl: paired.canControl)
        }
        Text("\(paired.id) \u{00B7} \(paired.node)").font(.stim(.caption, mono: true)).foregroundStyle(Palette.secondary)
      } else {
        VStack(alignment: .leading, spacing: Space.xs) {
          Toggle("Allow this phone to control devices", isOn: $allowsControl)
            .toggleStyle(.checkbox)
            .onChange(of: allowsControl) { load() }
          Text(
            allowsControl
              ? "It can drive simulators and emulators and run reload and stop."
              : "It can only see workspaces, devices and logs. You can allow control later in the Phones tab."
          )
          .font(.stim(.footnote))
          .foregroundStyle(Palette.tertiary)
          .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        if let error {
          Text(abbreviatingHome(error)).foregroundStyle(Palette.error).textSelection(.enabled)
          Button("Try Again", action: load)
        } else if let code {
          codeView(code)
        } else {
          ProgressView().frame(width: 260, height: 260)
        }
      }
      HStack {
        Spacer()
        Button(paired == nil ? "Cancel" : "Done") { dismiss() }.keyboardShortcut(paired == nil ? .cancelAction : .defaultAction)
      }
    }
    .padding(Space.xxxl)
    .frame(width: 420)
    .background(Palette.background)
    .font(.stim(.body))
    .foregroundStyle(Palette.text)
    .onAppear(perform: load)
    .task {
      while !Task.isCancelled, paired == nil {
        try? await Task.sleep(for: .seconds(2))
        server.reloadDevices()
        paired = server.devices.first { $0.pairedAt >= openedAt }
      }
    }
  }

  private func codeView(_ code: PairingCode) -> some View {
    TimelineView(.periodic(from: .now, by: 1)) { context in
      let remaining = Int(code.expiresAt.timeIntervalSince(context.date).rounded(.up))
      VStack(spacing: Space.lg) {
        Text("Scan this code with the Stim app on your phone. It pairs one phone.")
          .foregroundStyle(Palette.secondary)
          .multilineTextAlignment(.center)
          .fixedSize(horizontal: false, vertical: true)
        ZStack {
          QRCodeImage(text: code.qrText)
            .frame(width: 260, height: 260)
            .blur(radius: remaining > 0 ? 0 : 8)
          if remaining <= 0 {
            Button("New Code", action: load).controlSize(.large)
          }
        }
        Text(remaining > 0 ? "Expires in \(remaining / 60):\(String(format: "%02d", remaining % 60))" : "This code expired.")
          .font(.stim(.callout, mono: true))
          .foregroundStyle(remaining > 30 ? Palette.secondary : Palette.warning)
        VStack(alignment: .leading, spacing: Space.sm) {
          detail("Endpoint", code.qr.endpoint)
          detail("Token", code.qr.pairingToken, secret: true)
        }
        if case .running(let health, _) = server.state, let route = health.route, route.state != "routed" {
          Label(
            route.state == "missing"
              ? "No tailscale serve route to stim-server was found, so a phone cannot reach this endpoint yet. See the Phones tab."
              : route.state == "funneled"
                ? "Tailscale Funnel now exposes stim-server publicly. Do not use this code; see the Phones tab."
                : "Could not read tailscale serve status, so this endpoint is assumed. See the Phones tab.",
            systemImage: "exclamationmark.triangle.fill"
          )
          .foregroundStyle(Palette.warning)
          .font(.stim(.callout))
          .fixedSize(horizontal: false, vertical: true)
        }
        if code.isLocalOnly {
          Label(
            "Tailscale is not running, so this endpoint works only on this Mac, for example in an iOS Simulator.",
            systemImage: "exclamationmark.triangle.fill"
          )
          .foregroundStyle(Palette.warning)
          .font(.stim(.callout))
          .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
  }

  private func detail(_ title: String, _ value: String, secret: Bool = false) -> some View {
    HStack {
      Text(title).foregroundStyle(Palette.tertiary).frame(width: 64, alignment: .leading)
      if secret && !showsToken {
        Text(String(repeating: "\u{2022}", count: 16)).font(.stim(.caption, mono: true)).lineLimit(1)
      } else {
        Text(value).font(.stim(.caption, mono: true)).lineLimit(1).truncationMode(.middle).textSelection(.enabled)
      }
      Spacer()
      if secret {
        Button { showsToken.toggle() } label: { Image(systemName: showsToken ? "eye.slash" : "eye") }
          .buttonStyle(.borderless)
          .accessibilityLabel(showsToken ? "Hide token" : "Show token")
          .help(showsToken ? "Hide token" : "Show token")
      }
      Button("Copy") { copy(value) }.controlSize(.small)
    }
    .font(.stim(.callout))
  }

  private func load() {
    error = nil
    code = nil
    showsToken = false
    let port = server.port
    let control = allowsControl
    Task {
      let cli = await server.cli()
      let result = await Task.detached(operation: { Result { try cli.pair(port: port, control: control) } }).value
      guard control == allowsControl else { return }
      switch result {
      case .success(let value): code = value
      case .failure(let failure): error = failure.localizedDescription
      }
    }
  }
}

struct QRCodeImage: View {
  var text: String

  var body: some View {
    if let image = Self.render(text) {
      Image(nsImage: image)
        .interpolation(.none)
        .resizable()
        .scaledToFit()
        .padding(Space.lg)
        .background(RoundedRectangle(cornerRadius: Radius.card).fill(.white))
    }
  }

  static func render(_ text: String) -> NSImage? {
    let filter = CIFilter.qrCodeGenerator()
    filter.message = Data(text.utf8)
    filter.correctionLevel = "M"
    guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
      let cgImage = CIContext().createCGImage(output, from: output.extent)
    else { return nil }
    return NSImage(cgImage: cgImage, size: output.extent.size)
  }
}

private func copy(_ text: String) {
  NSPasteboard.general.clearContents()
  NSPasteboard.general.setString(text, forType: .string)
}
