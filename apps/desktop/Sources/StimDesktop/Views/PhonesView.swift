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
          "Runs stim-server on port \(String(server.port)) while Stim Desktop is open, or uses one that is already running. Phones connect through Tailscale and can only read."
        )
        .foregroundStyle(Theme.tertiary)
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
        ForEach([server.devicesError, server.revokeError].compactMap { $0 }, id: \.self) { error in
          Text(abbreviatingHome(error)).foregroundStyle(Theme.error)
        }
        if server.devices.isEmpty {
          Text("No paired phones.").foregroundStyle(Theme.secondary)
        }
        ForEach(server.devices) { device in
          DeviceRow(device: device) { revoking = device }
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
          .foregroundStyle(Theme.tertiary)
      }
    }
    .formStyle(.grouped)
    .scrollContentBackground(.hidden)
    .background(Theme.background)
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
      pairing = true
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
      Label("Not serving", systemImage: "circle").foregroundStyle(Theme.secondary)
    case .starting:
      HStack(spacing: 8) {
        ProgressView().controlSize(.small)
        Text("Starting stim-server\u{2026}").foregroundStyle(Theme.secondary)
      }
    case .running(let health, let owned):
      HStack(spacing: 8) {
        StatusDot(color: health.tailscale.isRunning ? Theme.live : Theme.warn)
        Text(
          "stim-server \(health.version) on port \(String(server.port))\(owned ? "" : ", started outside Stim Desktop")"
        )
        Spacer()
        Text(health.tailscale.isRunning ? "Tailscale" : "This Mac only")
          .font(Theme.mono())
          .foregroundStyle(Theme.tertiary)
      }
    case .failed(let message):
      VStack(alignment: .leading, spacing: 8) {
        Text(abbreviatingHome(message)).foregroundStyle(Theme.error).textSelection(.enabled)
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
      VStack(alignment: .leading, spacing: 10) {
        Label(tailscale.summary, systemImage: "exclamationmark.triangle.fill")
          .foregroundStyle(Theme.warn)
        Text("Phones cannot connect until Tailscale runs. Only a client on this Mac, such as an iOS Simulator, can pair now.")
          .foregroundStyle(Theme.secondary)
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
      .padding(.vertical, 4)
    }
  }

  private func step(_ title: String, command: String) -> some View {
    VStack(alignment: .leading, spacing: 6) {
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
      VStack(alignment: .leading, spacing: 10) {
        switch route.state {
        case "routed":
          Label("Phones connect to \(route.endpoint(dnsName: dnsName)), tailnet only.", systemImage: "checkmark.circle.fill")
            .foregroundStyle(Theme.live)
          Text("tailscale serve forwards HTTPS port \(String(route.port)) to 127.0.0.1:\(String(port)).")
            .foregroundStyle(Theme.secondary)
        case "funneled":
          Label(
            "Tailscale Funnel is on for port \((route.ports ?? []).map(String.init).joined(separator: ", ")), which forwards to stim-server, so the server is reachable from the public internet. Pairing is refused.",
            systemImage: "exclamationmark.octagon.fill"
          )
          .foregroundStyle(Theme.error)
          .fixedSize(horizontal: false, vertical: true)
          Text("Remove that handler (see tailscale serve status), then serve stim-server on a tailnet-only port:")
            .foregroundStyle(Theme.secondary)
          command
        case "missing":
          Label("No tailscale serve route reaches port \(String(port)), so phones cannot connect yet.", systemImage: "exclamationmark.triangle.fill")
            .foregroundStyle(Theme.warn)
          Text("Once, serve it on a dedicated tailnet-only port. Phones then connect to \(route.endpoint(dnsName: dnsName)).")
            .foregroundStyle(Theme.secondary)
          command
        default:
          Label(
            "Could not read tailscale serve status: \(route.reason ?? "unknown reason"). Pairing assumes \(route.endpoint(dnsName: dnsName)).",
            systemImage: "exclamationmark.triangle.fill"
          )
          .foregroundStyle(Theme.warn)
          .fixedSize(horizontal: false, vertical: true)
        }
      }
      .padding(.vertical, 4)
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
  var revoke: () -> Void

  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: "iphone").font(.system(size: 18)).foregroundStyle(Theme.lavender)
      VStack(alignment: .leading, spacing: 3) {
        Text(device.name).font(Theme.body(13, weight: .semibold))
        Text(device.node).font(Theme.mono()).foregroundStyle(Theme.secondary)
      }
      Spacer()
      VStack(alignment: .trailing, spacing: 3) {
        Text(lastSeen).foregroundStyle(Theme.secondary)
        Text("Paired \(device.pairedAt.formatted(date: .abbreviated, time: .shortened))")
          .foregroundStyle(Theme.tertiary)
      }
      .font(Theme.body(11.5))
      Button("Revoke", role: .destructive, action: revoke)
    }
    .padding(.vertical, 2)
  }

  private var lastSeen: String {
    guard let at = device.lastSeenAt else { return "Never seen" }
    return "Seen \(at.formatted(.relative(presentation: .named)))"
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

  var body: some View {
    VStack(spacing: 18) {
      Text("Pair a Phone").font(Theme.heading(20))
      if let paired {
        Image(systemName: "checkmark.circle.fill").font(.system(size: 56)).foregroundStyle(Theme.live)
        Text("Paired \(paired.name)").font(Theme.body(15, weight: .semibold))
        Text(paired.node).font(Theme.mono()).foregroundStyle(Theme.secondary)
      } else if let error {
        Text(abbreviatingHome(error)).foregroundStyle(Theme.error).textSelection(.enabled)
        Button("Try Again", action: load)
      } else if let code {
        codeView(code)
      } else {
        ProgressView().frame(width: 260, height: 260)
      }
      HStack {
        Spacer()
        Button(paired == nil ? "Cancel" : "Done") { dismiss() }.keyboardShortcut(paired == nil ? .cancelAction : .defaultAction)
      }
    }
    .padding(24)
    .frame(width: 420)
    .background(Theme.background)
    .font(Theme.body())
    .foregroundStyle(Theme.text)
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
      VStack(spacing: 14) {
        Text("Scan this code with the Stim app on your phone. It pairs one phone.")
          .foregroundStyle(Theme.secondary)
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
          .font(Theme.mono(12))
          .foregroundStyle(remaining > 30 ? Theme.secondary : Theme.warn)
        VStack(alignment: .leading, spacing: 6) {
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
          .foregroundStyle(Theme.warn)
          .font(Theme.body(12))
          .fixedSize(horizontal: false, vertical: true)
        }
        if code.isLocalOnly {
          Label(
            "Tailscale is not running, so this endpoint works only on this Mac, for example in an iOS Simulator.",
            systemImage: "exclamationmark.triangle.fill"
          )
          .foregroundStyle(Theme.warn)
          .font(Theme.body(12))
          .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
  }

  private func detail(_ title: String, _ value: String, secret: Bool = false) -> some View {
    HStack {
      Text(title).foregroundStyle(Theme.tertiary).frame(width: 64, alignment: .leading)
      if secret && !showsToken {
        Text(String(repeating: "\u{2022}", count: 16)).font(Theme.mono()).lineLimit(1)
      } else {
        Text(value).font(Theme.mono()).lineLimit(1).truncationMode(.middle).textSelection(.enabled)
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
    .font(Theme.body(12))
  }

  private func load() {
    error = nil
    code = nil
    showsToken = false
    let port = server.port
    Task {
      let cli = await server.cli()
      switch await Task.detached(operation: { Result { try cli.pair(port: port) } }).value {
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
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 12).fill(.white))
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
