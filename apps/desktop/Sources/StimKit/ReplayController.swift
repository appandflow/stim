import Combine
import Foundation

/// Replay of one device slot through stim-server, following the phone's `useReplayRange` and `useDeviceStream`.
/// It polls `replay.range` while `server` is set and opens a video subscription only to replay: Desktop shows the
/// live screen itself, so going live closes the subscription.
@MainActor public final class ReplayController: ObservableObject {
  /// The recorded frame shown and how it plays.
  public struct Replay: Equatable, Sendable {
    /// The capture time of the frame shown, epoch ms on the Mac's clock; nil until the first one arrives.
    public var at: Double?
    public var rate: Int
    /// Playback reached the newest recorded frame and paused there.
    public var ended: Bool
  }

  static let pollInterval: TimeInterval = 10
  static let positionInterval: TimeInterval = 0.2
  static let replayFps = 60.0

  public let target: ReplayTarget
  /// Null until the first answer, and from a server without replay.
  @Published public private(set) var range: ReplayRange?
  /// Nil while the live screen shows.
  @Published public private(set) var replay: Replay?
  /// Whether the server sends this device H.264 and so can replay; nil until a replay subscription is answered.
  @Published public private(set) var replayable: Bool?
  @Published public private(set) var error: String?
  /// The access units of the replay, in order; a keyframe carries its SPS and PPS.
  public var onVideo: (@MainActor (VideoPacket) -> Void)?

  private weak var server: ReplayServer?
  private let schedule: ServerScheduler
  private var cancelPoll: (() -> Void)?
  private var polls = (sent: 0, shown: 0)
  private var pollsSupported = true
  private var unsubscribe: (() -> Void)?
  private var subscriptionID: String?
  private var subscriptionGeneration = 0
  private var pendingSeek: (at: Double, rate: Int)?
  private var position: Double?
  private var cancelPosition: (() -> Void)?
  private var startAt: Double = 0

  public init(target: ReplayTarget, scheduler: @escaping ServerScheduler = ServerClient.dispatchAfter) {
    self.target = target
    self.schedule = scheduler
  }

  public var timeline: ReplayTimeline? { range.flatMap { ReplayTimeline(spans: $0.spans) } }

  /// Starts polling `server`, or with nil stops; a replay in progress stays until `live`, since its subscription
  /// is sent again when the connection comes back.
  public func connect(_ server: ReplayServer?) {
    guard server !== self.server else { return }
    let replayAt = replay.map { $0.at ?? startAt }
    closeSubscription()
    cancelPoll?()
    cancelPoll = nil
    self.server = server
    guard let server else { return }
    pollsSupported = true
    poll(server)
    if let replayAt { seek(at: replayAt, rate: 0) }
  }

  public func stop() {
    connect(nil)
    replay = nil
  }

  /// Shows the recorded frame at `at` and plays on at `rate`, 0 to pause. The first seek opens the replay
  /// subscription at `at`; a seek made before the server answers it waits for it.
  public func seek(at: Double, rate: Int) {
    guard let server else { return }
    error = nil
    guard let subscriptionID else {
      if unsubscribe != nil {
        pendingSeek = (at, rate)
        replay = Replay(at: replay?.at, rate: rate, ended: false)
        return
      }
      open(server, at: at, rate: rate)
      return
    }
    sendSeek(server, subscription: subscriptionID, at: at, rate: rate)
  }

  /// Returns to the live screen.
  public func live() {
    closeSubscription()
    replay = nil
    error = nil
  }

  private func poll(_ server: ReplayServer) {
    polls.sent += 1
    let sequence = polls.sent
    Task {
      do {
        let result = try await server.request("replay.range", target.params)
        guard server === self.server, sequence >= polls.shown else { return }
        polls.shown = sequence
        range = try JSONDecoder().decode(ReplayRange.self, from: JSONEncoder().encode(result))
      } catch let failure as ServerError where failure.code == "unknown-method" {
        if server === self.server {
          pollsSupported = false
          cancelPoll?()
          cancelPoll = nil
        }
      } catch {}
    }
    cancelPoll = schedule(Self.pollInterval) { [weak self, weak server] in
      guard let self, let server, server === self.server, self.pollsSupported else { return }
      self.poll(server)
    }
  }

  private func open(_ server: ReplayServer, at: Double, rate: Int) {
    subscriptionGeneration += 1
    let generation = subscriptionGeneration
    startAt = at
    replay = Replay(at: nil, rate: rate, ended: false)
    var firstRate = rate
    unsubscribe = server.subscribe(
      "frames.subscribe",
      params: { [weak self] in
        var params = self?.target.params ?? [:]
        params["video"] = .array([.string("h264")])
        params["fps"] = .number(Self.replayFps)
        params["at"] = .number(self?.replay?.at ?? self?.startAt ?? at)
        params["rate"] = .number(Double(firstRate))
        return params
      },
      onSubscribed: { [weak self] result in
        guard let self, generation == self.subscriptionGeneration else { return }
        guard result["video"]?.string == "h264" else {
          self.replayable = false
          self.closeSubscription()
          self.replay = nil
          self.error = "This stim-server sends no H.264 video, so it cannot replay."
          return
        }
        self.replayable = true
        self.subscriptionID = result["subscription"]?.string
        if self.replay?.rate != firstRate { self.replay?.rate = firstRate }
        firstRate = 0
        if let pending = self.pendingSeek, let id = self.subscriptionID {
          self.pendingSeek = nil
          self.sendSeek(server, subscription: id, at: pending.at, rate: pending.rate)
        }
      },
      onEvent: { [weak self] event in
        guard let self, generation == self.subscriptionGeneration else { return }
        switch event.name {
        case "replay-ended":
          let at = event.fields["at"]?.number ?? self.replay?.at
          self.position = at
          self.replay = Replay(at: at, rate: 0, ended: true)
        case "error" where event.subscription.isEmpty:
          let failure = event.error
          if failure?.code == "bad-request" { self.replayable = false }
          self.closeSubscription()
          self.replay = nil
          self.error = failure?.message
        case "error":
          self.subscriptionID = nil
          self.error = event.error?.message
        default: break
        }
      },
      onVideo: { [weak self] packet in
        guard let self, generation == self.subscriptionGeneration else { return }
        self.onVideo?(packet)
        self.track(packet.capturedAt)
      })
  }

  /// A seek the server refuses leaves the replay as it was, and an answer for a subscription since replaced is
  /// dropped.
  private func sendSeek(_ server: ReplayServer, subscription: String, at: Double, rate: Int) {
    let before = replay
    replay = Replay(at: replay?.at, rate: rate, ended: false)
    let generation = subscriptionGeneration
    Task {
      do {
        let result = try await server.request(
          "frames.seek", ["subscription": .string(subscription), "at": .number(at), "rate": .number(Double(rate))])
        guard generation == subscriptionGeneration, subscriptionID == subscription else { return }
        let shown = result.objectValue?["at"]?.number ?? at
        position = shown
        replay = Replay(at: shown, rate: rate, ended: false)
      } catch {
        guard generation == subscriptionGeneration, subscriptionID == subscription else { return }
        replay = before
        self.error = error.localizedDescription
      }
    }
  }

  /// Follows the frames played, publishing the position at most every 200 ms.
  private func track(_ capturedAt: Double) {
    position = capturedAt
    guard cancelPosition == nil else { return }
    if replay?.at == nil {
      replay?.at = capturedAt
    }
    cancelPosition = schedule(Self.positionInterval) { [weak self] in
      guard let self else { return }
      self.cancelPosition = nil
      if self.replay != nil, let position = self.position { self.replay?.at = position }
    }
  }

  private func closeSubscription() {
    subscriptionGeneration += 1
    unsubscribe?()
    unsubscribe = nil
    subscriptionID = nil
    pendingSeek = nil
    cancelPosition?()
    cancelPosition = nil
  }
}

extension JSONValue {
  var objectValue: [String: JSONValue]? {
    if case .object(let object) = self { return object }
    return nil
  }
}
