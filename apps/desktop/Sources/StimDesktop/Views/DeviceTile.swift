import EmulatorFrames
import SimulatorFrames
import StimKit
import SwiftUI
import WebFrames
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
  /// False where the workspace header already names the drivers, so a driven tile only says "Driven".
  var namesDriver = true
  /// The device's replay through stim-server, where the tile offers one.
  var replay: ReplayController? = nil
  /// Whether `replay` shows recorded footage instead of the live screen.
  var replaying = false
  var replayOff = false
  var onReplaySeek: () -> Void = {}
  var usage: WorkspaceUsage? = nil
  var presence: AppPresence? = nil
  var showsCovers = false
  var focused = false
  /// The device viewer: take over, hardware buttons, rotation, replay, the agent row and Stop. A tile without it is
  /// a preview with no controls.
  var viewer = false
  /// The widest the viewer can draw the tile; the screen shrinks below `screenHeight` to fit it.
  var maxWidth: CGFloat? = nil
  /// False while the device's viewer is open, so the tile does not stream a second copy of its screen.
  var showsScreen = true
  /// The device's agent actions for the viewer's agent row, newest first.
  var agentActions: [AgentAction] = []
  var showAgentLog: () -> Void = {}
  @State private var pixelSizes: [UInt32: CGSize] = [:]
  @State private var screenIDs: [UInt32] = [1]
  @State private var lit: [UInt32: Bool] = [:]
  @State private var folding = false
  @State private var rotateFailed = false
  @State private var foldError: String?
  @State private var emulatorPosture: EmulatorPosture?
  @State private var postureFailed = false
  @State private var confirmingStop = false
  @State private var replaySize: CGSize?
  @State private var simulatorButtons = SimulatorButtons()
  @State private var emulatorButtons = EmulatorButtons()
  @EnvironmentObject private var actions: ActionCenter
  @ObservedObject private var server = ServerSession.shared

  private let screenPadding: CGFloat = 12
  static let minimumWidth: CGFloat = 240

  var body: some View {
    Card {
      VStack(spacing: 0) {
        header
          .padding(.horizontal, Space.lg)
          .padding(.vertical, Space.md)
        Rectangle().fill(Palette.border).frame(height: 1)
        if replaying, let replay {
          ReplayScreen(controller: replay) { replaySize = $0 }
            .frame(width: replayWidth)
            .padding(screenPadding)
            .frame(height: fittedHeight)
            .frame(maxWidth: .infinity)
            .background(Media.screen)
        } else if let workspace, showsStoppedBar {
          stoppedBar(runCommand(for: device, cwd: workspace))
        } else if !showsScreen {
          placeholder("Open in the viewer")
            .frame(height: fittedHeight)
            .background(Media.screen)
        } else {
          screen
            .frame(height: fittedHeight)
            .background(Media.screen)
            .overlay { screenCover }
        }
        if viewer, interactive, !isPhysical, device.platform != "web" {
          hardwareButtons
            .padding(.horizontal, Space.lg)
            .padding(.vertical, Space.md)
        }
        if viewer, device.isRunning, !isPhysical, device.activityKey != nil {
          Rectangle().fill(Palette.border).frame(height: 1)
          DeviceAgentRow(device: device, actions: agentActions, showAll: showAgentLog)
        }
        if viewer, let replay, replaying || replayOff || replay.timeline != nil {
          Rectangle().fill(Palette.border).frame(height: 1)
          ReplayBar(controller: replay, running: device.isRunning, replayOff: replayOff, onSeek: onReplaySeek)
            .padding(.horizontal, Space.lg)
            .padding(.vertical, Space.md)
        }
      }
    }
    .overlay {
      if case .remote = device {
        RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Palette.info, lineWidth: 2)
      } else if interactive {
        RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Palette.accent, lineWidth: 2)
      } else if focused {
        RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Palette.accent.opacity(0.45), lineWidth: 1.5)
      }
    }
    .frame(width: width)
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: Space.sm) {
      HStack(spacing: Space.md) {
        StatusDot(color: device.isRunning ? Palette.success : Palette.tertiary, filled: device.isRunning)
          .contentShape(Circle())
          .help("State: \(device.state)")
        ViewThatFits(in: .horizontal) {
          HStack(spacing: Space.xs) {
            Text(device.label).font(.stim(.callout, weight: .semibold))
            if let detail = device.detail {
              Text(detail).font(.stim(.callout)).foregroundStyle(Palette.secondary)
            }
          }
          Text(device.label).font(.stim(.callout, weight: .semibold))
        }
        .help([device.label, device.detail].compactMap { $0 }.joined(separator: " "))
        .lineLimit(1)
        .layoutPriority(1)
        Spacer(minLength: 8)
        if case .remote = device, !viewer {
          Pill(tone: .warning) { Text("billable") }
            .help("This remote session is billed while it runs.")
        }
        if viewer { controls }
      }
      FlowLayout(spacing: Space.sm) {
        TimelineView(.periodic(from: .now, by: 30)) { context in
          if let badge = ActivityBadge(
            device.activity, screenChangedAt: device.activityKey.flatMap(ScreenActivity.shared.lastChange),
            now: context.date)
          {
            activityChip(badge)
              .anchorPreference(key: ActivityChipAnchor.self, value: .bounds) { $0 }
          }
        }
        if device.appStopped {
          if presence != AppPresence.none {
            Pill(tone: .warning) { Text("App not running") }
              .help("stim status sees no \(device.app?.id ?? "app") process on this device.")
          }
          if viewer, let workspace, let run = runCommand(for: device, cwd: workspace) {
            Button("Run", systemImage: "play.fill") {
              actions.run("Run on \(platformName(device.platform))", run)
            }
            .buttonStyle(.stim(.primary))
            .fixedSize()
            .disabled(actions.active(for: workspace) != nil || build != nil)
            .help((["stim"] + run.arguments).joined(separator: " "))
          }
        }
        if case .web(let browser) = device, browser.pageFailed {
          Pill(tone: .warning) { Text("Page failed to load") }
            .help(browser.page?.error ?? "The page's latest load failed.")
        }
        if isPhysical {
          Pill { Text("Physical") }
            .help(
              device.platform == "ios"
                ? "A device Stim uses through this workspace's lease and never owns. Its screen is view only."
                : "A device Stim uses through this workspace's lease and never owns.")
          if let expires = device.leaseExpiresAt {
            TimelineView(.periodic(from: .now, by: 30)) { context in
              Pill("Leased \u{00B7} \(shortDuration(expires.timeIntervalSince(context.date))) left")
                .help("This workspace's lease ends at \(expires.formatted(date: .omitted, time: .shortened)).")
            }
          }
        }
        Text(source).font(.stim(.caption2)).foregroundStyle(Palette.tertiary).lineLimit(1).fixedSize()
        if let usage, !usage.isEmpty {
          HStack(spacing: Space.md) { UsageFigures(usage: usage) }
            .font(.stim(.caption))
            .accessibilityElement(children: .combine)
        }
        if let posture = posture ?? emulatorPosture?.label {
          Pill { Text(posture) }.help("Current posture")
        }
      }
    }
  }

  @ViewBuilder private var controls: some View {
    takeOverButton
    if case .remote = device {
      remoteControls
    } else if case .web(let browser) = device, let workspace {
      webControls(browser, workspace: workspace)
    } else if device.isRunning, !isPhysical, let workspace {
      stopButton(workspace: workspace)
    }
  }

  /// Home, Back, Apps and Lock as the device has them, then rotation and fold or posture. A physical Android phone's
  /// buttons come from its own screen view.
  @ViewBuilder private var hardwareButtons: some View {
    HStack(spacing: Space.sm) {
      switch device {
      case .ios:
        hardwareButton("Home", systemImage: "circle") { simulatorButtons.press(.home) }
        hardwareButton("Lock", systemImage: "lock") { simulatorButtons.press(.lock) }
      case .android:
        hardwareButton("Home", systemImage: "circle") { emulatorButtons.press(.home) }
        hardwareButton("Back", systemImage: "chevron.backward") { emulatorButtons.press(.back) }
        hardwareButton("Apps", systemImage: "square.on.square") { emulatorButtons.press(.apps) }
        hardwareButton("Lock", systemImage: "lock") { emulatorButtons.press(.lock) }
      case .web, .remote:
        EmptyView()
      }
      if device.platform != "web" {
        Rectangle().fill(Palette.border).frame(width: 1, height: 16)
        rotateButton(clockwise: false)
        rotateButton(clockwise: true)
      }
      if device.formFactor == .dual, screenIDs.count > 1, SimulatorFold.isAvailable, case .ios(_, let sim) = device {
        foldButton(udid: sim.udid)
      }
      if let emulatorPosture, case .android(_, let avd) = device, let serial = avd.serial {
        postureMenu(serial: serial, current: emulatorPosture)
      }
    }
    .frame(maxWidth: .infinity)
  }

  private func hardwareButton(_ title: String, systemImage: String, action: @escaping () -> Void) -> some View {
    Button(title, systemImage: systemImage, action: action)
      .labelStyle(.iconOnly)
      .buttonStyle(.stim())
      .help("Press the device's \(title) button")
      .accessibilityLabel("Press \(title)")
  }

  @ViewBuilder private var takeOverButton: some View {
    if let onToggleTakeOver,
      !isPhysical || takenOver || PhysicalScreen(device: device, link: server.link, now: Date()).canControl
    {
      if takenOver {
        Button("Release", systemImage: "hand.raised.fill", action: onToggleTakeOver)
          .labelStyle(.iconOnly)
          .buttonStyle(.stim(.primary))
          .fixedSize()
          .help("Release control so an agent can drive this device again.")
          .accessibilityLabel("Release control")
      } else {
        Button("Take over", systemImage: "hand.raised", action: onToggleTakeOver)
          .labelStyle(.iconOnly)
          .buttonStyle(.stim())
          .fixedSize()
          .disabled(replaying)
          .help(
            replaying
              ? "Go live to take over this device."
              : "Take over: send your clicks, trackpad scrolls and keys to this device. If an agent is driving it, taking over may disrupt it."
          )
          .accessibilityLabel("Take over")
      }
    }
  }

  private var isPhysical: Bool { device.isPhysical }

  @ViewBuilder private var screenCover: some View {
    if !showsCovers || interactive {
      EmptyView()
    } else if let build {
      BuildCover(build: build, opaque: !device.isRunning)
    } else if presence == AppPresence.none {
      coverMessage("No app installed", "Fix the build and run it again")
    }
  }

  private func coverMessage(_ title: String, _ subtitle: String) -> some View {
    VStack(spacing: Space.xs) {
      Text(title).font(.stim(.callout)).foregroundStyle(.white.opacity(0.85))
      if !subtitle.isEmpty { Text(subtitle).font(.stim(.caption)).foregroundStyle(.white.opacity(0.55)) }
    }
    .multilineTextAlignment(.center)
    .padding()
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Media.screen.opacity(0.85))
    .allowsHitTesting(false)
  }

  private var showsStoppedBar: Bool {
    if case .remote = device { return false }
    if isPhysical, workspace != nil { return false }
    return !device.isRunning && build == nil && !["Booting", "unknown"].contains(device.state)
  }

  private func stoppedBar(_ run: StimCommand?) -> some View {
    HStack(spacing: Space.md) {
      Text(
        device.platform == "web"
          ? "Closed. Run stim web to open the page again."
          : run.map { "Not running. Run stim \($0.arguments.joined(separator: " ")) to boot it and install the app." }
            ?? (isPhysical ? "Not connected." : "Shut down. Stim does not boot a device it does not own.")
      )
      .font(.stim(.callout))
      .foregroundStyle(Palette.secondary)
      .fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 0)
      if viewer, let run {
        Button("Run") { actions.run(device.platform == "web" ? "Open web" : "Run \(device.slot)", run) }
          .buttonStyle(.stim())
          .fixedSize()
          .disabled(actions.active(for: run.cwd) != nil)
          .help(run.displayLine())
      }
    }
    .padding(Space.lg)
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
    Pill(tone: .warning) { Text("billable") }
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

  @ViewBuilder private func webControls(_ browser: WebBrowser, workspace: String) -> some View {
    let busy = actions.active(for: workspace) != nil
    if let url = URL(string: browser.currentURL), ["http", "https"].contains(url.scheme) {
      Button("Open in browser", systemImage: "safari") { NSWorkspace.shared.open(url) }
        .labelStyle(.iconOnly)
        .buttonStyle(.stim())
        .help("Open \(browser.currentURL) in your default browser. Stim's Chrome and its profile are not involved.")
    }
    if browser.running {
      Button("Reload", systemImage: "arrow.clockwise") {
        actions.run("Reload web", StimCommand(["reload", "web"], cwd: workspace))
      }
      .labelStyle(.iconOnly)
      .buttonStyle(.stim())
      .disabled(busy)
      .help("stim reload web: reloads the page in Stim's Chrome")
      Button("Close") { actions.run("Close web", stopCommand(for: device, cwd: workspace)) }
        .buttonStyle(.stim(.destructive))
        .fixedSize()
        .disabled(busy)
        .help("stim stop --slot web: closes Stim's Chrome and keeps its profile, Metro and every device")
    }
  }

  @ViewBuilder private func activityChip(_ badge: ActivityBadge) -> some View {
    let basis = device.activity.map { "stim status activity: \($0.basis.joined(separator: ", "))" } ?? ""
    switch badge {
    case .driven:
      Pill(tone: .accent) {
        StatusDot(color: Palette.primary)
        Text(namesDriver ? badge.text : "Driven")
      }
      .help([badge.text, basis].joined(separator: "\n"))
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(badge.text)
    case .idle:
      Pill(tone: .neutral) { Text(badge.text) }.help(basis)
    case .unknown:
      Pill(tone: .warning) { Text(badge.text) }.help(basis)
    }
  }

  private func rotateButton(clockwise: Bool) -> some View {
    Button {
      Task {
        switch device {
        case .ios(_, let sim): rotateFailed = !SimulatorRotation.rotate(udid: sim.udid, clockwise: clockwise)
        case .android(_, let avd):
          guard let serial = avd.serial else { return }
          rotateFailed = !(await EmulatorRotation.rotate(serial: serial, clockwise: clockwise))
        case .remote, .web: break
        }
      }
    } label: {
      Image(systemName: clockwise ? "rotate.right" : "rotate.left")
    }
    .buttonStyle(.stim())
    .help(rotateFailed ? "The last rotation did not reach the device." : clockwise ? "Rotate right" : "Rotate left")
    .accessibilityLabel(clockwise ? "Rotate right" : "Rotate left")
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
    let full = fittedHeight - screenPadding * 2
    return screenIDs.count > 1 && screenID != mainScreenID ? full * 0.3 : full
  }

  private func screenWidth(_ screenID: UInt32) -> CGFloat? {
    guard let size = pixelSizes[screenID], size.height > 0 else { return nil }
    return screenHeight(screenID) * size.width / size.height
  }

  private var replayWidth: CGFloat? {
    guard let size = replaySize, size.height > 0 else { return nil }
    return (fittedHeight - screenPadding * 2) * size.width / size.height
  }

  private var width: CGFloat {
    let widths = screenIDs.compactMap(screenWidth)
    if widths.count == screenIDs.count {
      return max(Self.minimumWidth, widths.reduce(0, +) + screenPadding * CGFloat(screenIDs.count + 1))
    }
    if case .remote = device { return max(360, fittedHeight * 0.6) }
    switch device.formFactor {
    case .phone: return max(Self.minimumWidth, fittedHeight * 0.52)
    case .tablet: return fittedHeight * 0.78
    case .dual: return fittedHeight * 1.4
    case .desktop: return fittedHeight * 1.6
    }
  }

  private var fittedHeight: CGFloat {
    guard let maxWidth else { return screenHeight }
    if replaying, let size = replaySize, size.width > 0, size.height > 0 {
      return min(screenHeight, (maxWidth - screenPadding * 2) * size.height / size.width + screenPadding * 2)
    }
    let ratios = screenIDs.compactMap { screenID -> CGFloat? in
      guard let size = pixelSizes[screenID], size.height > 0 else { return nil }
      return size.width / size.height * (screenIDs.count > 1 && screenID != mainScreenID ? 0.3 : 1)
    }
    if ratios.count == screenIDs.count, !ratios.isEmpty {
      let room = maxWidth - screenPadding * CGFloat(screenIDs.count + 1)
      return min(screenHeight, room / ratios.reduce(0, +) + screenPadding * 2)
    }
    if case .remote = device { return min(screenHeight, maxWidth / 0.6) }
    switch device.formFactor {
    case .phone: return min(screenHeight, maxWidth / 0.52)
    case .tablet: return min(screenHeight, maxWidth / 0.78)
    case .dual: return min(screenHeight, maxWidth / 1.4)
    case .desktop: return min(screenHeight, maxWidth / 1.6)
    }
  }

  private var source: String {
    switch device {
    case .ios(_, let d): return d.physical ? "iOS device" : "iOS Simulator"
    case .android(_, let d): return d.physical ? "Android device" : "Android Emulator"
    case .remote(let d): return d.backend == "eas" ? "EAS Simulator" : "Remote device"
    case .web(let d): return d.headless ? "Chrome, headless" : "Chrome"
    }
  }

  @ViewBuilder private var screen: some View {
    switch device {
    case .ios(_, let sim) where device.isRunning && !sim.physical:
      HStack(alignment: .bottom, spacing: screenPadding) {
        ForEach(screenIDs, id: \.self) { screenID in
          SimulatorDisplayView(
            udid: sim.udid, screenID: screenID, interactive: interactive,
            onPixelSizeChange: { pixelSizes[screenID] = $0 },
            onLitChange: screenIDs.count > 1 ? { lit[screenID] = $0 } : nil,
            buttons: screenID == mainScreenID ? simulatorButtons : nil
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
        EmulatorScreen(serial: serial, interactive: interactive, buttons: emulatorButtons) { pixelSizes[1] = $0 }
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
    case .web(let browser) where browser.running:
      if let endpoint = browser.cdpEndpoint.flatMap(URL.init(string:)), let pid = browser.pid, let target = browser.targetId {
        WebScreen(endpoint: endpoint, chromePid: Int32(pid), targetId: target, interactive: interactive) {
          pixelSizes[1] = $0
        }
        .frame(width: screenWidth(1))
        .padding(screenPadding)
      } else {
        placeholder("Chrome runs, but stim status reports no page to show yet.")
      }
    case .remote(let remote):
      if let url = remote.webPreviewUrl.flatMap(URL.init(string:)), ["http", "https"].contains(url.scheme) {
        RemotePreview(url: url).padding(screenPadding)
      } else {
        placeholder("No preview URL was recorded for session \(remote.sessionId).")
      }
    default:
      if isPhysical, let workspace {
        PhysicalDeviceScreen(
          device: device, workspace: workspace, interactive: interactive,
          onPixelSizeChange: { pixelSizes[1] = $0 },
          onControlLost: { if takenOver { onToggleTakeOver?() } }
        )
        .id(device.id)
        .frame(width: screenWidth(1))
        .padding(screenPadding)
      } else {
        placeholder(device.state)
      }
    }
  }

  private func placeholder(_ text: String) -> some View {
    ScreenMessage(text: text)
  }
}

extension DeviceRef {
  var isInteractive: Bool {
    switch self {
    case .ios(_, let sim): return isRunning && !sim.physical
    case .android(_, let avd): return isRunning && (avd.owned || avd.physical) && avd.serial != nil
    case .web(let browser): return browser.running && browser.cdpEndpoint != nil && browser.targetId != nil
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
    view.underPageBackgroundColor = NSColor(Media.screen)
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
  var buttons: EmulatorButtons
  var onPixelSizeChange: (CGSize) -> Void
  @State private var status = EmulatorStreamStatus.connecting

  var body: some View {
    EmulatorDisplayView(
      serial: serial, interactive: interactive,
      onStatus: { status in DispatchQueue.main.async { self.status = status } },
      onPixelSizeChange: { size in DispatchQueue.main.async { onPixelSizeChange(size) } }, buttons: buttons
    )
    .overlay {
      switch status {
      case .connecting: ScreenMessage(text: "Connecting to the emulator")
      case .noEndpoint: ScreenMessage(text: "This emulator has no gRPC endpoint. Frames appear after Stim next boots it.")
      case .streaming: EmptyView()
      }
    }
  }
}

private struct WebScreen: View {
  var endpoint: URL
  var chromePid: Int32
  var targetId: String
  var interactive: Bool
  var onPixelSizeChange: (CGSize) -> Void
  @State private var status = WebStreamStatus.connecting

  var body: some View {
    WebDisplayView(
      endpoint: endpoint, chromePid: chromePid, targetId: targetId, interactive: interactive,
      onStatus: { status in DispatchQueue.main.async { self.status = status } },
      onPixelSizeChange: { size in DispatchQueue.main.async { onPixelSizeChange(size) } }
    )
    .overlay {
      switch status {
      case .connecting: ScreenMessage(text: "Connecting to Chrome")
      case .refused(let reason): ScreenMessage(text: reason)
      case .streaming: EmptyView()
      }
    }
  }
}

/// Covers a device's screen while its build runs: the phase, a thin bar and elapsed over the estimate.
private struct BuildCover: View {
  var build: Build
  var opaque: Bool

  var body: some View {
    TimelineView(.periodic(from: .now, by: 1)) { context in
      let progress = build.progress(at: context.date)
      let (phase, counts) = build.currentPhaseLabel
      let estimate = build.expectedMs.map { " / ~\(clockDuration(ms: $0))" } ?? ""
      VStack(spacing: Space.sm) {
        Text("Waiting for the \(platformName(build.platform)) build").font(.stim(.callout)).foregroundStyle(.white.opacity(0.85))
        Text([phase, counts].compactMap { $0 }.joined(separator: " \u{00B7} "))
          .font(.stim(.caption))
          .foregroundStyle(.white.opacity(0.6))
          .lineLimit(1)
        Group {
          if let fraction = progress.fraction {
            ProgressView(value: fraction)
          } else {
            ProgressView().progressViewStyle(.linear)
          }
        }
        .tint(Palette.accent)
        .controlSize(.small)
        .frame(maxWidth: 160)
        Text(clockDuration(ms: progress.elapsedMs) + estimate)
          .font(.stim(.caption))
          .monospacedDigit()
          .foregroundStyle(.white.opacity(0.6))
      }
      .multilineTextAlignment(.center)
      .padding()
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(Media.screen.opacity(opaque ? 1 : 0.85))
      .accessibilityElement(children: .combine)
    }
    .allowsHitTesting(false)
  }
}

private struct ScreenMessage: View {
  var text: String

  var body: some View {
    Text(text)
      .font(.stim(.callout))
      .foregroundStyle(Palette.tertiary)
      .multilineTextAlignment(.center)
      .padding()
      .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

/// Where a tile draws its activity chip, so the canvas can put a button over it that opens the agent actions.
struct ActivityChipAnchor: PreferenceKey {
  static let defaultValue: Anchor<CGRect>? = nil

  static func reduce(value: inout Anchor<CGRect>?, nextValue: () -> Anchor<CGRect>?) {
    value = value ?? nextValue()
  }
}

private struct DeviceAgentRow: View {
  var device: DeviceRef
  var actions: [AgentAction]
  var showAll: () -> Void
  @State private var shown = false
  @State private var hovering = false

  var body: some View {
    Button {
      shown = true
    } label: {
      TimelineView(.periodic(from: .now, by: 15)) { context in
        let latest = actions.first.map { (date: $0.record.date, message: $0.record.msg) }
        let row = AgentRow(activity: device.activity, last: latest, now: context.date)
        HStack(spacing: Space.md) {
          Text(row.tool ?? "No agent")
            .font(.stim(.footnote, weight: .semibold))
            .foregroundStyle(row.tool == nil ? Palette.tertiary : Palette.primary)
          Text(row.text).font(.stim(.footnote)).foregroundStyle(Palette.secondary).lineLimit(1)
          Spacer(minLength: Space.sm)
          Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).foregroundStyle(Palette.tertiary)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(row.tool ?? "No agent"), \(row.text)")
      }
      .padding(.horizontal, Space.lg)
      .padding(.vertical, Space.md)
      .background(hovering ? Palette.raised : .clear)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
    .help("stim logs --source agent: what an agent did on this device. Click for the recent actions.")
    .popover(isPresented: $shown, arrowEdge: .bottom) {
      AgentActionsList(actions: actions, driver: device.activity?.driver?.tool) {
        shown = false
        showAll()
      }
      .padding(Space.lg)
      .frame(width: 380, alignment: .leading)
    }
  }
}
