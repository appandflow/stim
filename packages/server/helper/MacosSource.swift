import AppKit
import CoreImage
import Darwin
import ScreenCaptureKit

final class MacosSource: NSObject, Source, SCStreamDelegate, SCStreamOutput {
  struct OwnedApp: Decodable {
    struct Process: Decodable {
      let pid: Int32
      let startedAtMicros: UInt64
    }
    let bundle: String
    let bundleId: String
    let executable: String
    let app: Process
  }

  private typealias WindowLocationSetter = @convention(c) (CGEvent, CGPoint) -> Void
  private static let windowLocation: WindowLocationSetter? = {
    guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGEventSetWindowLocation") else { return nil }
    return unsafeBitCast(symbol, to: WindowLocationSetter.self)
  }()

  private static let screenPermission =
    ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 15
    ? "Screen & System Audio Recording" : "Screen Recording"
  private static let controlPermission =
    ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 27
    ? "Device Control and Data Access" : "Accessibility"

  private let app: OwnedApp
  private let pacer: Pacer
  private let video = videoEncoder()
  private let jpegGate = JpegGate()
  private let keyboardLayouts = KeyboardLayoutCache()
  private var window: SCWindow?
  private var reported: (selection: OwnedAppWindows.Selection?, pinned: Bool)?
  private var pinned: (window: UInt32, session: String)?
  private var switching = false
  private var followTimer: DispatchSourceTimer?
  private let followQueue = DispatchQueue(label: "stim.frames.macos.follow")
  private let inputQueue = DispatchQueue(label: "stim.frames.macos.input")
  private var controlSession: String?
  private var heldMouse:
    (session: String, window: (windowID: CGWindowID, frame: CGRect), accessible: AXUIElement, position: CGPoint)?
  private var lastInput: Task<Void, Never>?
  private var stream: SCStream?
  private var pixels: CVPixelBuffer?
  private var ownershipTimer: DispatchSourceTimer?

  init(app: OwnedApp) {
    self.app = app
    var render: (Config) -> Void = { _ in }
    pacer = Pacer { render($0) }
    super.init()
    render = { [unowned self] config in self.render(config) }
  }

  func start() {
    guard matches() else { fail("The owned macOS app process changed or exited.") }
    guard CGPreflightScreenCaptureAccess() else {
      if let host = ProcessInfo.processInfo.environment["STIM_CAPTURE_HOST"] {
        fail(
          "\(Self.screenPermission) access is unavailable for stim-frames. Allow \(host) in System Settings > Privacy & Security > \(Self.screenPermission) on this Mac, or run `stim-server service install` again on this Mac to show the request, then reconnect. The server never requests or resets permissions; status and logs remain available."
        )
      }
      fail(
        "\(Self.screenPermission) access is unavailable for stim-frames. Allow the existing capture host in System Settings > Privacy & Security > \(Self.screenPermission), then reconnect. Open Permissions in Stim Desktop on this Mac to set up access, then reconnect. The server never requests or resets permissions; status and logs remain available."
      )
    }
    Task { [self] in
      do {
        var found: OwnedAppWindows.Selection?
        for attempt in 1... {
          do {
            found = try self.currentWindows()
            break
          } catch {
            if attempt == 4 { throw error }
            try await Task.sleep(for: .milliseconds(250))
          }
        }
        guard let selection = found else {
          fail(
            AXIsProcessTrusted()
              ? "Open a window in the owned macOS app to view it. Stim does not capture the desktop or other apps."
              : "Open one visible window in the owned macOS app to view it. Without \(Self.controlPermission) permission Stim cannot tell which app window is in front, so it views only an app with one window."
          )
        }
        guard try await self.capture(selection) else { fail("The owned macOS app window closed before capture started.") }
        let timer = DispatchSource.makeTimerSource(queue: self.pacer.queue)
        timer.schedule(deadline: .now() + 1, repeating: 1)
        timer.setEventHandler { [weak self] in
          guard let self else { return }
          if !self.matches() { fail("The owned macOS app process changed or exited.") }
        }
        self.ownershipTimer = timer
        timer.resume()
        let follow = DispatchSource.makeTimerSource(queue: self.followQueue)
        follow.schedule(deadline: .now() + .milliseconds(250), repeating: .milliseconds(250))
        follow.setEventHandler { [weak self] in self?.follow() }
        self.followTimer = follow
        follow.resume()
      } catch { fail("Owned macOS window capture failed: \(error.localizedDescription)") }
    }
  }

  private func capture(_ selection: OwnedAppWindows.Selection) async throws -> Bool {
    guard let window = try await shareable(selection.current.id) else { return false }
    let filter = SCContentFilter(desktopIndependentWindow: window)
    let stream = SCStream(filter: filter, configuration: Self.configuration(filter), delegate: self)
    try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: pacer.queue)
    try await stream.startCapture()
    followQueue.sync {
      self.stream = stream
      self.window = window
      report(selection)
    }
    return true
  }

  private static func configuration(_ filter: SCContentFilter) -> SCStreamConfiguration {
    let configuration = SCStreamConfiguration()
    configuration.width = Int((filter.contentRect.width * CGFloat(filter.pointPixelScale)).rounded(.up))
    configuration.height = Int((filter.contentRect.height * CGFloat(filter.pointPixelScale)).rounded(.up))
    configuration.ignoreShadowsSingleWindow = true
    configuration.minimumFrameInterval = CMTime(value: 1, timescale: 30)
    configuration.queueDepth = 3
    configuration.showsCursor = false
    return configuration
  }

  private func shareable(_ id: CGWindowID) async throws -> SCWindow? {
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
    guard matches() else { fail("The owned macOS app process changed or exited.") }
    return content.windows.first {
      $0.windowID == id && $0.owningApplication?.processID == app.app.pid
        && $0.owningApplication?.bundleIdentifier == app.bundleId && $0.windowLayer == 0
    }
  }

  private func currentWindows() throws -> OwnedAppWindows.Selection? {
    do { return try OwnedAppWindowReader.selection(pid: app.app.pid) } catch {
      throw refusal("The owned app's current window inventory is unavailable.")
    }
  }

  private func isOpen(_ id: CGWindowID) -> Bool {
    OwnedAppWindowReader.screen(pid: app.app.pid)?.contains { $0.id == id } == true
  }

  private func applyPin(_ selection: OwnedAppWindows.Selection, screen: [OwnedAppWindows.Screen]?) -> OwnedAppWindows.Selection {
    guard pinned != nil else { return selection }
    guard let screen = screen ?? OwnedAppWindowReader.screen(pid: app.app.pid) else { return selection }
    let result = OwnedAppWindows.pin(selection, to: pinned?.window, screen: screen)
    if result.pinned == nil { pinned = nil }
    return result.selection
  }

  private func follow() {
    guard !switching, matches() else { return }
    let found: OwnedAppWindows.Selection?
    do { found = try currentWindows() } catch { return }
    guard let found else {
      pinned = nil
      return report(nil)
    }
    let selection = applyPin(found, screen: nil)
    guard let stream, let captured = window else {
      switching = true
      Task {
        do {
          _ = try await self.capture(selection)
        } catch {
          if self.isOpen(selection.current.id) { fail("Owned macOS window capture failed: \(error.localizedDescription)") }
        }
        self.followQueue.sync { self.switching = false }
      }
      return
    }
    guard selection.current.id != captured.windowID || selection.current.frame.size != captured.frame.size else {
      return report(selection)
    }
    switching = true
    Task {
      var next: SCWindow?
      do {
        next = try await self.shareable(selection.current.id)
        if let next {
          let filter = SCContentFilter(desktopIndependentWindow: next)
          try await stream.updateContentFilter(filter)
          try await stream.updateConfiguration(Self.configuration(filter))
        }
      } catch {
        next = nil
        try? await stream.stopCapture()
        self.followQueue.sync { if self.stream === stream { self.stream = nil } }
      }
      self.followQueue.sync {
        self.switching = false
        guard let next else { return }
        self.window = next
        self.report(selection)
      }
      if next != nil { self.keyframe() }
    }
  }

  private func report(_ found: OwnedAppWindows.Selection?) {
    let shown: (OwnedAppWindows.Window) -> OwnedAppWindows.Window = { .init(id: $0.id, title: $0.title, frame: $0.frame, accessible: nil) }
    let selection = found.map { OwnedAppWindows.Selection(current: shown($0.current), windows: $0.windows.map(shown)) }
    let state = (selection: selection, pinned: pinned != nil)
    if let reported, reported.selection == state.selection, reported.pinned == state.pinned { return }
    if reported?.selection == nil || selection == nil {
      let reason =
        AXIsProcessTrusted()
        ? "The owned macOS app has no open window."
        : "Without \(Self.controlPermission) permission Stim views only an owned app whose one window contains the others."
      Output.notice(["stalled": selection == nil ? reason : NSNull()])
    }
    reported = state
    let json: (OwnedAppWindows.Window) -> [String: Any] = {
      [
        "id": Int($0.id), "title": $0.title,
        "frame": ["x": $0.frame.minX, "y": $0.frame.minY, "width": $0.frame.width, "height": $0.frame.height],
      ]
    }
    Output.notice([
      "macosWindows": [
        "current": selection.map { json($0.current) as Any } ?? NSNull(), "windows": (selection?.windows ?? []).map(json),
        "pinned": state.pinned,
      ]
    ])
  }

  func configure(_ config: Config) {
    video.configure(enabled: config.video, maxEdge: config.maxEdge, fps: Int(config.fps), bitrate: config.bitrate)
    pacer.queue.async {
      self.pacer.config = config
      self.pacer.changed()
    }
  }

  func keyframe() {
    video.requestKeyframe()
    pacer.changed()
  }

  func recordKeyframe() {}

  func stop() {
    inputQueue.sync {
      if let held = heldMouse { releaseMouse(held.session) }
      controlSession = nil
    }
  }

  func input(_ command: Command) {
    inputQueue.async {
      switch command {
      case .control(let session, let enabled):
        if enabled {
          if let held = self.heldMouse { self.releaseMouse(held.session) }
          self.controlSession = session
          self.followQueue.async { if self.pinned?.session != session { self.pinned = nil } }
        } else if self.controlSession == session {
          self.releaseMouse(session)
          self.controlSession = nil
          self.unpin(session)
        }
      case .scoped(let session, let action):
        let previous = self.lastInput
        self.lastInput = Task {
          await previous?.value
          guard self.isActive(session) else { return }
          do { try await self.apply(action, session: session) } catch is CancellationError {
          } catch let changed as Dropped {
            Output.notice(["inputError": changed.localizedDescription])
          } catch {
            if self.endControl(session) { Output.notice(["inputError": error.localizedDescription, "controlSession": session]) }
          }
        }
      default: break
      }
    }
  }

  private func isActive(_ session: String) -> Bool {
    inputQueue.sync { controlSession == session }
  }

  private func endControl(_ session: String) -> Bool {
    inputQueue.sync {
      guard controlSession == session else { return false }
      releaseMouse(session)
      controlSession = nil
      unpin(session)
      return true
    }
  }

  /// A pin lasts only as long as the Control session that chose it.
  private func unpin(_ session: String) {
    followQueue.async { if self.pinned?.session == session { self.pinned = nil } }
  }

  private func releaseMouse(_ session: String) {
    guard let held = heldMouse, held.session == session else { return }
    heldMouse = nil
    guard matches(), AXIsProcessTrusted(), CGPreflightPostEventAccess(),
      let entries = CGWindowListCopyWindowInfo(.optionIncludingWindow, held.window.windowID) as? [[String: Any]],
      entries.count == 1, let entry = entries.first,
      entry[kCGWindowOwnerPID as String] as? Int == Int(app.app.pid),
      entry[kCGWindowLayer as String] as? Int == 0,
      let bounds = entry[kCGWindowBounds as String] as? [String: Any],
      let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary), frame == held.window.frame
    else { return }
    var focused: CFTypeRef?
    guard
      AXUIElementCopyAttributeValue(
        AXUIElementCreateApplication(app.app.pid), kAXFocusedWindowAttribute as CFString, &focused) == .success,
      let focused, CFEqual(focused, held.accessible),
      let native = NSEvent.mouseEvent(
        with: .leftMouseUp,
        location: CGPoint(x: held.position.x - held.window.frame.minX, y: held.window.frame.maxY - held.position.y),
        modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: Int(held.window.windowID),
        context: nil, eventNumber: 0, clickCount: 1, pressure: 0), let event = native.cgEvent,
      let setWindowLocation = Self.windowLocation,
      matches()
    else { return }
    event.location = held.position
    setWindowLocation(event, CGPoint(x: held.position.x - held.window.frame.minX, y: held.position.y - held.window.frame.minY))
    event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(held.window.windowID))
    event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(held.window.windowID))
    event.postToPid(app.app.pid)
  }

  // NSRunningApplication(processIdentifier:) returns nil for 1-2 ms at a time on macOS 27 while the process runs.
  private static func runningApplication(_ pid: pid_t) -> NSRunningApplication? {
    for attempt in 0..<4 {
      if attempt > 0 { usleep(5_000) }
      if let running = NSRunningApplication(processIdentifier: pid) { return running }
    }
    return nil
  }

  private struct Dropped: LocalizedError {
    var errorDescription: String? = "The owned app's window changed before input, so the input was not sent."
  }

  private func refusal(_ message: String) -> NSError {
    NSError(domain: "StimFrames", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
  }

  private func inputWindow() throws -> ((windowID: CGWindowID, frame: CGRect), AXUIElement) {
    guard matches(), let captured = followQueue.sync(execute: { window }) else {
      throw refusal("The captured owned macOS app window is unavailable.")
    }
    guard AXIsProcessTrusted(), CGPreflightPostEventAccess() else {
      let permission = Self.controlPermission
      if let host = ProcessInfo.processInfo.environment["STIM_CAPTURE_HOST"] {
        throw refusal(
          "Control needs \(permission) permission. Allow \(host) in System Settings > Privacy & Security > \(permission) on this Mac, or run `stim-server service install` again on this Mac to show the request, then reconnect. The server never requests or resets permissions; viewing and logs remain available."
        )
      }
      throw refusal(
        "Control needs \(permission) permission for the capture host. Open Permissions in Stim Desktop on this Mac, or allow the host in System Settings > Privacy & Security > \(permission), then reconnect. The server never requests or resets permissions; viewing and logs remain available."
      )
    }
    guard let accessible = OwnedAppWindowReader.accessible(pid: app.app.pid) else {
      throw refusal("The owned app's accessible windows are unavailable.")
    }
    guard !accessible.modal else { throw refusal("Control needs accessible owned app windows without a modal dialog.") }
    guard let screen = OwnedAppWindowReader.screen(pid: app.app.pid) else {
      throw refusal("The owned app's current window inventory is unavailable.")
    }
    guard let found = OwnedAppWindows.select(screen: screen, accessible: accessible.windows), matches() else {
      throw Dropped()
    }
    let selection = followQueue.sync { applyPin(found, screen: screen) }
    guard selection.current.id == captured.windowID,
      selection.current.frame.size == captured.frame.size, let index = selection.current.accessible
    else { throw Dropped() }
    return ((selection.current.id, selection.current.frame), accessible.elements[index])
  }

  private func attachedSheets(_ own: AXUIElement) -> [AXUIElement] {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(own, kAXChildrenAttribute as CFString, &value) == .success,
      let children = value as? [AXUIElement]
    else { return [] }
    var sheets: [AXUIElement] = []
    for child in children {
      var role: CFTypeRef?
      if AXUIElementCopyAttributeValue(child, kAXRoleAttribute as CFString, &role) == .success,
        role as? String == kAXSheetRole
      {
        sheets.append(child)
        sheets.append(contentsOf: attachedSheets(child))
      }
    }
    return sheets
  }

  private func isFocused(_ own: AXUIElement, application: AXUIElement) -> Bool {
    var focused: CFTypeRef?
    return AXUIElementCopyAttributeValue(application, kAXFocusedWindowAttribute as CFString, &focused) == .success
      && focused.map { value in ([own] + attachedSheets(own)).contains { CFEqual(value, $0) } } == true
  }

  /// Pins capture and Control to the app's window `id`, raising it, or with nil follows the front window again.
  private func select(_ id: UInt32?, session: String) throws {
    guard let id else {
      followQueue.sync { pinned = nil }
      return
    }
    guard matches(), AXIsProcessTrusted(), let accessible = OwnedAppWindowReader.accessible(pid: app.app.pid),
      let screen = OwnedAppWindowReader.screen(pid: app.app.pid)
    else { throw Dropped(errorDescription: "The owned app's windows are unavailable, so the window was not chosen.") }
    guard !accessible.modal else {
      throw Dropped(errorDescription: "The owned app shows a modal dialog, so the window was not chosen.")
    }
    guard let selection = OwnedAppWindows.select(screen: screen, accessible: accessible.windows),
      let index = selection.windows.first(where: { $0.id == id })?.accessible, matches()
    else { throw Dropped() }
    let element = accessible.elements[index]
    _ = AXUIElementSetAttributeValue(element, kAXMainAttribute as CFString, kCFBooleanTrue)
    _ = AXUIElementPerformAction(element, kAXRaiseAction as CFString)
    guard isActive(session) else { throw CancellationError() }
    followQueue.sync {
      pinned = (id, session)
      follow()
    }
  }

  private func apply(_ command: Command, session: String) async throws {
    if case .window(let id) = command { return try select(id, session: session) }
    guard let setWindowLocation = Self.windowLocation else {
      throw refusal("Native window input is unavailable on this macOS version. Viewing and logs remain available.")
    }
    let (window, own) = try inputWindow()
    guard isActive(session) else { throw CancellationError() }
    let application = AXUIElementCreateApplication(app.app.pid)
    if !isFocused(own, application: application) {
      guard let running = Self.runningApplication(app.app.pid)
      else { throw refusal("The captured owned window could not be focused for Control.") }
      Output.notice([
        "controlActivated": "The captured window was not the app's key window, so Stim raised it and activated the app to deliver input."
      ])
      let raise = AXUIElementPerformAction(own, kAXRaiseAction as CFString)
      let focus = AXUIElementSetAttributeValue(application, kAXFocusedWindowAttribute as CFString, own)
      let activated = running.activate(options: [])
      let deadline = ContinuousClock.now.advanced(by: .seconds(1))
      while !(running.isActive && isFocused(own, application: application)) {
        guard isActive(session), matches() else { throw CancellationError() }
        guard activated, ContinuousClock.now < deadline else {
          throw refusal(
            "The captured owned window could not be focused for Control. (raise \(raise.rawValue), focus \(focus.rawValue), activate \(activated))"
          )
        }
        try await Task.sleep(for: .milliseconds(10))
      }
    }
    var focusedValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(application, kAXFocusedWindowAttribute as CFString, &focusedValue) == .success,
      let focusedValue, let focused = ([own] + attachedSheets(own)).first(where: { CFEqual(focusedValue, $0) }), matches()
    else { throw refusal("The captured owned window lost focus before input.") }
    var sheetWindow: (windowID: CGWindowID, frame: CGRect)?
    if !CFEqual(focused, own) {
      var positionValue: CFTypeRef?
      var sizeValue: CFTypeRef?
      var position = CGPoint.zero
      var size = CGSize.zero
      guard AXUIElementCopyAttributeValue(focused, kAXPositionAttribute as CFString, &positionValue) == .success,
        AXUIElementCopyAttributeValue(focused, kAXSizeAttribute as CFString, &sizeValue) == .success,
        let positionValue, let sizeValue, CFGetTypeID(positionValue) == AXValueGetTypeID(),
        CFGetTypeID(sizeValue) == AXValueGetTypeID(),
        AXValueGetValue(unsafeDowncast(positionValue, to: AXValue.self), .cgPoint, &position),
        AXValueGetValue(unsafeDowncast(sizeValue, to: AXValue.self), .cgSize, &size),
        let entries = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
          as? [[String: Any]]
      else { throw refusal("The focused owned sheet's window metadata is unavailable.") }
      let frame = CGRect(origin: position, size: size)
      guard
        let entry = entries.first(where: {
          guard $0[kCGWindowOwnerPID as String] as? Int == Int(app.app.pid),
            $0[kCGWindowLayer as String] as? Int == 0,
            let id = $0[kCGWindowNumber as String] as? UInt32, id != window.windowID,
            let bounds = $0[kCGWindowBounds as String] as? [String: Any]
          else { return false }
          return CGRect(dictionaryRepresentation: bounds as CFDictionary) == frame
        }), let id = entry[kCGWindowNumber as String] as? UInt32
      else { throw refusal("The focused owned sheet does not match an on-screen app window.") }
      sheetWindow = (id, frame)
    }
    let location: (CGPoint) -> CGPoint = {
      CGPoint(x: window.frame.minX + $0.x * (window.frame.width - 1), y: window.frame.minY + $0.y * (window.frame.height - 1))
    }
    let pointerWindow: (CGPoint) -> (windowID: CGWindowID, frame: CGRect) = { point in
      if let sheetWindow, sheetWindow.frame.contains(point) { return sheetWindow }
      return window
    }
    let post: ([CGEvent], (windowID: CGWindowID, frame: CGRect)) throws -> Void = { events, target in
      try self.inputQueue.sync {
        guard self.controlSession == session else { throw CancellationError() }
        var focusedValue: CFTypeRef?
        guard self.matches(),
          AXUIElementCopyAttributeValue(application, kAXFocusedWindowAttribute as CFString, &focusedValue) == .success,
          let focusedValue, CFEqual(focusedValue, focused)
        else { throw self.refusal("The captured owned window changed before input.") }
        for event in events {
          guard self.matches() else { throw self.refusal("The owned macOS app process changed before input.") }
          event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(target.windowID))
          event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(target.windowID))
          // AppKit PID-targeted pointer events need CoreGraphics' private window-local annotation.
          if [.leftMouseDown, .leftMouseUp, .leftMouseDragged, .scrollWheel].contains(event.type) {
            setWindowLocation(event, CGPoint(x: event.location.x - target.frame.minX, y: event.location.y - target.frame.minY))
          }
          event.postToPid(self.app.app.pid)
          switch event.type {
          case .leftMouseDown:
            self.heldMouse = (session, target, focused, event.location)
          case .leftMouseDragged:
            if self.heldMouse?.session == session { self.heldMouse?.position = event.location }
          case .leftMouseUp:
            if self.heldMouse?.session == session { self.heldMouse = nil }
          default: break
          }
        }
      }
    }
    let key: (CGKeyCode, CGEventFlags, String?) throws -> Void = { code, flags, text in
      var events: [CGEvent] = []
      for down in [true, false] {
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down) else {
          throw self.refusal("The native keyboard event could not be created.")
        }
        event.flags = flags
        if let text {
          let utf16 = Array(text.utf16)
          event.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
        }
        events.append(event)
      }
      try post(events, window)
    }
    switch command {
    case .touch(let phase, let point, _):
      let type: NSEvent.EventType = phase == .down ? .leftMouseDown : phase == .up ? .leftMouseUp : .leftMouseDragged
      let global = location(point)
      let target = inputQueue.sync {
        if phase != .down, let held = heldMouse, held.session == session { return held.window }
        return pointerWindow(global)
      }
      guard
        let native = NSEvent.mouseEvent(
          with: type, location: CGPoint(x: global.x - target.frame.minX, y: target.frame.maxY - global.y),
          modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: Int(target.windowID),
          context: nil, eventNumber: 0, clickCount: 1, pressure: phase == .up ? 0 : 1), let event = native.cgEvent
      else { throw refusal("The native mouse event could not be created.") }
      event.location = global
      try post([event], target)
    case .scroll(let point, let delta):
      let global = location(point)
      let target = pointerWindow(global)
      guard
        let native = NSEvent.mouseEvent(
          with: .mouseMoved, location: CGPoint(x: global.x - target.frame.minX, y: target.frame.maxY - global.y),
          modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: Int(target.windowID),
          context: nil, eventNumber: 0, clickCount: 0, pressure: 0), let event = native.cgEvent,
        let wheel = CGEvent(
          scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2,
          wheel1: Int32(delta.y.rounded()), wheel2: Int32(delta.x.rounded()), wheel3: 0)
      else { throw refusal("The native scroll event could not be created.") }
      event.type = .scrollWheel
      for field: CGEventField in [
        .scrollWheelEventDeltaAxis1, .scrollWheelEventDeltaAxis2,
        .scrollWheelEventPointDeltaAxis1, .scrollWheelEventPointDeltaAxis2, .scrollWheelEventIsContinuous,
      ] {
        event.setIntegerValueField(field, value: wheel.getIntegerValueField(field))
      }
      for field: CGEventField in [.scrollWheelEventFixedPtDeltaAxis1, .scrollWheelEventFixedPtDeltaAxis2] {
        event.setDoubleValueField(field, value: wheel.getDoubleValueField(field))
      }
      event.location = global
      try post([event], target)
    case .text(let text):
      for character in text {
        let special: [Character: CGKeyCode] = ["\n": 36, "\t": 48, "\u{0008}": 51]
        try key(special[character] ?? 0, [], special[character] == nil ? String(character) : nil)
      }
    case .key(let name, let modifiers):
      let codes: [String: CGKeyCode] = [
        "escape": 53, "tab": 48, "return": 36, "backspace": 51,
        "left": 123, "right": 124, "down": 125, "up": 126,
      ]
      let flags: [String: CGEventFlags] = [
        "command": .maskCommand, "shift": .maskShift, "option": .maskAlternate, "control": .maskControl,
      ]
      guard modifiers.allSatisfy({ flags[$0] != nil }) else { throw refusal("Unsupported native key.") }
      let code: CGKeyCode
      if name.count == 1 {
        guard let character = name.first, "abcdefghijklmnopqrstuvwxyz0123456789".contains(character) else {
          throw refusal("Unsupported native key.")
        }
        let layout = try DispatchQueue.main.sync {
          guard isActive(session), matches() else {
            throw refusal("The Control session or owned app changed before reading its keyboard layout.")
          }
          return keyboardLayouts.current()
        }
        guard let layout else {
          throw refusal(
            "The Mac's keyboard layout could not be read, so native letter and digit shortcuts cannot be sent. Ordinary typing and navigation do not require it."
          )
        }
        let command = modifiers.contains("command")
        let control = modifiers.contains("control")
        guard let resolved = layout.map.keyCode(for: character, command: command, control: control) else {
          let layer = control ? (command ? " with Command and Control" : " with Control") : (command ? " with Command" : "")
          throw refusal(
            "The Mac's current keyboard layout (\(layout.id)) has no key that types \"\(character)\"\(layer), so the shortcut was not sent. Select an input source that has it and start Control again. Ordinary typing and navigation do not require it."
          )
        }
        code = resolved
      } else {
        guard let navigation = codes[name] else { throw refusal("Unsupported native key.") }
        code = navigation
      }
      try key(code, modifiers.reduce(CGEventFlags()) { $0.union(flags[$1]!) }, nil)
    default: throw refusal("Unsupported native macOS input.")
    }
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    followQueue.asyncAfter(deadline: .now() + .milliseconds(500)) {
      guard self.stream === stream else { return }
      if let id = self.window?.windowID, self.isOpen(id) {
        fail("Owned macOS window capture stopped: \(error.localizedDescription)")
      }
      self.stream = nil
    }
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, let buffer = sampleBuffer.imageBuffer else { return }
    guard matches() else { fail("The owned macOS app process changed or exited.") }
    pixels = buffer
    pacer.changed()
  }

  private func render(_ config: Config) {
    guard matches() else { fail("The owned macOS app process changed or exited.") }
    guard let pixels else { return }
    if config.video { video.encode(pixels, quarterTurns: 0, capturedAt: now()) }
    if config.jpeg, jpegGate.admit(config, pacer: pacer),
      let (data, width, height) = jpeg(CIImage(cvPixelBuffer: pixels), config: config)
    {
      Output.frame(jpeg: data, width: width, height: height)
    }
  }

  private func matches() -> Bool {
    var info = proc_bsdinfo()
    guard app.app.pid > 0,
      proc_pidinfo(app.app.pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size))
        == MemoryLayout<proc_bsdinfo>.size,
      info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec == app.app.startedAtMicros,
      let running = Self.runningApplication(app.app.pid),
      running.bundleIdentifier == app.bundleId,
      running.executableURL?.resolvingSymlinksInPath().path
        == URL(fileURLWithPath: app.executable).resolvingSymlinksInPath().path,
      running.bundleURL?.resolvingSymlinksInPath().path == URL(fileURLWithPath: app.bundle).resolvingSymlinksInPath().path
    else { return false }
    return true
  }
}
