import EmulatorFrames
import SimulatorFrames
import StimKit
import StimStores
import SwiftUI
import WebFrames
import WebKit

struct DeviceTile: View {
  var device: DeviceRef
  var hostedPreview: PhysicalScreen? = nil
  var screenHeight: CGFloat
  var interactive = false
  var workspace: String?
  var project: String? = nil
  var build: Build? = nil
  /// The device's replay through stim-server, where the tile offers one.
  var replay: ReplayController? = nil
  /// Whether `replay` shows recorded footage instead of the live screen.
  var replaying = false
  var usage: WorkspaceUsage? = nil
  var presence: AppPresence? = nil
  var showsCovers = false
  var focused = false
  var viewerAction: String? = nil
  /// The device viewer's canvas: only the screen, with the device's buttons below it, and Run on a stopped device.
  /// A tile without it is a preview card with no controls.
  var viewer = false
  /// The card's maximum width, or the viewer's screen width limit; the screen shrinks below `screenHeight` to fit.
  var maxWidth: CGFloat? = nil
  var maxCardHeight: CGFloat? = nil
  /// False while the device's viewer is open, so the tile does not stream a second copy of its screen.
  var showsScreen = true
  var pausesWhenOffscreen = false
  var pixelScale: CGFloat? = nil
  var framePixelsPerUnit: CGFloat = 1
  /// A physical device's stream stopped taking input.
  var onControlLost: () -> Void = {}
  var onInput: (() -> Void)?
  @State private var isOnscreen = false
  @State private var pixelSizes: [UInt32: CGSize] = [:]
  @State private var frameSizes: [UInt32: CGSize] = [:]
  @State private var showsDeviceFrame = false
  @State private var screenIDs: [UInt32] = [1]
  @State private var lit: [UInt32: Bool] = [:]
  @State private var folding = false
  @State private var hingeAvailable = false
  @State private var observedHingeAngle: Double?
  @State private var hingeEditing = false
  @State private var showsHingeAngle = false
  @State private var showsSimulatorOptions = false
  @State private var hingeAngle = 180.0
  @State private var postureTarget: DuoPosture?
  @State private var rotateFailed = false
  @State private var clipboardRequest: ClipboardRequest?
  @State private var clipboardError: String?
  @State private var foldError: String?
  @State private var emulatorPosture: EmulatorPosture?
  @State private var postureFailed = false
  @State private var replaySize: CGSize?
  @State private var headerHeight: CGFloat = 0
  @State private var controlsHeight: CGFloat = 44
  @State private var simulatorButtons = SimulatorButtons()
  @State private var duoFrame = SimulatorDuoFrame()
  @State private var emulatorButtons = EmulatorButtons()
  @EnvironmentObject private var actions: ActionCenter

  private var screenPadding: CGFloat {
    let height = min(screenHeight, maxCardHeight.map { max(0, $0 - headerHeight - 1) } ?? screenHeight)
    let small = height <= TileSize.small.screenHeight || maxWidth.map { $0 <= Self.minimumWidth } == true
    if framed { return 0 }
    return !viewer && small ? Space.sm : Space.lg
  }
  static let minimumWidth: CGFloat = 240
  static let stoppedMaximumWidth: CGFloat = 420

  var body: some View {
    Group {
      if viewer { canvas } else { card }
    }
    .onAppear { isOnscreen = true }
    .onDisappear { isOnscreen = false }
    .onChange(of: device.id) { _, _ in
      frameSizes = [:]
      showsDeviceFrame = false
    }
  }

  private var canvas: some View {
    VStack(spacing: Space.lg) {
      if let workspace, showsStoppedBar, !replaying {
        Card(clipsContent: false) {
          stoppedBar(runCommand(for: device, cwd: workspace))
            .frame(maxWidth: 420)
        }
      } else {
        Group {
          if replaying, let replay {
            ReplayScreen(controller: replay) { replaySize = $0 }
              .frame(width: replayWidth)
              .padding(screenPadding)
              .frame(height: fittedHeight)
          } else {
            screen
              .frame(width: width, height: fittedHeight)
              .overlay { screenCover }
          }
        }
        .background(framed ? Color.clear : Media.screen)
        .clipShape(RoundedRectangle(cornerRadius: framed ? 0 : Radius.card))
        .overlay {
          if !framed { RoundedRectangle(cornerRadius: Radius.card).strokeBorder(frameColor, lineWidth: frameWidth) }
        }
        if interactive, Self.hasButtons(device) {
          buttonBar
        } else if canShowFrame {
          controlGroup { frameButton }
            .onGeometryChange(for: CGFloat.self, of: { $0.size.height }, action: { controlsHeight = $0 })
        }
      }
    }
    .task(id: dualSimulatorUDID) {
      hingeAvailable = false
      guard let udid = dualSimulatorUDID else { return }
      while !Task.isCancelled {
        let available = await SimulatorPosture.isAvailableBounded(udid: udid)
        guard !Task.isCancelled else { return }
        hingeAvailable = available
        if hingeAvailable { return }
        try? await Task.sleep(for: .seconds(10))
      }
    }
    .task(id: hingeAvailable ? dualSimulatorUDID : nil) {
      observedHingeAngle = nil
      guard hingeAvailable, let udid = dualSimulatorUDID else { return }
      while !Task.isCancelled {
        let started = ContinuousClock.now
        var received = false
        for await angle in SimulatorHingeAngle.angles(udid: udid) {
          observedHingeAngle = angle
          received = true
        }
        guard !Task.isCancelled, received else {
          observedHingeAngle = nil
          return
        }
        try? await Task.sleep(for: max(.zero, .seconds(60) - started.duration(to: .now)))
      }
    }
    .onChange(of: observedHingeAngle) { _, angle in
      if !hingeEditing, let angle { hingeAngle = angle }
    }
    .onChange(of: simulatorOptionsUDID) { _, _ in showsSimulatorOptions = false }
    .onChange(of: clipboardTarget) { _, _ in
      clipboardRequest = nil
      clipboardError = nil
    }
    .task(id: clipboardRequest) {
      guard let request = clipboardRequest, request.target == clipboardTarget else { return }
      defer { if clipboardRequest == request { clipboardRequest = nil } }
      if let text = request.text {
        let pasted: Bool
        switch device {
        case .ios: pasted = await simulatorButtons.paste(text)
        case .android: pasted = await emulatorButtons.paste(text)
        default: return
        }
        guard !Task.isCancelled, request.target == clipboardTarget else { return }
        if !pasted { clipboardError = "Could not paste into the device. Check that it is connected and a text field is focused." }
      } else {
        let text: String?
        switch device {
        case .ios: text = await simulatorButtons.clipboard()
        case .android: text = await emulatorButtons.clipboard()
        default: return
        }
        guard !Task.isCancelled, request.target == clipboardTarget else { return }
        guard let text else {
          clipboardError = "Could not read the device clipboard. Check that the device is connected."
          return
        }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
      }
    }
    .alert("Clipboard transfer", isPresented: Binding(get: { clipboardError != nil }, set: { if !$0 { clipboardError = nil } })) {
      Button("OK", role: .cancel) { clipboardError = nil }
    } message: {
      Text(clipboardError ?? "")
    }
  }

  private var frameColor: Color {
    if case .remote = device { return Palette.info }
    return interactive ? Palette.accent : Palette.border
  }

  private var frameWidth: CGFloat {
    if case .remote = device { return 2 }
    return interactive ? 2 : 1
  }

  /// Whether the viewer offers hardware controls below the device's screen.
  static func hasButtons(_ device: DeviceRef) -> Bool {
    switch device {
    case .ios: return device.isRunning && device.localSimulatorUDID != nil
    case .android: return device.isRunning && !device.isPhysical && device.hostedMachine == nil
    case .web, .remote: return false
    }
  }

  private var card: some View {
    Card {
      VStack(spacing: 0) {
        header
          .padding(.horizontal, Space.lg)
          .padding(.vertical, Space.md)
          .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { headerHeight = $0 }
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
        } else if pausesWhenOffscreen && !isOnscreen {
          Media.screen.frame(height: fittedHeight)
        } else {
          screen
            .frame(height: fittedHeight)
            .background(Media.screen)
            .overlay { screenCover }
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
    .frame(
      width: showsStoppedBar ? min(maxWidth ?? Self.stoppedMaximumWidth, Self.stoppedMaximumWidth) : min(maxWidth ?? width, width)
    )
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: Space.sm) {
      HStack(spacing: Space.md) {
        StatusDot(
          color: device.isRunning ? Palette.success : Palette.tertiary, filled: device.isRunning,
          label: "State: \(device.state)"
        )
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
        .help(identity)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(identity)
        .lineLimit(1)
        .layoutPriority(1)
        Spacer(minLength: 8)
        if let viewerAction {
          Label(viewerAction, systemImage: viewerAction == "Control" ? "cursorarrow.rays" : "arrow.up.right")
            .font(.stim(.callout, weight: .semibold))
            .foregroundStyle(Palette.primary)
            .accessibilityHidden(true)
        }
        if case .remote = device {
          Pill(tone: .warning) { Text("billable") }
            .help("This remote session is billed while it runs.")
        }
      }
      if let machine = device.hostedMachine {
        Label("on \(machineName(machine))", systemImage: "desktopcomputer")
          .font(.stim(.caption)).foregroundStyle(Palette.tertiary)
      }
      if let project { Text(project).font(.stim(.footnote)).foregroundStyle(Palette.secondary) }
      FlowLayout(spacing: Space.sm) {
        TimelineView(.periodic(from: .now, by: 30)) { context in
          if let badge = ActivityBadge(
            device.activity, screenChangedAt: device.activityKey.flatMap(ScreenActivity.shared.lastChange),
            now: context.date), badge.driverTool == nil
          {
            activityChip(badge)
          }
        }
        if device.appStopped {
          if presence != AppPresence.none {
            Pill(tone: .warning) { Text("App not running") }
              .help("stim status sees no \(device.app?.id ?? "app") process on this device.")
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
              Pill("Leased \u{00B7} \(Format.duration(expires.timeIntervalSince(context.date))) left")
                .help("This workspace's lease ends at \(expires.formatted(date: .omitted, time: .shortened)).")
            }
          }
        }
        if let usage, !usage.isEmpty {
          HStack(spacing: Space.md) { UsageFigures(usage: usage) }
            .font(.stim(.caption))
            .accessibilityElement(children: .combine)
        }
        if let posture = duoPosture?.label ?? emulatorPosture?.label {
          Pill { Text(posture) }.help("Current posture")
        }
      }
    }
  }

  private var canShowFrame: Bool { viewer && !replaying && frameSizes[1] != nil }
  private var framed: Bool { canShowFrame && showsDeviceFrame }

  private var frameButton: some View {
    Button(showsDeviceFrame ? "Hide device frame" : "Show device frame", systemImage: "iphone.gen3") {
      showsDeviceFrame.toggle()
    }
    .labelStyle(.iconOnly)
    .buttonStyle(DeviceControlButtonStyle(active: showsDeviceFrame))
    .help(showsDeviceFrame ? "Hide device frame" : "Show installed device frame")
    .accessibilityAddTraits(showsDeviceFrame ? .isSelected : [])
  }

  private var buttonBar: some View {
    FlowLayout(spacing: Space.sm, lineSpacing: Space.sm, centered: true) {
      controlGroup {
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
      }
      controlGroup {
        rotateButton(clockwise: false)
        rotateButton(clockwise: true)
      }
      if canShowFrame { controlGroup { frameButton } }
      if let target = clipboardTarget {
        controlGroup {
          Button("Paste into device", systemImage: "doc.on.clipboard") {
            guard let text = NSPasteboard.general.string(forType: .string), !text.isEmpty else {
              clipboardError = "The Mac clipboard has no text to paste."
              return
            }
            clipboardRequest = ClipboardRequest(target: target, text: text)
          }
          .labelStyle(.iconOnly)
          .buttonStyle(DeviceControlButtonStyle())
          .help("Paste Mac clipboard text into the focused device field")
          Button("Copy device clipboard", systemImage: "doc.on.doc") {
            clipboardRequest = ClipboardRequest(target: target, text: nil)
          }
          .labelStyle(.iconOnly)
          .buttonStyle(DeviceControlButtonStyle())
          .help("Copy device clipboard text to this Mac")
        }
        .disabled(clipboardRequest != nil)
      }
      if device.formFactor == .dual, screenIDs.count > 1, case .ios(_, let sim) = device, device.localSimulatorUDID != nil {
        if hingeAvailable {
          controlGroup {
            ForEach(DuoPosture.allCases, id: \.self) { postureButton($0, udid: sim.udid) }
            hingeAngleControl(udid: sim.udid)
          }
        } else if SimulatorFold.isAvailable {
          controlGroup { foldButton(udid: sim.udid) }
        }
      }
      if let emulatorPosture, case .android = device, let serial = device.localEmulatorSerial {
        controlGroup { postureMenu(serial: serial, current: emulatorPosture) }
      }
      if let udid = simulatorOptionsUDID {
        controlGroup {
          Button("Simulator options", systemImage: "slider.horizontal.3") { showsSimulatorOptions = true }
            .labelStyle(.iconOnly)
            .buttonStyle(DeviceControlButtonStyle())
            .help("Appearance and accessibility settings for this simulator")
            .popover(isPresented: $showsSimulatorOptions) {
              SimulatorOptionsView(udid: udid, canControl: simulatorOptionsUDID == udid)
                .id(udid)
            }
        }
      }
    }
    .frame(width: maxWidth)
    .onGeometryChange(for: CGFloat.self, of: { $0.size.height }, action: { controlsHeight = $0 })
  }

  @ViewBuilder private func controlGroup<Content: View>(@ViewBuilder content: () -> Content) -> some View {
    let group = HStack(spacing: Space.xxs, content: content).padding(Space.xs)
    #if compiler(>=6.2)
      if #available(macOS 26, *) {
        group.glassEffect(.regular, in: Capsule())
      } else {
        group.background(Palette.surface, in: Capsule()).overlay(Capsule().strokeBorder(Palette.border))
      }
    #else
      group.background(Palette.surface, in: Capsule()).overlay(Capsule().strokeBorder(Palette.border))
    #endif
  }

  private func hardwareButton(_ title: String, systemImage: String, action: @escaping () -> Void) -> some View {
    Button(title, systemImage: systemImage, action: action)
      .labelStyle(.iconOnly)
      .buttonStyle(DeviceControlButtonStyle())
      .disabled(!interactive)
      .help(interactive ? "Press the device's \(title) button" : "Take over the device to press its \(title) button")
      .accessibilityLabel("Press \(title)")
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

  var showsStoppedBar: Bool {
    if case .remote = device { return false }
    if isPhysical || device.hostedMachine != nil, workspace != nil { return false }
    return !device.isRunning && build == nil && !["Booting", "unknown"].contains(device.state)
  }

  private func stoppedBar(_ run: StimCommand?) -> some View {
    HStack(spacing: Space.md) {
      Text(
        viewer
          ? (device.platform == "web"
            ? "Closed. Run stim web to open the page again."
            : run.map { "Not running. Run stim \($0.arguments.joined(separator: " ")) to boot it and install the app." }
              ?? (isPhysical ? "Not connected." : "Shut down. Stim does not boot a device it does not own."))
          : (device.platform == "web" ? "Closed." : run == nil ? "Shut down. Not owned by Stim." : "Shut down.")
      )
      .font(.stim(.callout))
      .foregroundStyle(Palette.secondary)
      .fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 0)
      if let run {
        Button(viewer ? "Run" : device.platform == "web" ? "Open" : "Boot") {
          actions.run(
            device.platform == "web" ? "Open web" : "Run \(device.slot)", steps: [run],
            present: !viewer && device.platform == "web")
        }
        .buttonStyle(.stim())
        .fixedSize()
        .disabled(actions.active(for: run.cwd) != nil)
        .help(run.displayLine())
      }
    }
    .frame(minHeight: viewer ? nil : 24)
    .padding(Space.lg)
  }

  @ViewBuilder private func activityChip(_ badge: ActivityBadge) -> some View {
    let basis = device.activity.map { "stim status activity: \($0.basis.joined(separator: ", "))" } ?? ""
    switch badge {
    case .driven:
      EmptyView()
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
        case .ios(_, let sim):
          rotateFailed = !(await SimulatorRotation.rotateBounded(udid: sim.udid, clockwise: clockwise))
        case .android:
          guard let serial = device.localEmulatorSerial else { return }
          rotateFailed = !(await EmulatorRotation.rotate(serial: serial, clockwise: clockwise))
        case .remote, .web: break
        }
      }
    } label: {
      Image(systemName: clockwise ? "rotate.right" : "rotate.left")
    }
    .buttonStyle(DeviceControlButtonStyle())
    .help(rotateFailed ? "The last rotation did not reach the device." : clockwise ? "Rotate right" : "Rotate left")
    .accessibilityLabel(clockwise ? "Rotate right" : "Rotate left")
  }

  private func foldButton(udid: String) -> some View {
    let action = posture == "Folded" ? "Unfold" : posture == "Unfolded" ? "Fold" : "Fold / Unfold"
    let title = folding ? "Folding" : foldError == nil ? action : "\(action) failed, retry"
    return Button(title, systemImage: foldError == nil ? "rectangle.split.2x1" : "exclamationmark.triangle") {
      folding = true
      Task {
        foldError = await SimulatorFold.toggle(udid: udid)
        folding = false
      }
    }
    .labelStyle(.iconOnly)
    .buttonStyle(DeviceControlButtonStyle())
    .disabled(folding)
    .help(
      foldError.map { "\(title): \($0)" } ?? "\(title): sweeps the hinge to the other posture, which lights the other screen.")
  }

  private func postureButton(_ target: DuoPosture, udid: String) -> some View {
    let selected = duoPosture == target
    let failed = foldError != nil && postureTarget == target
    return Button(target.label, systemImage: failed ? "exclamationmark.triangle" : target.systemImage) {
      guard !selected else { return }
      duoFrame.preparePostureChange()
      folding = true
      postureTarget = target
      foldError = nil
      Task {
        let from = currentHingeAngle
        foldError = await SimulatorPosture.moveBounded(udid: udid, from: from, to: target.hingeAngle)
        if foldError == nil {
          hingeAngle = target.hingeAngle
          try? await Task.sleep(for: .seconds(3))
          if let posture, (posture == "Folded") != target.isFolded {
            foldError = "The hinge moved, but the simulator did not switch screens."
          }
        }
        folding = false
      }
    }
    .labelStyle(.iconOnly)
    .buttonStyle(DeviceControlButtonStyle(active: selected))
    .disabled(folding)
    .help(
      failed
        ? "\(target.label) failed: \(foldError ?? "")"
        : "\(target.label): moves the simulated hinge to \(Int(target.hingeAngle)) degrees."
    )
    .accessibilityLabel(failed ? "\(target.label) failed, retry" : target.label)
    .accessibilityAddTraits(selected ? .isSelected : [])
  }

  private func hingeAngleControl(udid: String) -> some View {
    Button("Hinge angle", systemImage: "angle") {
      hingeEditing = false
      hingeAngle = currentHingeAngle
      showsHingeAngle = true
    }
    .labelStyle(.iconOnly)
    .buttonStyle(DeviceControlButtonStyle())
    .help("Set the simulated hinge angle")
    .popover(isPresented: $showsHingeAngle) {
      VStack(alignment: .leading, spacing: Space.md) {
        Text("Hinge angle: \(Int(hingeAngle))\u{00B0}").monospacedDigit()
        Slider(value: $hingeAngle, in: 0...180, step: 1) { editing in
          hingeEditing = editing
          guard !editing else { return }
          let target = hingeAngle
          let from = currentHingeAngle
          guard target != from else { return }
          duoFrame.preparePostureChange()
          folding = true
          postureTarget = nil
          foldError = nil
          Task {
            foldError = await SimulatorPosture.moveBounded(udid: udid, from: from, to: target)
            folding = false
          }
        }
        .disabled(folding)
        .accessibilityLabel("Hinge angle")
        .accessibilityValue("\(Int(hingeAngle)) degrees")
        if let foldError { Text(foldError).foregroundStyle(Palette.warning) }
      }
      .frame(width: 220)
      .padding(Space.lg)
    }
  }

  private var dualSimulatorUDID: String? {
    guard viewer, !replaying, device.isRunning, !device.isPhysical, device.formFactor == .dual,
      screenIDs.count > 1, device.localSimulatorUDID != nil
    else { return nil }
    return device.localSimulatorUDID
  }

  private var clipboardTarget: String? {
    guard viewer, interactive, !replaying, device.isRunning else { return nil }
    switch device {
    case .ios(_, let sim) where sim.owned: return device.localSimulatorUDID
    case .android(_, let avd) where avd.owned && !avd.physical && avd.host == nil: return device.localEmulatorSerial
    default: return nil
    }
  }

  private var simulatorOptionsUDID: String? {
    guard viewer, interactive, !replaying, device.isRunning, case .ios = device, device.localSimulatorUDID != nil else {
      return nil
    }
    return device.localSimulatorUDID
  }

  private var currentHingeAngle: Double {
    if let observedHingeAngle { return observedHingeAngle }
    guard let udid = device.localSimulatorUDID else { return 180 }
    return SimulatorPosture.estimatedAngle(udid: udid, folded: posture.map { $0 == "Folded" })
  }

  private var duoPosture: DuoPosture? {
    guard let posture, case .ios = device else { return nil }
    if let observedHingeAngle {
      return DuoPosture.allCases.first { $0.hingeAngle == observedHingeAngle.rounded() }
    }
    let preset = DuoPosture.allCases.first { $0.hingeAngle == currentHingeAngle }
    return preset?.isFolded == (posture == "Folded") ? preset : nil
  }

  private func postureMenu(serial: String, current: EmulatorPosture) -> some View {
    Menu {
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
    } label: {
      Image(systemName: postureFailed ? "exclamationmark.triangle" : "rectangle.split.2x1")
    }
    .menuStyle(.button)
    .menuIndicator(.hidden)
    .buttonStyle(DeviceControlButtonStyle())
    .fixedSize()
    .help(postureFailed ? "The last posture change did not reach the emulator." : "Posture: moves the emulator's hinge.")
    .accessibilityLabel(postureFailed ? "Posture failed, retry" : "Posture")
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

  private var displayedScreenIDs: [UInt32] {
    if framed, device.formFactor == .dual, let mainScreenID { return [mainScreenID] }
    let litIDs = screenIDs.filter { lit[$0] == true }
    return litIDs.count == 1 ? litIDs : screenIDs
  }

  private func screenHeight(_ screenID: UInt32) -> CGFloat {
    if let size = accurateSize(screenID) { return size.height }
    let full = fittedHeight - screenPadding * 2
    return displayedScreenIDs.count > 1 && screenID != mainScreenID ? full * 0.3 : full
  }

  private func layoutSize(_ screenID: UInt32) -> CGSize? {
    framed ? frameSizes[screenID] ?? pixelSizes[screenID] : pixelSizes[screenID]
  }

  private func screenWidth(_ screenID: UInt32) -> CGFloat? {
    if let size = accurateSize(screenID) { return size.width }
    guard let size = layoutSize(screenID), size.height > 0 else { return nil }
    return screenHeight(screenID) * size.width / size.height
  }

  private var replayWidth: CGFloat? {
    guard let size = replaySize, size.height > 0 else { return nil }
    return (fittedHeight - screenPadding * 2) * size.width / size.height
  }

  private var width: CGFloat {
    let widths = displayedScreenIDs.compactMap(screenWidth)
    if widths.count == displayedScreenIDs.count {
      return max(Self.minimumWidth, widths.reduce(0, +) + screenPadding * CGFloat(displayedScreenIDs.count + 1))
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
    if let height = displayedScreenIDs.compactMap({ accurateSize($0)?.height }).max() {
      return height + screenPadding * 2
    }
    let availableHeight =
      screenHeight - (viewer && (interactive && Self.hasButtons(device) || canShowFrame) ? controlsHeight + Space.lg : 0)
    let screenHeight = min(availableHeight, maxCardHeight.map { max(0, $0 - headerHeight - 1) } ?? availableHeight)
    guard let maxWidth else { return screenHeight }
    if replaying, let size = replaySize, size.width > 0, size.height > 0 {
      return min(screenHeight, (maxWidth - screenPadding * 2) * size.height / size.width + screenPadding * 2)
    }
    let ratios = displayedScreenIDs.compactMap { screenID -> CGFloat? in
      guard let size = layoutSize(screenID), size.height > 0 else { return nil }
      return size.width / size.height * (displayedScreenIDs.count > 1 && screenID != mainScreenID ? 0.3 : 1)
    }
    if ratios.count == displayedScreenIDs.count, !ratios.isEmpty {
      let room = maxWidth - screenPadding * CGFloat(displayedScreenIDs.count + 1)
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

  private func accurateSize(_ screenID: UInt32) -> CGSize? {
    guard viewer, !replaying, let pixelScale, let size = layoutSize(screenID) else { return nil }
    let scale = pixelScale * (framed ? framePixelsPerUnit : 1)
    return CGSize(width: size.width * scale, height: size.height * scale)
  }

  private func accurateScreenSize(_ screenID: UInt32) -> CGSize? {
    guard let pixelScale, let size = pixelSizes[screenID] else { return nil }
    return CGSize(width: size.width * pixelScale, height: size.height * pixelScale)
  }

  private var identity: String {
    var parts = [[device.label, device.detail].compactMap { $0 }.joined(separator: " "), source]
    if let tool = ActivityBadge(device.activity)?.driverTool { parts.append("Driven by \(tool)") }
    return parts.joined(separator: ", ")
  }

  @ViewBuilder private var screen: some View {
    switch device {
    case _ where device.hostedMachine != nil:
      if let hostedPreview {
        switch hostedPreview {
        case .message(let text, let remedy): PhysicalMessage(text: text, remedy: remedy)
        case .stream: placeholder("Connecting to the hosted device")
        }
      } else if let workspace {
        PhysicalDeviceScreen(
          device: device, workspace: workspace, interactive: interactive,
          onPixelSizeChange: { pixelSizes[1] = $0 }, onControlLost: onControlLost
        )
        .id(device.id)
        .frame(width: screenWidth(1))
        .padding(screenPadding)
      } else {
        placeholder("A workspace is required to view this hosted device.")
      }
    case .ios(_, let sim) where device.isRunning && device.localSimulatorUDID != nil:
      HStack(alignment: .bottom, spacing: displayedScreenIDs.count > 1 ? screenPadding : 0) {
        ForEach(screenIDs, id: \.self) { screenID in
          SimulatorDisplayView(
            udid: sim.udid, screenID: screenID, interactive: interactive && displayedScreenIDs.contains(screenID),
            onPixelSizeChange: { pixelSizes[screenID] = $0 },
            onLitChange: screenIDs.count > 1 ? { lit[screenID] = $0 } : nil,
            buttons: screenID == mainScreenID ? simulatorButtons : nil,
            hingeAngle: viewer && device.formFactor == .dual && posture == "Unfolded" && screenID == mainScreenID
              ? observedHingeAngle : nil,
            showsDeviceFrame: viewer && showsDeviceFrame, onFrameSizeChange: viewer ? { frameSizes[screenID] = $0 } : nil,
            duoFrame: viewer && device.formFactor == .dual ? duoFrame : nil, activeScreenID: mainScreenID,
            duoHingeAngle: observedHingeAngle, artworkScale: pixelScale.map { $0 * framePixelsPerUnit },
            accurateScreenSize: accurateScreenSize(screenID), onInput: onInput
          )
          .frame(
            width: displayedScreenIDs.contains(screenID) ? screenWidth(screenID) : 0,
            height: displayedScreenIDs.contains(screenID) ? screenHeight(screenID) : 0
          )
          .opacity(displayedScreenIDs.contains(screenID) ? 1 : 0)
          .accessibilityHidden(!displayedScreenIDs.contains(screenID))
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
    case .android(_, let avd) where device.isRunning && avd.owned && !avd.physical && avd.host == nil:
      if let serial = device.localEmulatorSerial {
        EmulatorScreen(
          serial: serial, interactive: interactive, buttons: emulatorButtons, avdName: avd.name,
          fullResolution: pixelScale != nil,
          artworkScale: pixelScale,
          accurateScreenSize: accurateScreenSize(1),
          showsDeviceFrame: viewer && showsDeviceFrame, onFrameSizeChange: viewer ? { frameSizes[1] = $0 } : nil
        ) { pixelSizes[1] = $0 }
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
          onControlLost: onControlLost
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

private struct DeviceControlButtonStyle: ButtonStyle {
  var active = false
  @Environment(\.isEnabled) private var isEnabled

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .iconFont(IconSize.medium, weight: .regular)
      .foregroundStyle(Palette.text)
      .frame(width: 32, height: 32)
      .background(Palette.text.opacity(active ? Opacity.pressed : 0), in: Capsule())
      .hoverHighlight(radius: Radius.round)
      .opacity(isEnabled ? (configuration.isPressed ? 0.7 : 1) : Opacity.disabled)
  }
}

extension DeviceRef {
  var isInteractive: Bool {
    switch self {
    case .ios(_, let sim):
      return !sim.physical && (hostedIos != nil ? state != "stopped" : isRunning && localSimulatorUDID != nil)
    case .android(_, let avd):
      return hostedMachine != nil ? state != "stopped" : isRunning && (avd.owned || avd.physical) && localEmulatorSerial != nil
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
  var avdName: String
  var fullResolution: Bool
  var artworkScale: CGFloat?
  var accurateScreenSize: CGSize?
  var showsDeviceFrame: Bool
  var onFrameSizeChange: ((CGSize?) -> Void)?
  var onPixelSizeChange: (CGSize) -> Void
  @State private var status = EmulatorStreamStatus.connecting

  var body: some View {
    EmulatorDisplayView(
      serial: serial, interactive: interactive,
      onStatus: { status in DispatchQueue.main.async { self.status = status } },
      onPixelSizeChange: { size in DispatchQueue.main.async { onPixelSizeChange(size) } }, buttons: buttons,
      avdName: avdName, showsDeviceFrame: showsDeviceFrame, onFrameSizeChange: onFrameSizeChange, fullResolution: fullResolution,
      artworkScale: artworkScale, accurateScreenSize: accurateScreenSize
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
  @Environment(\.workspaceTitle) private var title

  var body: some View {
    TimelineView(.buildSeconds(build)) { context in
      let progress = build.progress(at: context.date)
      let (phase, counts) = build.currentPhaseLabel
      let estimate = build.expectedMs.map { " / ~\(Format.clock(ms: $0))" } ?? ""
      VStack(spacing: Space.sm) {
        Text(
          build.phase == "wait" && build.waitingOn != nil
            ? "Waiting for \(title(build.waitingOn?.path ?? ""))'s \(platformName(build.platform)) build"
            : "Waiting for the \(platformName(build.platform)) build"
        )
        .font(.stim(.callout)).foregroundStyle(.white.opacity(0.85))
        if let text = build.waitingFor?.text(at: context.date) {
          Text(text).font(.stim(.caption)).foregroundStyle(.white.opacity(0.85)).monospacedDigit()
        }
        Text([phase, counts].compactMap { $0 }.joined(separator: " \u{00B7} "))
          .font(.stim(.caption))
          .foregroundStyle(.white.opacity(0.6))
          .lineLimit(1)
        StimProgressBar(value: progress.fraction)
          .controlSize(.small)
          .frame(maxWidth: 160)
        Text(Format.clock(ms: progress.elapsedMs) + estimate)
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

extension ActivityBadge {
  fileprivate var driverTool: String? {
    if case .driven(let tool, _) = self { return tool }
    return nil
  }
}

private struct ClipboardRequest: Equatable {
  var target: String
  var text: String?
}
