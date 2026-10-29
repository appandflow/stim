import Combine
import Foundation

/// A workspace's physical device or hosted simulator/app screen and control session through its local stim-server.
/// Physical devices use `physical: true`; hosted targets are resolved by workspace, platform and slot.
@MainActor public final class PhysicalStream: ObservableObject {
  public enum Control: Equatable, Sendable {
    /// `ended` says why the server or the connection ended the last session.
    case off(ended: String?)
    case starting
    case on(session: String)
    case failed(String)
  }

  public let target: ReplayTarget
  /// False for a hosted simulator or macOS app, which stim-server relays rather than reading a leased device.
  public let physical: Bool
  public private(set) var quality: StreamQuality
  /// Why no frames arrive: a refused or failed subscription, or the server's `frame-delayed` reason.
  @Published public private(set) var problem: String?
  @Published public private(set) var control = Control.off(ended: nil)
  /// Whether a frame arrived since the subscription opened.
  @Published public private(set) var receiving = false
  /// A macOS app's windows from the server's `macos-windows` event; nil before one arrives.
  @Published public private(set) var windows: MacosWindows?
  public var onVideo: (@MainActor (VideoPacket) -> Void)?
  /// A JPEG frame, from a server that falls back to screenshots for this device.
  public var onImage: (@MainActor (Data) -> Void)?

  private weak var server: DeviceServer?
  private var unsubscribe: (() -> Void)?
  private var unobserve: (() -> Void)?
  private var subscriptionID: String?
  private var generation = 0
  private var beginGeneration = 0
  private var pressed: (x: Double, y: Double)?
  private var keyframeRequest: Task<Void, Never>?

  public init(target: ReplayTarget, physical: Bool = true, quality: StreamQuality = .standard) {
    self.target = target
    self.physical = physical
    self.quality = quality
  }

  /// Resubscribes to the frames at `quality` without ending a control session.
  public func setQuality(_ quality: StreamQuality) {
    guard quality != self.quality else { return }
    self.quality = quality
    guard let server else { return }
    unsubscribe?()
    receiving = false
    problem = nil
    subscribeFrames(server)
  }

  /// Subscribes to the device's frames on `server`, or with nil stops. A new server ends the control session.
  public func connect(_ server: DeviceServer?) {
    guard server !== self.server else { return }
    close()
    switch control {
    case .on: control = .off(ended: "The connection to stim-server changed.")
    case .starting: control = .off(ended: nil)
    case .off, .failed: break
    }
    pressed = nil
    self.server = server
    guard let server else { return }
    unobserve = server.observeControlEnded { [weak self] ended in
      guard let self, case .on(let session) = self.control, ended.session == nil || ended.session == session else {
        return
      }
      self.pressed = nil
      self.control = .off(ended: ended.message)
    }
    subscribeFrames(server)
  }

  private func subscribeFrames(_ server: DeviceServer) {
    generation += 1
    let current = generation
    DebugLog.info(.stream, "frames subscribe \(target.params) \(quality.rawValue)")
    unsubscribe = server.subscribe(
      "frames.subscribe",
      params: { [target, physical, quality] in
        var params = target.params
        if physical { params["physical"] = .bool(true) }
        params["video"] = .array([.string("h264")])
        params["fps"] = .number(quality.fps)
        if let maxEdge = quality.maxEdge { params["maxEdge"] = .number(maxEdge) }
        return params
      },
      onSubscribed: { [weak self] result in
        guard let self, current == self.generation else { return }
        self.subscriptionID = result["subscription"]?.string
        self.problem = nil
      },
      onEvent: { [weak self] event in
        guard let self, current == self.generation else { return }
        switch event.name {
        case "frame":
          self.received()
          if let base64 = event.fields["data"]?.string, let data = Data(base64Encoded: base64) { self.onImage?(data) }
        case "macos-windows":
          self.windows = MacosWindows(event.fields)
        case "frame-delayed":
          self.problem =
            event.fields["delayed"] == .bool(true)
            ? event.fields["reason"]?.string ?? "The device's screen is slow to arrive." : nil
        case "error":
          self.subscriptionID = nil
          self.problem = event.error?.message
          DebugLog.error(.stream, "frames error \(target.params): \(event.error?.message ?? "unknown")")
        default: break
        }
      },
      onVideo: { [weak self] packet in
        guard let self, current == self.generation else { return }
        self.received()
        self.onVideo?(packet)
      })
  }

  public func stop() {
    DebugLog.info(.stream, "frames stop \(target.params)")
    end()
    connect(nil)
  }

  /// Asks for a keyframe after the decoder lost its state, while no earlier request is still unanswered, so a server
  /// that sends undecodable keyframes and never answers holds at most one request.
  public func requestKeyframe() {
    guard keyframeRequest == nil, let server, let subscriptionID else { return }
    let current = generation
    keyframeRequest = Task { [weak self] in
      _ = try? await server.request("frames.keyframe", ["subscription": .string(subscriptionID)])
      guard let self, current == self.generation else { return }
      self.keyframeRequest = nil
    }
  }

  /// Starts driving the device, taking it over from an agent that drives it. The server refuses a workspace that
  /// no longer owns the target session or holds the physical device's lease.
  public func begin() {
    guard let server else { return }
    switch control {
    case .starting, .on: return
    case .off, .failed: break
    }
    beginGeneration += 1
    let current = beginGeneration
    control = .starting
    var params = target.params
    if physical { params["physical"] = .bool(true) }
    params["takeOver"] = .bool(true)
    Task {
      do {
        let result = try await server.request("control.begin", params)
        guard let session = result.objectValue?["session"]?.string else { throw ControlBeginFailure() }
        guard current == beginGeneration, control == .starting, server === self.server else {
          _ = try? await server.request("control.end", ["session": .string(session)])
          return
        }
        control = .on(session: session)
      } catch {
        guard current == beginGeneration, control == .starting, server === self.server else { return }
        control = .failed(error.localizedDescription)
        DebugLog.error(.stream, "control begin failed \(target.params): \(error.localizedDescription)")
      }
    }
  }

  /// Ends the session, lifting a finger still down first. A message from a session that already ended stays.
  public func end() {
    beginGeneration += 1
    switch control {
    case .on(let session):
      if let pressed { touch("up", x: pressed.x, y: pressed.y) }
      if let server { Task { _ = try? await server.request("control.end", ["session": .string(session)]) } }
    case .starting: break
    case .off, .failed: return
    }
    pressed = nil
    control = .off(ended: nil)
  }

  /// `x` and `y` are fractions of the upright screen, origin top-left.
  public func touch(_ phase: String, x: Double, y: Double) {
    guard case .on = control else { return }
    pressed = phase == "up" ? nil : (x, y)
    send("input.touch", ["phase": .string(phase), "x": .number(x), "y": .number(y)])
  }

  public func text(_ text: String) {
    send("input.text", ["text": .string(text)])
  }

  /// Pins the view to a macOS app's window `id`, bringing it to the front, or with nil follows its front window.
  public func selectWindow(_ id: Int?) {
    send("input.window", ["window": id.map { .number(Double($0)) } ?? .null])
  }

  /// `home`, `back`, `app-switch` or `lock`.
  public func button(_ button: String) {
    send("input.button", ["button": .string(button)])
  }

  private func send(_ method: String, _ params: [String: JSONValue]) {
    guard let server, case .on(let session) = control else { return }
    var params = params
    params["session"] = .string(session)
    Task { _ = try? await server.request(method, params) }
  }

  private func received() {
    if problem != nil { problem = nil }
    if !receiving { receiving = true }
  }

  private func close() {
    generation += 1
    keyframeRequest?.cancel()
    keyframeRequest = nil
    unsubscribe?()
    unsubscribe = nil
    unobserve?()
    unobserve = nil
    subscriptionID = nil
    problem = nil
    receiving = false
    windows = nil
  }
}

/// The windows of a macOS app that a frames subscription shows, front to back. `current` is the captured one: the
/// front window, or while `pinned` the one a controller chose.
public struct MacosWindows: Equatable, Sendable {
  public struct Window: Equatable, Sendable, Identifiable {
    public var id: Int
    public var title: String

    public init(id: Int, title: String) {
      self.id = id
      self.title = title
    }
  }

  public var current: Int?
  public var windows: [Window]
  public var pinned: Bool

  init(_ fields: [String: JSONValue]) {
    let window = { (value: JSONValue?) -> Window? in
      guard case .object(let object)? = value, let id = object["id"]?.number.flatMap(ServerProtocol.exactInteger) else {
        return nil
      }
      return Window(id: id, title: object["title"]?.string ?? "")
    }
    current = window(fields["current"])?.id
    if case .array(let list)? = fields["windows"] { windows = list.compactMap(window) } else { windows = [] }
    pinned = fields["pinned"] == .bool(true)
  }
}

struct ControlBeginFailure: LocalizedError {
  var errorDescription: String? { "stim-server answered control.begin without a session." }
}
