import Combine
import Foundation

/// The live screen of a workspace's leased physical device through stim-server, and for an Android phone the control
/// session that drives it, following the phone's `useDeviceStream` and `useDeviceControl` with `physical: true`.
@MainActor public final class PhysicalStream: ObservableObject {
  public enum Control: Equatable, Sendable {
    /// `ended` says why the server or the connection ended the last session.
    case off(ended: String?)
    case starting
    case on(session: String)
    case failed(String)
  }

  static let fps = 30.0

  public let target: ReplayTarget
  /// Why no frames arrive: a refused or failed subscription, or the server's `frame-delayed` reason.
  @Published public private(set) var problem: String?
  @Published public private(set) var control = Control.off(ended: nil)
  /// Whether a frame arrived since the subscription opened.
  @Published public private(set) var receiving = false
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

  public init(target: ReplayTarget) {
    self.target = target
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
    generation += 1
    let current = generation
    unobserve = server.observeControlEnded { [weak self] ended in
      guard let self, case .on(let session) = self.control, ended.session == nil || ended.session == session else {
        return
      }
      self.pressed = nil
      self.control = .off(ended: ended.message)
    }
    unsubscribe = server.subscribe(
      "frames.subscribe",
      params: { [target] in
        var params = target.params
        params["physical"] = .bool(true)
        params["video"] = .array([.string("h264")])
        params["fps"] = .number(Self.fps)
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
        case "frame-delayed":
          self.problem =
            event.fields["delayed"] == .bool(true)
            ? event.fields["reason"]?.string ?? "The device's screen is slow to arrive." : nil
        case "error":
          self.subscriptionID = nil
          self.problem = event.error?.message
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
    end()
    connect(nil)
  }

  /// Asks for a keyframe after the decoder lost its state.
  public func requestKeyframe() {
    guard let server, let subscriptionID else { return }
    Task { _ = try? await server.request("frames.keyframe", ["subscription": .string(subscriptionID)]) }
  }

  /// Starts driving the device, taking it over from an agent that drives it. The server refuses a workspace that
  /// no longer holds the device's lease.
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
    params["physical"] = .bool(true)
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
    unsubscribe?()
    unsubscribe = nil
    unobserve?()
    unobserve = nil
    subscriptionID = nil
    problem = nil
    receiving = false
  }
}

struct ControlBeginFailure: LocalizedError {
  var errorDescription: String? { "stim-server answered control.begin without a session." }
}
