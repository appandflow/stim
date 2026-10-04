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

  private let app: OwnedApp
  private let pacer: Pacer
  private let video = videoEncoder()
  private let jpegGate = JpegGate()
  private var window: SCWindow?
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
      fail(
        "Screen Recording access is unavailable for stim-frames. Allow the existing capture host in System Settings > Privacy & Security > Screen & System Audio Recording, then reconnect. Open Permissions in Stim Desktop on this Mac to set up access, then reconnect. The server never requests or resets permissions; status and logs remain available."
      )
    }
    Task { [self] in
      do {
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        guard self.matches() else { fail("The owned macOS app process changed or exited.") }
        let windows = content.windows.filter {
          $0.owningApplication?.processID == self.app.app.pid
            && $0.owningApplication?.bundleIdentifier == self.app.bundleId && $0.windowLayer == 0
        }
        let mainWindows = windows.filter { candidate in
          windows.allSatisfy { candidate.windowID == $0.windowID || candidate.frame.contains($0.frame) }
        }
        guard mainWindows.count == 1, let window = mainWindows.first else {
          fail(
            "Open one visible window in the owned macOS app to view it. Stim does not capture the desktop or choose between app windows."
          )
        }
        self.window = window
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let configuration = SCStreamConfiguration()
        configuration.width = Int((filter.contentRect.width * CGFloat(filter.pointPixelScale)).rounded(.up))
        configuration.height = Int((filter.contentRect.height * CGFloat(filter.pointPixelScale)).rounded(.up))
        configuration.ignoreShadowsSingleWindow = true
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        configuration.queueDepth = 3
        configuration.showsCursor = false
        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        self.stream = stream
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: self.pacer.queue)
        try await stream.startCapture()
        let timer = DispatchSource.makeTimerSource(queue: self.pacer.queue)
        timer.schedule(deadline: .now() + 1, repeating: 1)
        timer.setEventHandler { [weak self] in
          guard let self else { return }
          if !self.matches() { fail("The owned macOS app process changed or exited.") }
        }
        self.ownershipTimer = timer
        timer.resume()
      } catch { fail("Owned macOS window capture failed: \(error.localizedDescription)") }
    }
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
        } else if self.controlSession == session {
          self.releaseMouse(session)
          self.controlSession = nil
        }
      case .scoped(let session, let action):
        let previous = self.lastInput
        self.lastInput = Task {
          await previous?.value
          guard self.isActive(session) else { return }
          do { try self.apply(action, session: session) } catch is CancellationError {
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
      return true
    }
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

  private func refusal(_ message: String) -> NSError {
    NSError(domain: "StimFrames", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
  }

  private func inputWindow() throws -> ((windowID: CGWindowID, frame: CGRect), AXUIElement) {
    guard matches(), let captured = window else { throw refusal("The captured owned macOS app window is unavailable.") }
    guard AXIsProcessTrusted(), CGPreflightPostEventAccess() else {
      let permission = ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 27
        ? "Device Control and Data Access" : "Accessibility"
      throw refusal(
        "Control needs \(permission) permission for the capture host. Open Permissions in Stim Desktop on this Mac, or allow the host in System Settings > Privacy & Security > \(permission), then reconnect. The server never requests or resets permissions; viewing and logs remain available."
      )
    }
    guard
      let entries = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]]
    else {
      throw refusal("The owned app's current window inventory is unavailable.")
    }
    var windows: [(windowID: CGWindowID, frame: CGRect)] = []
    for entry in entries
    where entry[kCGWindowOwnerPID as String] as? Int == Int(app.app.pid) && entry[kCGWindowLayer as String] as? Int == 0 {
      guard let id = entry[kCGWindowNumber as String] as? UInt32,
        let bounds = entry[kCGWindowBounds as String] as? [String: Any],
        let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary)
      else { throw refusal("The owned app's current window metadata is unavailable.") }
      windows.append((id, frame))
    }
    let main = windows.filter { candidate in windows.allSatisfy { candidate.frame.contains($0.frame) } }
    guard matches(), main.count == 1, let current = main.first,
      current.windowID == captured.windowID, current.frame.size == captured.frame.size
    else {
      throw refusal("The owned app's captured window changed. Reconnect to its current single window before controlling it.")
    }
    let application = AXUIElementCreateApplication(app.app.pid)
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString, &value) == .success,
      let owned = value as? [AXUIElement]
    else { throw refusal("The owned app's accessible windows are unavailable.") }
    var candidates: [AXUIElement] = []
    for own in owned {
      var subrole: CFTypeRef?
      var modal: CFTypeRef?
      var positionValue: CFTypeRef?
      var sizeValue: CFTypeRef?
      var position = CGPoint.zero
      var size = CGSize.zero
      guard AXUIElementCopyAttributeValue(own, kAXSubroleAttribute as CFString, &subrole) == .success,
        AXUIElementCopyAttributeValue(own, kAXModalAttribute as CFString, &modal) == .success,
        modal as? Bool == false,
        AXUIElementCopyAttributeValue(own, kAXPositionAttribute as CFString, &positionValue) == .success,
        AXUIElementCopyAttributeValue(own, kAXSizeAttribute as CFString, &sizeValue) == .success,
        let positionValue, let sizeValue, CFGetTypeID(positionValue) == AXValueGetTypeID(),
        CFGetTypeID(sizeValue) == AXValueGetTypeID(),
        AXValueGetValue(unsafeDowncast(positionValue, to: AXValue.self), .cgPoint, &position),
        AXValueGetValue(unsafeDowncast(sizeValue, to: AXValue.self), .cgSize, &size)
      else { throw refusal("Control needs accessible owned app windows without a modal dialog.") }
      let frame = CGRect(origin: position, size: size)
      if subrole as? String == kAXStandardWindowSubrole, frame == current.frame {
        candidates.append(own)
      } else {
        // ScreenCaptureKit adds a contained nonmodal AXDialog sharing indicator on macOS 27.
        guard subrole as? String != kAXStandardWindowSubrole, current.frame.contains(frame) else {
          throw refusal("Control needs one captured main window without disjoint app windows.")
        }
      }
    }
    guard candidates.count == 1, let own = candidates.first, matches() else {
      throw refusal("The accessible window does not match the captured owned window.")
    }
    return (current, own)
  }

  private func apply(_ command: Command, session: String) throws {
    guard let setWindowLocation = Self.windowLocation else {
      throw refusal("Native window input is unavailable on this macOS version. Viewing and logs remain available.")
    }
    let (window, own) = try inputWindow()
    guard isActive(session) else { throw CancellationError() }
    let application = AXUIElementCreateApplication(app.app.pid)
    guard AXUIElementPerformAction(own, kAXRaiseAction as CFString) == .success,
      AXUIElementSetAttributeValue(application, kAXFocusedWindowAttribute as CFString, own) == .success,
      let running = NSRunningApplication(processIdentifier: app.app.pid), running.activate(options: [])
    else { throw refusal("The captured owned window could not be focused for Control.") }
    var focused: CFTypeRef?
    guard AXUIElementCopyAttributeValue(application, kAXFocusedWindowAttribute as CFString, &focused) == .success,
      let focused, CFEqual(focused, own), matches()
    else { throw refusal("The captured owned window lost focus before input.") }
    let location: (CGPoint) -> CGPoint = {
      CGPoint(x: window.frame.minX + $0.x * (window.frame.width - 1), y: window.frame.minY + $0.y * (window.frame.height - 1))
    }
    let post: ([CGEvent]) throws -> Void = { events in
      try self.inputQueue.sync {
        guard self.controlSession == session else { throw CancellationError() }
        var focused: CFTypeRef?
        guard self.matches(),
          AXUIElementCopyAttributeValue(application, kAXFocusedWindowAttribute as CFString, &focused) == .success,
          let focused, CFEqual(focused, own)
        else { throw self.refusal("The captured owned window changed before input.") }
        for event in events {
          guard self.matches() else { throw self.refusal("The owned macOS app process changed before input.") }
          event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(window.windowID))
          event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(window.windowID))
          // AppKit PID-targeted pointer events need CoreGraphics' private window-local annotation.
          if [.leftMouseDown, .leftMouseUp, .leftMouseDragged, .scrollWheel].contains(event.type) {
            setWindowLocation(event, CGPoint(x: event.location.x - window.frame.minX, y: event.location.y - window.frame.minY))
          }
          event.postToPid(self.app.app.pid)
          switch event.type {
          case .leftMouseDown:
            self.heldMouse = (session, window, own, event.location)
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
      try post(events)
    }
    switch command {
    case .touch(let phase, let point, _):
      let type: NSEvent.EventType = phase == .down ? .leftMouseDown : phase == .up ? .leftMouseUp : .leftMouseDragged
      let global = location(point)
      guard
        let native = NSEvent.mouseEvent(
          with: type, location: CGPoint(x: global.x - window.frame.minX, y: window.frame.maxY - global.y),
          modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: Int(window.windowID),
          context: nil, eventNumber: 0, clickCount: 1, pressure: phase == .up ? 0 : 1), let event = native.cgEvent
      else { throw refusal("The native mouse event could not be created.") }
      event.location = global
      try post([event])
    case .scroll(let point, let delta):
      let global = location(point)
      guard
        let native = NSEvent.mouseEvent(
          with: .mouseMoved, location: CGPoint(x: global.x - window.frame.minX, y: window.frame.maxY - global.y),
          modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: Int(window.windowID),
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
      try post([event])
    case .text(let text):
      for character in text {
        let special: [Character: CGKeyCode] = ["\n": 36, "\t": 48, "\u{0008}": 51]
        try key(special[character] ?? 0, [], special[character] == nil ? String(character) : nil)
      }
    case .key(let name, let modifiers):
      let codes: [String: CGKeyCode] = [
        "escape": 53, "tab": 48, "return": 36, "backspace": 51,
        "left": 123, "right": 124, "down": 125, "up": 126, "a": 0, "c": 8, "v": 9, "x": 7, "z": 6, "s": 1, "f": 3,
      ]
      let flags: [String: CGEventFlags] = [
        "command": .maskCommand, "shift": .maskShift, "option": .maskAlternate, "control": .maskControl,
      ]
      guard let code = codes[name], modifiers.allSatisfy({ flags[$0] != nil }) else { throw refusal("Unsupported native key.") }
      try key(code, modifiers.reduce(CGEventFlags()) { $0.union(flags[$1]!) }, nil)
    default: throw refusal("Unsupported native macOS input.")
    }
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    fail("Owned macOS window capture stopped: \(error.localizedDescription)")
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
      let running = NSRunningApplication(processIdentifier: app.app.pid),
      running.bundleIdentifier == app.bundleId,
      running.executableURL?.resolvingSymlinksInPath().path
        == URL(fileURLWithPath: app.executable).resolvingSymlinksInPath().path,
      running.bundleURL?.resolvingSymlinksInPath().path == URL(fileURLWithPath: app.bundle).resolvingSymlinksInPath().path
    else { return false }
    return true
  }
}
