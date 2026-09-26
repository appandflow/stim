import EmulatorFrames
import SimulatorFrames
import StimKit
import SwiftUI
import WebKit

struct DeviceTile: View {
  var device: DeviceRef
  var screenHeight: CGFloat
  var interactive = false
  var workspace: String?
  var workspaceTitle: String?
  var build: Build? = nil
  var takenOver = false
  var onToggleTakeOver: (() -> Void)? = nil
  @State private var pixelSizes: [UInt32: CGSize] = [:]
  @State private var screenIDs: [UInt32] = [1]
  @State private var lit: [UInt32: Bool] = [:]
  @State private var folding = false
  @State private var rotateFailed = false
  @State private var foldError: String?
  @State private var emulatorPosture: EmulatorPosture?
  @State private var postureFailed = false
  @State private var confirmingStop = false
  @EnvironmentObject private var actions: ActionCenter

  private let screenPadding: CGFloat = 12

  var body: some View {
    Card {
      VStack(spacing: 0) {
        header
          .padding(.horizontal, 12)
          .padding(.vertical, 9)
        if let build {
          BuildProgressBar(build: build, compact: true).padding(.horizontal, 12).padding(.bottom, 9)
        }
        Rectangle().fill(Theme.border).frame(height: 1)
        if let workspace, showsStoppedBar {
          stoppedBar(runCommand(for: device, cwd: workspace))
        } else {
          screen
            .frame(height: screenHeight)
            .background(Theme.screen)
        }
      }
    }
    .overlay {
      if case .remote = device {
        RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.remote, lineWidth: 2)
      } else if interactive {
        RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.lavender, lineWidth: 2)
      }
    }
    .frame(width: width)
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 8) {
        StatusDot(color: device.isRunning ? Theme.live : Theme.tertiary, filled: device.isRunning)
        ViewThatFits(in: .horizontal) {
          HStack(spacing: 4) {
            Text(device.label).font(Theme.body(12, weight: .semibold))
            if let detail = device.detail {
              Text(detail).font(Theme.body(12)).foregroundStyle(Theme.secondary)
            }
          }
          Text(device.label).font(Theme.body(12, weight: .semibold))
        }
        .help([device.label, device.detail].compactMap { $0 }.joined(separator: " "))
        .lineLimit(1)
        .layoutPriority(1)
        Spacer(minLength: 8)
        takeOverButton
        if case .remote = device {
          remoteControls
        } else if device.isRunning, let workspace {
          stopButton(workspace: workspace)
        }
        if interactive {
          rotateButton(clockwise: false)
          rotateButton(clockwise: true)
        }
        if interactive, device.formFactor == .dual, screenIDs.count > 1, SimulatorFold.isAvailable,
          case .ios(_, let sim) = device
        {
          foldButton(udid: sim.udid)
        }
        if interactive, let emulatorPosture, case .android(_, let avd) = device, let serial = avd.serial {
          postureMenu(serial: serial, current: emulatorPosture)
        }
      }
      FlowLayout(spacing: 6) {
        TimelineView(.periodic(from: .now, by: 30)) { context in
          if let badge = ActivityBadge(
            device.activity, screenChangedAt: device.activityKey.flatMap(ScreenActivity.shared.lastChange),
            now: context.date)
          {
            activityChip(badge)
          }
        }
        if device.appStopped {
          Chip(tint: Theme.warn) { Text("App not running") }
            .fixedSize()
            .help("stim status sees no \(device.app?.id ?? "app") process on this device.")
          if let workspace, let run = runCommand(for: device, cwd: workspace) {
            Button("Run", systemImage: "play.fill") {
              actions.run("Run on \(platformName(device.platform))", run)
            }
            .buttonStyle(.stim(.primary))
            .fixedSize()
            .disabled(actions.active(for: workspace) != nil || build != nil)
            .help((["stim"] + run.arguments).joined(separator: " "))
          }
        }
        Text(source).font(Theme.body(10.5)).foregroundStyle(Theme.tertiary).lineLimit(1).fixedSize()
        if let posture = posture ?? emulatorPosture?.label {
          Chip { Text(posture) }.fixedSize()
        }
      }
    }
  }

  @ViewBuilder private var takeOverButton: some View {
    if let onToggleTakeOver {
      if takenOver {
        Button("Release", systemImage: "hand.raised.fill", action: onToggleTakeOver)
          .buttonStyle(.borderedProminent)
          .tint(Theme.lavender)
          .controlSize(.small)
          .fixedSize()
          .help("Release control so an agent can drive this device again.")
      } else {
        Button("Take over", systemImage: "hand.raised", action: onToggleTakeOver)
          .buttonStyle(.bordered)
          .controlSize(.small)
          .fixedSize()
          .help("Send your clicks, trackpad scrolls and keys to this device. If an agent is driving it, taking over may disrupt it.")
      }
    }
  }

  private var isPhysical: Bool {
    if case .android(_, let avd) = device { return avd.physical }
    return false
  }

  private var showsStoppedBar: Bool {
    if case .remote = device { return false }
    return !device.isRunning && build == nil && !["Booting", "unknown"].contains(device.state)
  }

  private func stoppedBar(_ run: StimCommand?) -> some View {
    HStack(spacing: 10) {
      Text(
        run.map { "Not running. Run stim \($0.arguments.joined(separator: " ")) to boot it and install the app." }
          ?? (isPhysical ? "Not connected." : "Shut down. Stim does not boot a device it does not own.")
      )
      .font(Theme.body(12))
      .foregroundStyle(Theme.secondary)
      .fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 0)
      if let run {
        Button("Run") { actions.run("Run \(device.slot)", run) }
          .buttonStyle(.stim())
          .fixedSize()
          .disabled(actions.active(for: run.cwd) != nil)
          .help(run.displayLine())
      }
    }
    .padding(12)
  }

  private func stopButton(workspace: String) -> some View {
    Button("Stop") {
      actions.run("Stop \(device.slot)", stopCommand(for: device, cwd: workspace))
    }
    .buttonStyle(.stim(.destructive))
    .fixedSize()
    .disabled(actions.active(for: workspace) != nil)
    .help("stim stop --slot \(device.slot): stops every device in this slot, keeping the shared server and other slots running")
  }

  @ViewBuilder private var remoteControls: some View {
    Chip(tint: Theme.warn) { Text("billable") }
      .fixedSize()
      .help("This remote session is billed while it runs.")
    if let workspace {
      Button("Stop") { confirmingStop = true }
        .buttonStyle(.stim(.destructive))
        .fixedSize()
        .disabled(actions.active(for: workspace) != nil)
        .help("stim stop: ends the remote session with the rest of the workspace")
        .confirmationDialog("Stop this workspace?", isPresented: $confirmingStop, titleVisibility: .visible) {
          Button("Run stim stop", role: .destructive) {
            actions.run(
              "Stop \(workspaceTitle ?? workspace)", StimCommand(["stop"], cwd: workspace))
          }
        } message: {
          Text(
            "stim stop ends the billable remote session and halts the workspace's dev server and devices. The session cannot be resumed."
          )
        }
    }
  }

  private func activityChip(_ badge: ActivityBadge) -> some View {
    let tint: Color
    switch badge {
    case .driven: tint = Theme.lavender
    case .idle: tint = Theme.tertiary
    case .unknown: tint = Theme.warn
    }
    return Chip(tint: tint) { Text(badge.text) }
      .fixedSize()
      .help(device.activity.map { "stim status activity: \($0.basis.joined(separator: ", "))" } ?? "")
  }

  private func rotateButton(clockwise: Bool) -> some View {
    Button {
      Task {
        switch device {
        case .ios(_, let sim): rotateFailed = !SimulatorRotation.rotate(udid: sim.udid, clockwise: clockwise)
        case .android(_, let avd):
          guard let serial = avd.serial else { return }
          rotateFailed = !(await EmulatorRotation.rotate(serial: serial, clockwise: clockwise))
        case .remote: break
        }
      }
    } label: {
      Image(systemName: clockwise ? "rotate.right" : "rotate.left")
    }
    .buttonStyle(.stim())
    .help(rotateFailed ? "The last rotation did not reach the device." : clockwise ? "Rotate right" : "Rotate left")
  }

  private func foldButton(udid: String) -> some View {
    let action = posture == "Folded" ? "Unfold" : posture == "Unfolded" ? "Fold" : "Fold / Unfold"
    return Button(folding ? "Folding" : foldError == nil ? action : "\(action) failed, retry") {
      folding = true
      Task {
        foldError = await SimulatorFold.toggle(udid: udid)
        folding = false
      }
    }
    .buttonStyle(.stim())
    .fixedSize()
    .disabled(folding)
    .help(foldError ?? "Sweeps the hinge to the other posture, which lights the other screen.")
  }

  private func postureMenu(serial: String, current: EmulatorPosture) -> some View {
    Menu(postureFailed ? "Posture failed, retry" : "Posture") {
      ForEach([EmulatorPosture.closed, .halfOpened, .opened], id: \.self) { posture in
        Toggle(
          posture.label,
          isOn: Binding(
            get: { posture == current },
            set: { _ in
              Task {
                postureFailed = !(await posture.apply(serial: serial))
                emulatorPosture = await EmulatorPosture.current(serial: serial)
              }
            }))
      }
    }
    .menuStyle(.button)
    .buttonStyle(.stim())
    .fixedSize()
    .help(postureFailed ? "The last posture change did not reach the emulator." : "Moves the emulator's hinge.")
  }

  /// The panel an iPhone Duo's posture lit: the only lit one, else the first.
  private var mainScreenID: UInt32? {
    let litIDs = screenIDs.filter { lit[$0] == true }
    return litIDs.count == 1 ? litIDs[0] : screenIDs.first
  }

  /// Folded when the smaller panel, the cover, is the only lit one.
  private var posture: String? {
    guard screenIDs.count > 1, screenIDs.filter({ lit[$0] == true }).count == 1, let main = mainScreenID,
      let area = pixelArea(main), let smallest = screenIDs.compactMap(pixelArea).min()
    else { return nil }
    return area == smallest ? "Folded" : "Unfolded"
  }

  private func pixelArea(_ screenID: UInt32) -> CGFloat? {
    pixelSizes[screenID].map { $0.width * $0.height }
  }

  private func screenHeight(_ screenID: UInt32) -> CGFloat {
    let full = screenHeight - screenPadding * 2
    return screenIDs.count > 1 && screenID != mainScreenID ? full * 0.3 : full
  }

  private func screenWidth(_ screenID: UInt32) -> CGFloat? {
    guard let size = pixelSizes[screenID], size.height > 0 else { return nil }
    return screenHeight(screenID) * size.width / size.height
  }

  private var width: CGFloat {
    let widths = screenIDs.compactMap(screenWidth)
    if widths.count == screenIDs.count {
      return max(240, widths.reduce(0, +) + screenPadding * CGFloat(screenIDs.count + 1))
    }
    if case .remote = device { return max(360, screenHeight * 0.6) }
    switch device.formFactor {
    case .phone: return max(240, screenHeight * 0.52)
    case .tablet: return screenHeight * 0.78
    case .dual: return screenHeight * 1.4
    }
  }

  private var source: String {
    switch device {
    case .ios: return "iOS Simulator"
    case .android: return "Android Emulator"
    case .remote(let d): return d.backend == "eas" ? "EAS Simulator" : "Remote device"
    }
  }

  @ViewBuilder private var screen: some View {
    switch device {
    case .ios(_, let sim) where device.isRunning:
      HStack(alignment: .bottom, spacing: screenPadding) {
        ForEach(screenIDs, id: \.self) { screenID in
          SimulatorDisplayView(
            udid: sim.udid, screenID: screenID, interactive: interactive,
            onPixelSizeChange: { pixelSizes[screenID] = $0 },
            onLitChange: screenIDs.count > 1 ? { lit[screenID] = $0 } : nil
          )
          .frame(width: screenWidth(screenID), height: screenHeight(screenID))
          .opacity(screenID == mainScreenID ? 1 : 0.4)
        }
      }
      .padding(screenPadding)
      .task(id: sim.udid) {
        while !Task.isCancelled {
          let ids = CoreSimulator.screenIDs(udid: sim.udid)
          if !ids.isEmpty { screenIDs = device.formFactor == .dual ? ids : [ids[0]] }
          if !ids.isEmpty, device.formFactor != .dual || ids.count > 1 { return }
          try? await Task.sleep(for: .seconds(2))
        }
      }
    case .android(_, let avd) where device.isRunning && avd.owned && !avd.physical:
      if let serial = avd.serial {
        EmulatorScreen(serial: serial, interactive: interactive) { pixelSizes[1] = $0 }
          .frame(width: screenWidth(1))
          .padding(screenPadding)
          .task(id: "\(serial) \(String(describing: pixelSizes[1]))") {
            while !Task.isCancelled {
              emulatorPosture = await EmulatorPosture.current(serial: serial)
              try? await Task.sleep(for: .seconds(emulatorPosture == nil ? 30 : 5))
            }
          }
      } else {
        placeholder(device.state)
      }
    case .remote(let remote):
      if let url = remote.webPreviewUrl.flatMap(URL.init(string:)), ["http", "https"].contains(url.scheme) {
        RemotePreview(url: url).padding(screenPadding)
      } else {
        placeholder("No preview URL was recorded for session \(remote.sessionId).")
      }
    default:
      placeholder(device.state)
    }
  }

  private func placeholder(_ text: String) -> some View {
    ScreenMessage(text: text)
  }
}

extension DeviceRef {
  var isInteractive: Bool {
    switch self {
    case .ios: return isRunning
    case .android(_, let avd): return isRunning && avd.owned && !avd.physical && avd.serial != nil
    case .remote: return false
    }
  }
}

private struct RemotePreview: NSViewRepresentable {
  var url: URL

  /// Hides the page's own scrollbars and gives it a background matching the
  /// tile, so macOS's legacy always-visible scrollbar track (shown with a
  /// mouse connected, or "Show scroll bars: Always") never shows through as
  /// a white bar next to the dark preview.
  static let hideScrollbarsScript = """
    (function () {
      var style = document.createElement('style');
      style.textContent = [
        '::-webkit-scrollbar { display: none; }',
        'html, body { overflow: hidden; scrollbar-width: none; background: #0c0a11; }',
      ].join('\\n');
      document.head.appendChild(style);
    })();
    """

  final class Coordinator: NSObject, WKNavigationDelegate {
    var loaded: URL?

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
      webView.evaluateJavaScript("document.documentElement.scrollHeight") { result, _ in
        guard let pageHeight = result as? CGFloat, pageHeight > webView.bounds.height else { return }
        webView.pageZoom = webView.bounds.height / pageHeight
      }
    }
  }

  func makeCoordinator() -> Coordinator { Coordinator() }

  func makeNSView(context: Context) -> WKWebView {
    let userContentController = WKUserContentController()
    userContentController.addUserScript(
      WKUserScript(
        source: Self.hideScrollbarsScript, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
    let configuration = WKWebViewConfiguration()
    configuration.userContentController = userContentController

    let view = WKWebView(frame: .zero, configuration: configuration)
    view.navigationDelegate = context.coordinator
    view.setValue(false, forKey: "drawsBackground")
    view.underPageBackgroundColor = NSColor(hex: 0x0C0A11)
    return view
  }

  func updateNSView(_ view: WKWebView, context: Context) {
    guard context.coordinator.loaded != url else { return }
    context.coordinator.loaded = url
    view.load(URLRequest(url: url))
  }
}

private struct EmulatorScreen: View {
  var serial: String
  var interactive: Bool
  var onPixelSizeChange: (CGSize) -> Void
  @State private var status = EmulatorStreamStatus.connecting

  var body: some View {
    EmulatorDisplayView(
      serial: serial, interactive: interactive,
      onStatus: { status in DispatchQueue.main.async { self.status = status } },
      onPixelSizeChange: { size in DispatchQueue.main.async { onPixelSizeChange(size) } })
    .overlay {
      switch status {
      case .connecting: ScreenMessage(text: "Connecting to the emulator")
      case .noEndpoint: ScreenMessage(text: "This emulator has no gRPC endpoint. Frames appear after Stim next boots it.")
      case .streaming: EmptyView()
      }
    }
  }
}

private struct ScreenMessage: View {
  var text: String

  var body: some View {
    Text(text)
      .font(Theme.body(12))
      .foregroundStyle(Theme.tertiary)
      .multilineTextAlignment(.center)
      .padding()
      .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}
