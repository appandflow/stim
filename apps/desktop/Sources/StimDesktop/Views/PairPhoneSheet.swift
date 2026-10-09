import AppKit
import CoreImage
import CoreImage.CIFilterBuiltins
import StimKit
import SwiftUI

struct PairPhoneSheet: View {
  @Bindable var model: PairPhoneModel
  var openPhones: (() -> Void)? = nil
  @Environment(\.dismiss) private var dismiss
  @State private var showsToken = false

  private var wizard: PhonePairing { model.wizard }

  var body: some View {
    HStack(spacing: 0) {
      VStack(alignment: .leading, spacing: Space.sm) {
        Text("Pair a Phone").font(.stim(.headline)).padding(.bottom, Space.xl)
        ForEach(PhonePairing.Step.allCases, id: \.self) { step in
          let done = step < wizard.step || wizard.step == .done
          let current = step == wizard.step && !done
          HStack(spacing: Space.md) {
            Image(systemName: done ? "checkmark.circle.fill" : current ? "circle.inset.filled" : "circle")
            Text(step.title).font(.stim(.callout, weight: step == wizard.step ? .semibold : .regular))
          }
          .foregroundStyle(
            step == wizard.step ? (done ? Palette.success : Palette.accent) : done ? Palette.secondary : Palette.tertiary
          )
          .frame(height: 30)
          .accessibilityLabel(step.title + (done ? ", done" : current ? ", current step" : ", waiting"))
        }
        Spacer()
      }
      .padding(Space.xl).frame(width: 170).background(Palette.sidebar)
      Divider()
      VStack(spacing: 0) {
        if model.isFixture {
          content.frame(maxHeight: .infinity, alignment: .topLeading)
        } else {
          ScrollView { content }
        }
        Divider()
        footer.padding(Space.xl)
      }
    }
    .frame(width: 740, height: 600)
    .font(.stim(.body)).foregroundStyle(Palette.text).tint(Palette.primary)
    .background(Palette.background)
    .task { await model.start() }
    .onDisappear { model.cancel() }
    .onQuitRequested {
      model.cancel()
      dismiss()
    }
    .onChange(of: model.code) { showsToken = false }
  }

  private var content: some View {
    VStack(alignment: .leading, spacing: Space.lg) {
      switch wizard.step {
      case .app: appContent
      case .tailscale: tailscaleContent
      case .serve: serveContent
      case .pair: pairContent
      case .done: doneContent
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading).padding(Space.xxl)
  }

  private var appContent: some View {
    Group {
      PhoneAppsArt()
      Text("Get the Apps on Your Phone").font(.stim(.title))
      HStack(alignment: .top, spacing: Space.md) {
        appCard {
          Text("Stim Mobile").font(.stim(.headline))
          Text("Install Stim Mobile from your TestFlight invitation.").foregroundStyle(Palette.secondary)
          Link("How to Get Stim Mobile", destination: URL(string: "https://stim.appandflow.com/docs/phone-app#install")!)
        }
        appCard {
          Text("Tailscale").font(.stim(.headline))
          QRCodeImage(text: "https://apps.apple.com/app/tailscale/id1470499037").frame(width: 112, height: 112)
          Text("Scan with your phone's camera to get Tailscale.").foregroundStyle(Palette.secondary)
          Link("Open App Store Page", destination: URL(string: "https://apps.apple.com/app/tailscale/id1470499037")!)
        }
      }
    }
  }

  private func appCard(@ViewBuilder content: () -> some View) -> some View {
    VStack(alignment: .leading, spacing: Space.md, content: content)
      .fixedSize(horizontal: false, vertical: true)
      .frame(maxWidth: .infinity, alignment: .leading).padding(Space.lg)
      .background(Palette.surface, in: RoundedRectangle(cornerRadius: Radius.card))
      .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Palette.border))
  }

  private var tailscaleContent: some View {
    Group {
      switch wizard.tailscale {
      case .stopped(true): AddMachineIllustration(scene: .tailscaleSwitch)
      case .stopped(false): AddMachineIllustration(scene: .tailscaleUp)
      case .missing: AddMachineIllustration(scene: .tailnet(connected: false))
      case .checking, .running: PhoneTailnetArt()
      }
      Text("Connect Both to Your Tailnet").font(.stim(.title))
      VStack(alignment: .leading, spacing: Space.md) {
        Text("This Mac").font(.stim(.headline))
        switch wizard.tailscale {
        case .checking:
          HStack(spacing: Space.sm) {
            ProgressView().controlSize(.small)
            Text("Checking Tailscale\u{2026}").foregroundStyle(Palette.secondary)
          }
        case .running(let dns):
          Label("Tailscale is on", systemImage: "checkmark.circle.fill").foregroundStyle(Palette.success)
          if let dns { Text(dns).font(.stim(.caption)).foregroundStyle(Palette.secondary) }
        case .stopped(let hasApp):
          Label("Tailscale is off on this Mac", systemImage: "xmark.circle.fill").foregroundStyle(Palette.warning)
          if hasApp {
            Text("Turn on Tailscale in its menu bar app. This step continues by itself once it is connected.")
              .foregroundStyle(Palette.secondary).fixedSize(horizontal: false, vertical: true)
          } else {
            Text("Start Tailscale in Terminal. This step continues by itself once it is up.").foregroundStyle(Palette.secondary)
            CopyableCommand(command: "tailscale up")
          }
        case .missing:
          Label("Tailscale is not installed on this Mac", systemImage: "xmark.circle.fill").foregroundStyle(Palette.warning)
          Button("Download Tailscale", systemImage: "arrow.down.circle") {
            NSWorkspace.shared.open(URL(string: "https://tailscale.com/download/mac")!)
          }
          .buttonStyle(.stim(.primary, .regular))
        }
        Divider()
        Text("Your Phone").font(.stim(.headline))
        Text("Open Tailscale on your phone and sign in with the same account as this Mac.").foregroundStyle(Palette.secondary)
      }
    }
  }

  private var serveContent: some View {
    Group {
      PhoneServeArt()
      Text("Turning On Serving").font(.stim(.title))
      checkRow(wizard.serverCheck) {
        switch wizard.server {
        case .running: Text("Stim server is running")
        case .starting: Text("Starting the Stim server")
        case .off: Text(wizard.serverCheck == .working ? "Starting the Stim server" : "Start the Stim server")
        case .degraded(let reason):
          Text("The Stim server can't read its Stim home: \(abbreviatingHome(reason)). It retries every 30 seconds.")
        case .failed(let message):
          Text("The Stim server did not start: \(abbreviatingHome(message))")
          Button("Try Again") { model.send(.retry) }.buttonStyle(.stim())
        }
      }
      checkRow(wizard.tailnetCheck) {
        Text(
          wizard.tailnetCheck == .ok
            ? "Connected to your tailnet"
            : wizard.tailnetCheck == .problem
              ? "The Stim server is not on your tailnet. Turn on Tailscale on this Mac." : "Connect to your tailnet")
      }
      checkRow(wizard.routeCheck) {
        switch wizard.routeCheck {
        case .ok: Text("Private tailnet route is ready")
        case .working:
          Text(model.route == nil ? "Waiting for the Stim server to report its route" : "Setting up a private tailnet route")
        case .waiting: Text("Set up a private tailnet route")
        case .problem:
          if let route = model.route, route.state == "funneled" {
            Text(
              "Tailscale Funnel makes this connection public, so pairing is off. Remove that Funnel handler (see tailscale serve status), then serve it on a tailnet-only port:"
            )
            CopyableCommand(command: route.setupCommand(serverPort: model.serverPort))
          } else {
            let error = wizard.routeError ?? model.connectionError ?? "The route is still missing."
            Text(error).textSelection(.enabled)
            if let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue),
              let url = detector.matches(in: error, range: NSRange(error.startIndex..., in: error))
                .compactMap(\.url).first(where: { $0.scheme == "https" && $0.host == "login.tailscale.com" })
            {
              Link("Open Tailscale Setup", destination: url)
            }
            Button("Try Again") { model.send(.retry) }.buttonStyle(.stim())
          }
        }
      }
      Text("Phones reach this Mac only through your tailnet, never the public internet.")
        .font(.stim(.footnote)).foregroundStyle(Palette.secondary)
      if wizard.servesOtherHome, let home = model.serverStimHome {
        Label(
          "This server keeps pairings in \(abbreviatingHome(home)), not ~/.stim. Phones paired now stop working when Stim Desktop serves ~/.stim again.",
          systemImage: "exclamationmark.triangle.fill"
        )
        .foregroundStyle(Palette.warning).font(.stim(.footnote))
      }
    }
  }

  private func checkRow(_ check: PhonePairing.Check, @ViewBuilder content: () -> some View) -> some View {
    HStack(alignment: .top, spacing: Space.md) {
      Group {
        switch check {
        case .waiting: Image(systemName: "circle").foregroundStyle(Palette.tertiary)
        case .working: ProgressView().controlSize(.small)
        case .ok: Image(systemName: "checkmark.circle.fill").foregroundStyle(Palette.success)
        case .problem: Image(systemName: "xmark.circle.fill").foregroundStyle(Palette.warning)
        }
      }.frame(width: 18, height: 18)
      VStack(alignment: .leading, spacing: Space.sm, content: content)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private var pairContent: some View {
    VStack(alignment: .leading, spacing: Space.sm) {
      Text("Scan with Stim Mobile").font(.stim(.title))
      Picker("Access", selection: Binding(get: { wizard.control }, set: { model.send(.access(control: $0)) })) {
        Text("View Only").tag(false)
        Text("View and Control").tag(true)
      }.pickerStyle(.segmented)
      Text(
        wizard.control
          ? "It can drive simulators and emulators, and run Reload and Stop." : "It sees workspaces, devices and logs."
      )
      .font(.stim(.footnote)).foregroundStyle(Palette.secondary)
      if let error = wizard.codeError {
        Text(error).foregroundStyle(Palette.error).textSelection(.enabled)
        Button("Try Again") { model.send(.newCode) }.buttonStyle(.stim())
      } else if wizard.requestingCode {
        ProgressView().frame(width: 240, height: 240).frame(maxWidth: .infinity)
      } else if let code = model.code {
        TimelineView(.periodic(from: .now, by: 1)) { context in
          let now = model.isFixture ? model.now : context.date
          let remaining = max(0, Int(code.expiresAt.timeIntervalSince(now).rounded(.up)))
          let expired = wizard.codeExpired(now: now)
          VStack(spacing: Space.sm) {
            ZStack {
              QRCodeImage(text: code.qrText).frame(width: 240, height: 240).blur(radius: expired ? 8 : 0)
                .accessibilityLabel("Pairing QR code")
              if expired {
                Button("Show a New Code") { model.send(.newCode) }.buttonStyle(.stim(.primary))
              }
            }.frame(maxWidth: .infinity)
            Text(expired ? "This code expired." : "Expires in \(remaining / 60):\(String(format: "%02d", remaining % 60))")
              .font(.stim(.callout, mono: true)).foregroundStyle(remaining > 30 ? Palette.secondary : Palette.warning)
          }
        }
        DisclosureGroup("Can't Scan? Enter the Endpoint and Token", isExpanded: $model.manualExpanded) {
          VStack(spacing: Space.sm) {
            detail("Endpoint", code.qr.endpoint)
            detail("Token", code.qr.pairingToken, secret: true)
          }.padding(.top, Space.sm)
        }
        if code.isLocalOnly {
          warning("Tailscale is off, so only a simulator on this Mac can use this code.")
        }
      }
      HStack(spacing: Space.sm) {
        ProgressView().controlSize(.small)
        Text("Waiting for your phone\u{2026}").foregroundStyle(Palette.secondary)
      }
      if !wizard.server.isReady { warning("Serving stopped. Go Back to turn it on again.") }
    }
  }

  private func detail(_ title: String, _ value: String, secret: Bool = false) -> some View {
    HStack {
      Text(title).foregroundStyle(Palette.tertiary).frame(width: 64, alignment: .leading)
      Text(secret && !showsToken ? String(repeating: "\u{2022}", count: 16) : value)
        .font(.stim(.caption, mono: true)).lineLimit(1).truncationMode(.middle).textSelection(.enabled)
      Spacer()
      if secret {
        Button {
          showsToken.toggle()
        } label: {
          Image(systemName: showsToken ? "eye.slash" : "eye")
        }
        .buttonStyle(.borderless).accessibilityLabel(showsToken ? "Hide token" : "Show token")
        .help(showsToken ? "Hide token" : "Show token")
      }
      CopyButton(value)
    }
  }

  private func warning(_ text: String) -> some View {
    Label(text, systemImage: "exclamationmark.triangle.fill")
      .font(.stim(.footnote)).foregroundStyle(Palette.warning).fixedSize(horizontal: false, vertical: true)
  }

  private var doneContent: some View {
    Group {
      PhonePairedArt()
      if let paired = wizard.paired {
        Text("\(paired.name) is paired").font(.stim(.title))
        Label("Sees workspaces, devices and logs", systemImage: "checkmark.circle.fill").foregroundStyle(Palette.success)
        if paired.canControl {
          Label("Drives simulators and emulators, and runs Reload and Stop", systemImage: "checkmark.circle.fill")
            .foregroundStyle(Palette.success)
        } else {
          Text("View only. You can allow control in Settings > Phones.").foregroundStyle(Palette.secondary)
        }
        Text("Manage it in Settings > Phones.").foregroundStyle(Palette.secondary)
        if let openPhones {
          Button("Open Phones") {
            openPhones()
            dismiss()
          }.buttonStyle(.stim())
        }
      }
    }
  }

  private var footer: some View {
    HStack(spacing: Space.md) {
      if wizard.canGoBack {
        Button("Back") { model.send(.back) }.buttonStyle(.stim())
      }
      Spacer()
      if wizard.step == .done {
        Button("Done") { dismiss() }.buttonStyle(.stim(.primary)).keyboardShortcut(.defaultAction)
      } else {
        Button("Cancel") {
          model.cancel()
          dismiss()
        }.buttonStyle(.stim()).keyboardShortcut(.cancelAction)
        if wizard.step <= .serve {
          Button("Next") { model.send(.next) }.buttonStyle(.stim(.primary))
            .disabled(!wizard.canContinue).keyboardShortcut(.defaultAction)
        }
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
