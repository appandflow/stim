import Foundation

/// One `Page.screencastFrame`: Chrome's JPEG, the page area it shows in CSS pixels, and when Chrome drew it,
/// in milliseconds since the epoch.
public struct ScreencastFrame {
  public let jpeg: Data
  public let cssWidth: Double
  public let cssHeight: Double
  public let capturedAt: Double
}

public enum WebTouchPhase: String {
  case down, move, up
}

public enum WebMouseEvent: String {
  case pressed = "mousePressed"
  case moved = "mouseMoved"
  case released = "mouseReleased"
}

/// A key `Input.dispatchKeyEvent` presses by name, with its DOM `key`, `code` and Windows virtual key code, which
/// Chrome needs to run the key's default action.
public enum WebKey: String, CaseIterable {
  case enter, tab, backspace, escape, delete, left, right, up, down, home, end, pageUp, pageDown

  var fields: (key: String, code: String, keyCode: Int, text: String?) {
    switch self {
    case .enter: ("Enter", "Enter", 13, "\r")
    case .tab: ("Tab", "Tab", 9, nil)
    case .backspace: ("Backspace", "Backspace", 8, nil)
    case .escape: ("Escape", "Escape", 27, nil)
    case .delete: ("Delete", "Delete", 46, nil)
    case .left: ("ArrowLeft", "ArrowLeft", 37, nil)
    case .right: ("ArrowRight", "ArrowRight", 39, nil)
    case .up: ("ArrowUp", "ArrowUp", 38, nil)
    case .down: ("ArrowDown", "ArrowDown", 40, nil)
    case .home: ("Home", "Home", 36, nil)
    case .end: ("End", "End", 35, nil)
    case .pageUp: ("PageUp", "PageUp", 33, nil)
    case .pageDown: ("PageDown", "PageDown", 34, nil)
    }
  }
}

/// `Input.dispatch*` modifier bits.
public struct WebModifiers: OptionSet, Sendable {
  public let rawValue: Int
  public init(rawValue: Int) { self.rawValue = rawValue }
  public static let alt = WebModifiers(rawValue: 1)
  public static let control = WebModifiers(rawValue: 2)
  public static let meta = WebModifiers(rawValue: 4)
  public static let shift = WebModifiers(rawValue: 8)
}

/// The owned page, attached through a verified `DevToolsClient`: its screencast and its input. Points are
/// fractions of the screencast frame, which shows the page's viewport; before the first frame, of the viewport
/// the page reported when it attached.
public final class WebPage: @unchecked Sendable {
  public let targetId: String
  private let client: DevToolsClient
  private let sessionId: String
  private let queue = DispatchQueue(label: "stim.web.page")
  private var viewport: (width: Double, height: Double)?
  private var frameHandler: ((ScreencastFrame) -> Void)?
  private var endHandler: ((String) -> Void)?
  private var ended: String?
  private var touching = false

  private init(client: DevToolsClient, targetId: String, sessionId: String) {
    self.client = client
    self.targetId = targetId
    self.sessionId = sessionId
  }

  /// Connects to the owned Chrome at `endpoint` and attaches to `targetId`, both from `stim status`'s `web` entry.
  public static func open(
    endpoint: URL, chromePid: Int32, targetId: String, completion: @escaping (Result<WebPage, DevToolsError>) -> Void
  ) {
    DevToolsClient.connect(endpoint: endpoint, chromePid: chromePid) { connected in
      switch connected {
      case .failure(let failure): completion(.failure(failure))
      case .success(let client):
        client.send("Target.attachToTarget", ["targetId": targetId, "flatten": true]) { attached in
          guard case .success(let reply) = attached, let sessionId = reply["sessionId"] as? String else {
            client.close()
            if case .failure(let failure) = attached { return completion(.failure(failure)) }
            return completion(.failure(DevToolsError("Chrome did not attach to the page \(targetId).")))
          }
          let page = WebPage(client: client, targetId: targetId, sessionId: sessionId)
          client.onEvent { page.handle($0) }
          client.onClose { page.end("The DevTools connection closed.") }
          client.send("Target.setDiscoverTargets", ["discover": true])
          client.send("Page.enable", sessionId: sessionId)
          client.send(
            "Runtime.evaluate", ["expression": "[innerWidth, innerHeight]", "returnByValue": true],
            sessionId: sessionId
          ) { measured in
            if case .success(let reply) = measured,
              let size = (reply["result"] as? [String: Any])?["value"] as? [Double], size.count == 2
            {
              page.queue.async { page.viewport = page.viewport ?? (size[0], size[1]) }
            }
            completion(.success(page))
          }
        }
      }
    }
  }

  /// Frames arrive on the page's private queue; Chrome sends one when the page changes, and once on start.
  public func onFrame(_ handler: @escaping (ScreencastFrame) -> Void) {
    queue.async { self.frameHandler = handler }
  }

  /// Called once, when the page closes, Chrome exits or the connection drops; a crashed page stays attached.
  public func onEnd(_ handler: @escaping (String) -> Void) {
    queue.async {
      if let ended = self.ended { handler(ended) } else { self.endHandler = handler }
    }
  }

  /// `maxEdge` bounds both sides of the JPEG, in pixels; `quality` is 0-100. A running screencast stops first:
  /// Chrome sends no frame for a restart with new settings until the page changes.
  public func startScreencast(maxEdge: Int, quality: Int) {
    command("Page.stopScreencast")
    command(
      "Page.startScreencast",
      ["format": "jpeg", "quality": quality, "maxWidth": maxEdge, "maxHeight": maxEdge, "everyNthFrame": 1])
  }

  public func stopScreencast() {
    command("Page.stopScreencast")
  }

  public func close() {
    client.close()
  }

  public func touch(_ phase: WebTouchPhase, x: Double, y: Double) {
    queue.async {
      guard let point = self.point(x, y) else { return }
      let type: String
      switch phase {
      case .down:
        type = "touchStart"
        self.touching = true
      case .move:
        guard self.touching else { return }
        type = "touchMove"
      case .up:
        guard self.touching else { return }
        self.touching = false
        return self.command("Input.dispatchTouchEvent", ["type": "touchEnd", "touchPoints": [] as [Any]])
      }
      self.command("Input.dispatchTouchEvent", ["type": type, "touchPoints": [["x": point.x, "y": point.y]]])
    }
  }

  public func mouse(
    _ event: WebMouseEvent, x: Double, y: Double, pressed: Bool, clickCount: Int = 1, modifiers: WebModifiers = []
  ) {
    queue.async {
      guard let point = self.point(x, y) else { return }
      var params: [String: Any] = [
        "type": event.rawValue, "x": point.x, "y": point.y, "modifiers": modifiers.rawValue,
        "button": event == .moved && !pressed ? "none" : "left", "buttons": pressed ? 1 : 0,
      ]
      if event != .moved { params["clickCount"] = clickCount }
      self.command("Input.dispatchMouseEvent", params)
    }
  }

  /// Scrolls at the point by `deltaX` and `deltaY` CSS pixels, positive down and right.
  public func wheel(x: Double, y: Double, deltaX: Double, deltaY: Double, modifiers: WebModifiers = []) {
    queue.async {
      guard let point = self.point(x, y) else { return }
      self.command(
        "Input.dispatchMouseEvent",
        [
          "type": "mouseWheel", "x": point.x, "y": point.y, "deltaX": deltaX, "deltaY": deltaY,
          "modifiers": modifiers.rawValue,
        ])
    }
  }

  /// Types printable text as key presses; `\n` presses Enter, `\t` Tab and `\u{8}` Backspace.
  public func type(_ text: String) {
    queue.async {
      for character in text {
        switch character {
        case "\n", "\r": self.sendKey(.enter, [])
        case "\t": self.sendKey(.tab, [])
        case "\u{8}": self.sendKey(.backspace, [])
        default:
          let value = String(character)
          self.command(
            "Input.dispatchKeyEvent", ["type": "keyDown", "key": value, "text": value, "unmodifiedText": value])
          self.command("Input.dispatchKeyEvent", ["type": "keyUp", "key": value])
        }
      }
    }
  }

  public func press(_ key: WebKey, modifiers: WebModifiers = []) {
    queue.async { self.sendKey(key, modifiers) }
  }

  private func sendKey(_ key: WebKey, _ modifiers: WebModifiers) {
    let fields = key.fields
    var down: [String: Any] = [
      "type": fields.text == nil ? "rawKeyDown" : "keyDown", "key": fields.key, "code": fields.code,
      "windowsVirtualKeyCode": fields.keyCode, "modifiers": modifiers.rawValue,
    ]
    if let text = fields.text, modifiers.isEmpty { down["text"] = text }
    command("Input.dispatchKeyEvent", down)
    command(
      "Input.dispatchKeyEvent",
      [
        "type": "keyUp", "key": fields.key, "code": fields.code, "windowsVirtualKeyCode": fields.keyCode,
        "modifiers": modifiers.rawValue,
      ])
  }

  /// Goes back one entry in the page's history, when it has one.
  public func back() {
    queue.async { self.goBack() }
  }

  private func goBack() {
    client.send("Page.getNavigationHistory", sessionId: sessionId) { result in
      guard case .success(let history) = result, let index = history["currentIndex"] as? Int, index > 0,
        let entries = history["entries"] as? [[String: Any]], let id = entries[index - 1]["id"] as? Int
      else { return }
      self.command("Page.navigateToHistoryEntry", ["entryId": id])
    }
  }

  public func reload() {
    queue.async { self.command("Page.reload") }
  }

  private func command(_ method: String, _ params: [String: Any] = [:]) {
    client.send(method, params, sessionId: sessionId)
  }

  private func point(_ x: Double, _ y: Double) -> (x: Double, y: Double)? {
    guard let viewport else { return nil }
    return (min(max(x, 0), 1) * viewport.width, min(max(y, 0), 1) * viewport.height)
  }

  private func handle(_ event: DevToolsClient.Event) {
    switch event.method {
    case "Page.screencastFrame" where event.sessionId == sessionId:
      guard let ack = event.params["sessionId"] else { return }
      command("Page.screencastFrameAck", ["sessionId": ack])
      guard let base64 = event.params["data"] as? String, let jpeg = Data(base64Encoded: base64),
        let metadata = event.params["metadata"] as? [String: Any],
        let width = metadata["deviceWidth"] as? Double, let height = metadata["deviceHeight"] as? Double
      else { return }
      let timestamp = (metadata["timestamp"] as? Double).map { $0 * 1000 } ?? Date().timeIntervalSince1970 * 1000
      queue.async {
        self.viewport = (width, height)
        self.frameHandler?(ScreencastFrame(jpeg: jpeg, cssWidth: width, cssHeight: height, capturedAt: timestamp))
      }
    case "Target.targetDestroyed" where event.params["targetId"] as? String == targetId:
      end("The page was closed.")
    case "Target.detachedFromTarget" where event.params["sessionId"] as? String == sessionId:
      end("DevTools detached from the page.")
    default:
      break
    }
  }

  private func end(_ reason: String) {
    queue.async {
      guard self.ended == nil else { return }
      self.ended = reason
      self.endHandler?(reason)
      self.endHandler = nil
      self.client.close()
    }
  }
}
