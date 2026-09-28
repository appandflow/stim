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
  /// Still frames for hovering the track, from the same server.
  public let previews: ReplayPreviews

  private weak var server: ReplayServer?
  private let schedule: ServerScheduler
  private var cancelPoll: (() -> Void)?
  private var polls = (sent: 0, shown: 0)
  private var pollsSupported = true
  private var unsubscribe: (() -> Void)?
  private var subscriptionID: String?
  private var subscriptionGeneration = 0
  private var seeks = ReplaySeekQueue()
  private var cancelFlush: (() -> Void)?
  private var confirmed: Replay?
  private var cancelDropWatch: (() -> Void)?
  private let clock: () -> TimeInterval
  private var position: Double?
  private var cancelPosition: (() -> Void)?
  private var startAt: Double = 0

  public init(
    target: ReplayTarget, scheduler: @escaping ServerScheduler = ServerClient.dispatchAfter,
    clock: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }
  ) {
    self.target = target
    self.schedule = scheduler
    self.clock = clock
    previews = ReplayPreviews(target: target)
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
    previews.connect(server)
    cancelDropWatch?()
    cancelDropWatch = nil
    guard let server else { return }
    if let device = server as? DeviceServer {
      cancelDropWatch = device.observeControlEnded { [weak self] ended in
        guard let self, ended.session == nil, self.subscriptionID != nil else { return }
        self.subscriptionID = nil
        self.seeks.interrupt()
      }
    }
    pollsSupported = true
    poll(server)
    if let replayAt { seek(at: replayAt, rate: 0) }
  }

  public func stop() {
    connect(nil)
    replay = nil
  }

  /// Shows the recorded frame at `at` and plays on at `rate`, 0 to pause. The first seek opens the replay
  /// subscription at `at`. `replay.at` moves to `at` at once and to the frame the server shows once it answers.
  /// Seeks are coalesced: while one is out, only the latest seek asked for waits, and it goes out when the server
  /// answers, at most every `ReplaySeekQueue.minimumInterval`. A seek made while the subscription opens, or while
  /// the connection comes back, waits for the new subscription.
  public func seek(at: Double, rate: Int) {
    guard let server else { return }
    error = nil
    guard subscriptionID != nil || unsubscribe != nil else {
      open(server, at: at, rate: rate)
      return
    }
    replay = Replay(at: at, rate: rate, ended: false)
    seeks.ask(ReplaySeekQueue.Seek(at: at, rate: rate))
    flush(server)
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
    confirmed = replay
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
        if self.seeks.isSettled, self.replay?.rate != firstRate { self.replay?.rate = firstRate }
        firstRate = 0
        self.seeks.interrupt()
        self.flush(server)
      },
      onEvent: { [weak self] event in
        guard let self, generation == self.subscriptionGeneration else { return }
        switch event.name {
        case "replay-ended":
          let at = event.fields["at"]?.number ?? self.replay?.at
          self.position = at
          self.show(Replay(at: at, rate: 0, ended: true))
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

  /// Sends the waiting seek when it may go out, or schedules it for when `ReplaySeekQueue.minimumInterval` allows.
  private func flush(_ server: ReplayServer) {
    cancelFlush?()
    cancelFlush = nil
    let now = clock()
    let open = subscriptionID != nil
    if let subscriptionID, let seek = seeks.next(now: now, open: open) {
      sendSeek(server, subscription: subscriptionID, seek)
    } else if let delay = seeks.delay(now: now, open: open) {
      cancelFlush = schedule(delay) { [weak self, weak server] in
        guard let self, let server, server === self.server else { return }
        self.cancelFlush = nil
        self.flush(server)
      }
    }
  }

  /// Only the answer to the latest seek moves the replay. A seek the server refuses leaves the replay as it was
  /// confirmed; one lost with the connection, or sent on a subscription the server no longer has, waits for the next
  /// subscription.
  private func sendSeek(_ server: ReplayServer, subscription: String, _ seek: ReplaySeekQueue.Seek) {
    let generation = subscriptionGeneration
    Task {
      do {
        let result = try await server.request(
          "frames.seek",
          ["subscription": .string(subscription), "at": .number(seek.at), "rate": .number(Double(seek.rate))])
        guard generation == subscriptionGeneration, subscriptionID == subscription else { return }
        if seeks.finish() {
          let shown = result.objectValue?["at"]?.number ?? seek.at
          position = shown
          show(Replay(at: shown, rate: seek.rate, ended: false))
        }
        flush(server)
      } catch let failure as ServerError
        where ["not-connected", "connection-lost", "unknown-subscription"].contains(failure.code)
      {
        guard generation == subscriptionGeneration, subscriptionID == subscription else { return }
        subscriptionID = nil
        seeks.interrupt()
      } catch {
        guard generation == subscriptionGeneration, subscriptionID == subscription else { return }
        if seeks.finish() {
          replay = confirmed
          self.error = error.localizedDescription
        }
        flush(server)
      }
    }
  }

  private func show(_ replay: Replay) {
    self.replay = replay
    confirmed = replay
  }

  /// Follows the frames played, publishing the position at most every 200 ms. Frames that arrive while a seek is
  /// out come from the keyframe before its target and would move the position back, so they are not followed.
  private func track(_ capturedAt: Double) {
    guard seeks.isSettled else { return }
    position = capturedAt
    guard cancelPosition == nil else { return }
    if replay?.at == nil {
      replay?.at = capturedAt
      confirmed?.at = capturedAt
    }
    cancelPosition = schedule(Self.positionInterval) { [weak self] in
      guard let self else { return }
      self.cancelPosition = nil
      guard self.replay != nil, self.seeks.isSettled, let position = self.position else { return }
      self.replay?.at = position
      self.confirmed?.at = position
    }
  }

  private func closeSubscription() {
    subscriptionGeneration += 1
    unsubscribe?()
    unsubscribe = nil
    subscriptionID = nil
    seeks.clear()
    cancelFlush?()
    cancelFlush = nil
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
