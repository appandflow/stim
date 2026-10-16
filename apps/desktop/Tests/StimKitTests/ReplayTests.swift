import Foundation
import Testing

@testable import StimKit

private func fixture(_ name: String) throws -> Data {
  try Data(contentsOf: Bundle.module.url(forResource: "Fixtures/\(name)", withExtension: nil)!)
}

@MainActor func settle() async {
  for _ in 0..<20 { await Task.yield() }
}

@MainActor private final class ManualScheduler {
  var work: [(delay: TimeInterval, run: @MainActor () -> Void, cancelled: Bool)] = []

  var schedule: ServerScheduler {
    { delay, run in
      let index = self.work.count
      self.work.append((delay, run, false))
      return { self.work[index].cancelled = true }
    }
  }

  func fire(delay: TimeInterval) {
    let due = work.indices.filter { work[$0].delay == delay && !work[$0].cancelled }
    for index in due {
      work[index].cancelled = true
      work[index].run()
    }
  }
}

@MainActor final class FakeServer: DeviceServer {
  struct Request {
    var method: String
    var params: [String: JSONValue]
    var reply: CheckedContinuation<JSONValue, Error>
  }

  final class Sub {
    var params: @MainActor () -> [String: JSONValue]
    var onSubscribed: @MainActor ([String: JSONValue]) -> Void
    var onEvent: @MainActor (ServerEvent) -> Void
    var onVideo: @MainActor (VideoPacket) -> Void
    var cancelled = false

    init(
      params: @escaping @MainActor () -> [String: JSONValue],
      onSubscribed: @escaping @MainActor ([String: JSONValue]) -> Void,
      onEvent: @escaping @MainActor (ServerEvent) -> Void, onVideo: @escaping @MainActor (VideoPacket) -> Void
    ) {
      self.params = params
      self.onSubscribed = onSubscribed
      self.onEvent = onEvent
      self.onVideo = onVideo
    }
  }

  var requests: [Request] = []
  var subs: [Sub] = []
  var controlObservers: [@MainActor (ControlEnded) -> Void] = []

  func request(_ method: String, _ params: [String: JSONValue]) async throws -> JSONValue {
    try await withCheckedThrowingContinuation { requests.append(Request(method: method, params: params, reply: $0)) }
  }

  func subscribe(
    _ method: String, params: @escaping @MainActor () -> [String: JSONValue],
    onSubscribed: @escaping @MainActor ([String: JSONValue]) -> Void,
    onEvent: @escaping @MainActor (ServerEvent) -> Void, onVideo: @escaping @MainActor (VideoPacket) -> Void
  ) -> () -> Void {
    let sub = Sub(params: params, onSubscribed: onSubscribed, onEvent: onEvent, onVideo: onVideo)
    subs.append(sub)
    return { sub.cancelled = true }
  }

  func observeControlEnded(_ onEnded: @escaping @MainActor (ControlEnded) -> Void) -> () -> Void {
    controlObservers.append(onEnded)
    return {}
  }

  func take(_ method: String) -> Request? {
    guard let index = requests.firstIndex(where: { $0.method == method }) else { return nil }
    return requests.remove(at: index)
  }
}

private func range(spans: [ReplaySpan], recording: Bool = true) -> JSONValue {
  .object([
    "enabled": .bool(true), "recording": .bool(recording),
    "spans": .array(spans.map { .object(["start": .number($0.start), "end": .number($0.end)]) }),
    "markers": .array([]),
  ])
}

private let target = ReplayTarget(workspace: "/work/app", platform: "ios", slot: "default")

@MainActor private final class TickingClock {
  var now = 0.0
  var step = 1.0

  var read: () -> TimeInterval {
    {
      defer { self.now += self.step }
      return self.now
    }
  }
}

@Suite struct ReplayTimelineTests {
  let minute = 60_000.0
  var hour: Double { 60 * minute }
  var spans: [ReplaySpan] { [ReplaySpan(start: 0, end: 4 * minute), ReplaySpan(start: 2 * hour, end: 2 * hour + 6 * minute)] }

  struct Vectors: Decodable {
    struct Case: Decodable {
      struct Input: Decodable {
        var spans: [ReplaySpan]
        var liveEnd: Double?
        var previousLength: Double?
        var fit: Bool?
      }
      struct Piece: Decodable {
        var kind: String
        var start, end, from, to: Double
        var collapsed: Bool?
      }
      struct Timeline: Decodable {
        var start, end, length: Double
        var pieces: [Piece]
      }
      var name: String
      var input: Input
      var timeline: Timeline
      var positions: [[Double]]
      var times: [[Double]]
    }
    var timelines: [Case]
  }

  static let vectors: Vectors = {
    let url = Bundle.module.url(
      forResource: "replay-timeline-vectors", withExtension: "json", subdirectory: "Fixtures")!
    return try! JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
  }()

  func close(_ a: Double, _ b: Double) -> Bool { abs(a - b) < 1e-9 * max(1, abs(b)) }

  @Test(arguments: Self.vectors.timelines.map(\.name))
  func laysTheTrackOutAsThePhoneDoes(_ name: String) throws {
    let vector = try #require(Self.vectors.timelines.first { $0.name == name })
    let timeline = try #require(
      ReplayTimeline(
        spans: vector.input.spans, liveEnd: vector.input.liveEnd, previousLength: vector.input.previousLength,
        fit: vector.input.fit ?? false))
    #expect(timeline.start == vector.timeline.start && timeline.end == vector.timeline.end)
    #expect(timeline.length == vector.timeline.length)
    #expect(timeline.pieces.count == vector.timeline.pieces.count)
    for (piece, expected) in zip(timeline.pieces, vector.timeline.pieces) {
      #expect(piece.isGap == (expected.kind == "gap"))
      #expect(piece.start == expected.start && piece.end == expected.end)
      #expect(close(piece.from, expected.from) && close(piece.to, expected.to))
      #expect(piece.collapsed == (expected.collapsed ?? false))
    }
    for pair in vector.positions {
      #expect(close(timeline.position(of: pair[0]), pair[1]), "position of \(pair[0])")
    }
    for pair in vector.times {
      #expect(close(timeline.time(at: pair[0]), pair[1]), "time at \(pair[0])")
    }
  }

  @Test func countsOnlyRecordedFootageAndIsNilWithoutAny() throws {
    let timeline = try #require(ReplayTimeline(spans: spans, liveEnd: 3 * hour))
    #expect(timeline.recordedLength == 10 * minute)
    #expect(ReplayTimeline(spans: []) == nil)
  }

  @Test func landsALittleBeforeAMarkerButNotBeforeItsSpan() throws {
    let timeline = try #require(ReplayTimeline(spans: spans))
    #expect(timeline.seekTime(for: ReplayMarker(at: 2 * minute, kind: "action", label: "Tapped")) == 2 * minute - 1500)
    #expect(timeline.seekTime(for: ReplayMarker(at: 2 * hour + 500, kind: "error", label: "boom")) == 2 * hour)
    #expect(timeline.seekTime(forActionAt: 2 * minute) == 2 * minute - 1500)
    #expect(timeline.seekTime(forActionAt: 2 * hour + 500) == 2 * hour)
    #expect(timeline.seekTime(forActionAt: hour) == nil)
    #expect([40_000, 14 * minute, 2 * hour, 72 * hour].map(Format.roundedDuration(ms:)) == ["40s", "14m", "2h", "3d"])
  }

  @Test func stepsToTheNextOrPreviousAgentActionSkippingErrorsAndTheActionItStandsOn() {
    let markers = [
      ReplayMarker(at: 30_000, kind: "action", label: "tap Settings"),
      ReplayMarker(at: 10_000, kind: "action", label: "open app"),
      ReplayMarker(at: 20_000, kind: "error", label: "boom"),
      ReplayMarker(at: 50_000, kind: "action", label: "type hi"),
    ]
    let step = { (from: Double, forward: Bool) in
      ReplayTimeline.adjacentAction(markers, from: from, forward: forward)?.at
    }
    #expect(step(12_000, true) == 30_000)
    #expect(step(30_000, true) == 50_000)
    #expect(step(50_000, true) == nil)
    #expect(step(40_000, false) == 30_000)
    #expect(step(30_000, false) == 10_000)
    #expect(step(10_000, false) == nil)
    #expect(ReplayTimeline.adjacentAction([], from: 0, forward: true) == nil)
  }

  @Test func stepsFromTheActionItLandedBeforeUntilThePlayheadPassesIt() {
    #expect(ReplayTimeline.stepFrom(26_500, stepped: 30_000, playing: true) == 30_000)
    #expect(ReplayTimeline.stepFrom(31_000, stepped: 30_000, playing: true) == 31_000)
    #expect(ReplayTimeline.stepFrom(40_000, stepped: 30_000, playing: false) == 30_000)
    #expect(ReplayTimeline.stepFrom(12_000, stepped: nil, playing: false) == 12_000)
  }
}

@Suite struct ServerProtocolTests {
  @Test func parsesAVideoPacketStimServerSent() throws {
    let data = try fixture("replay-packet.bin")
    let packet = try #require(VideoPacket(data))
    #expect(packet.subscription == "s1" && packet.keyframe && packet.sequence == 0)
    #expect(packet.width == 330 && packet.height == 720)
    #expect(packet.capturedAt == 1_790_608_626_466.9521)
    #expect(packet.accessUnit.count == data.count - 23)
    #expect(packet.accessUnit.prefix(4) == Data([0, 0, 0, 1]))
    #expect(VideoPacket(data.prefix(22)) == nil)
    var otherVersion = data
    otherVersion[0] = 2
    #expect(VideoPacket(otherVersion) == nil)
  }

  @Test func decodesAReplayRangeStimServerAnswered() throws {
    let range = try JSONDecoder().decode(ReplayRange.self, from: fixture("replay-range.json"))
    #expect(range.enabled && !range.recording && range.spans.count == 1)
    #expect(
      range.markers.first == ReplayMarker(at: 1_790_608_621_703, kind: "action", command: "press", label: "Tapped (38, 84)"))
    #expect(range.markers.contains { $0.kind == "error" && $0.title == "Error" })
  }
}

@Suite @MainActor struct ReplayControllerTests {
  @Test func dropsARangeAnswerOlderThanTheOneShown() async throws {
    let scheduler = ManualScheduler()
    let server = FakeServer()
    let controller = ReplayController(target: target, scheduler: scheduler.schedule)
    controller.connect(server)
    await settle()
    scheduler.fire(delay: ReplayController.pollInterval)
    await settle()
    let first = try #require(server.take("replay.range"))
    let second = try #require(server.take("replay.range"))
    #expect(first.params["workspace"] == .string("/work/app") && first.params["slot"] == .string("default"))
    second.reply.resume(returning: range(spans: [ReplaySpan(start: 0, end: 20_000)]))
    await settle()
    first.reply.resume(returning: range(spans: [ReplaySpan(start: 0, end: 10_000)]))
    await settle()
    #expect(controller.range?.spans == [ReplaySpan(start: 0, end: 20_000)])
  }

  @Test func endsTheTrackAtTheMacsTimeNowOnlyWhileTheRunningDeviceIsRecorded() async throws {
    let server = FakeServer()
    var now = 100.0
    let controller = ReplayController(target: target, scheduler: ManualScheduler().schedule, clock: { now })
    controller.connect(server)
    await settle()
    try #require(server.take("replay.range")).reply.resume(returning: range(spans: [ReplaySpan(start: 0, end: 20_000)]))
    await settle()
    now = 103.5
    #expect(controller.liveEnd(running: true) == 23_500)
    #expect(controller.liveEnd(running: false) == nil)
    controller.connect(nil)
    #expect(controller.liveEnd(running: true) == nil)
    controller.connect(server)
    await settle()
    try #require(server.take("replay.range")).reply.resume(
      returning: range(spans: [ReplaySpan(start: 0, end: 20_000)], recording: false))
    await settle()
    #expect(controller.liveEnd(running: true) == nil)
  }

  @Test func stopsPollingAServerWithoutReplay() async throws {
    let scheduler = ManualScheduler()
    let server = FakeServer()
    let controller = ReplayController(target: target, scheduler: scheduler.schedule)
    controller.connect(server)
    await settle()
    try #require(server.take("replay.range")).reply.resume(
      throwing: ServerError(code: "unknown-method", message: "Unknown method replay.range."))
    await settle()
    scheduler.fire(delay: ReplayController.pollInterval)
    await settle()
    #expect(server.take("replay.range") == nil)
    #expect(controller.range == nil)
  }

  @Test func opensTheReplayAtTheSeekAndKeepsTheEndAfterTheSeekAnswer() async throws {
    let server = FakeServer()
    let controller = ReplayController(target: target, scheduler: ManualScheduler().schedule)
    var shown: [Double] = []
    controller.onVideo = { shown.append($0.capturedAt) }
    controller.connect(server)
    controller.seek(at: 5_000, rate: 0)
    let sub = try #require(server.subs.first)
    let params = sub.params()
    #expect(params["at"] == .number(5_000) && params["rate"] == .number(0) && params["video"] == .array([.string("h264")]))
    #expect(controller.replay == ReplayController.Replay(at: nil, rate: 0, ended: false))
    sub.onSubscribed(["subscription": .string("s1"), "video": .string("h264")])
    #expect(controller.replayable == true)
    sub.onVideo(try #require(VideoPacket(fixture("replay-packet.bin"))))
    #expect(shown.count == 1 && controller.replay?.at == 1_790_608_626_466.9521)

    controller.seek(at: 9_000, rate: 2)
    #expect(controller.replay?.rate == 2)
    await settle()
    let seek = try #require(server.take("frames.seek"))
    #expect(seek.params == ["subscription": .string("s1"), "at": .number(9_000), "rate": .number(2)])
    seek.reply.resume(returning: .object(["at": .number(8_950)]))
    await settle()
    #expect(controller.replay == ReplayController.Replay(at: 8_950, rate: 2, ended: false))
    sub.onEvent(ServerEvent(name: "replay-ended", subscription: "s1", fields: ["at": .number(10_000)]))
    #expect(controller.replay == ReplayController.Replay(at: 10_000, rate: 0, ended: true))

    controller.live()
    #expect(sub.cancelled && controller.replay == nil)
  }

  @Test func refusesToReplayWhenTheServerAnswersWithoutH264() async throws {
    let server = FakeServer()
    let controller = ReplayController(target: target, scheduler: ManualScheduler().schedule)
    controller.connect(server)
    controller.seek(at: 5_000, rate: 0)
    let sub = try #require(server.subs.first)
    sub.onSubscribed(["subscription": .string("s1")])
    #expect(controller.replayable == false && controller.replay == nil && sub.cancelled)
    #expect(controller.error != nil)
  }

  @Test func aRefusedReplayOpenLeavesTheLiveScreenAndTheNextSeekTriesAgain() async throws {
    let server = FakeServer()
    let controller = ReplayController(target: target, scheduler: ManualScheduler().schedule)
    controller.connect(server)
    controller.seek(at: 5_000, rate: 0)
    let refusal: JSONValue = .object([
      "code": .string("bad-request"), "message": .string("Replay needs a video subscription: pass video: [\"h264\"]."),
    ])
    server.subs[0].onEvent(ServerEvent(name: "error", subscription: "", fields: ["error": refusal]))
    #expect(server.subs[0].cancelled && controller.replay == nil && controller.replayable == false)
    #expect(controller.error?.hasPrefix("Replay needs a video subscription") == true)
    controller.seek(at: 6_000, rate: 0)
    #expect(server.subs.count == 2)
  }

  @Test func aRefusedSeekLeavesTheReplayAsItWas() async throws {
    let server = FakeServer()
    let controller = ReplayController(
      target: target, scheduler: ManualScheduler().schedule, clock: TickingClock().read)
    controller.connect(server)
    controller.seek(at: 5_000, rate: 0)
    let sub = try #require(server.subs.first)
    sub.onSubscribed(["subscription": .string("s1"), "video": .string("h264")])
    controller.seek(at: 6_000, rate: 0)
    await settle()
    try #require(server.take("frames.seek")).reply.resume(returning: .object(["at": .number(6_000)]))
    await settle()
    controller.seek(at: 7_000, rate: 1)
    await settle()
    try #require(server.take("frames.seek")).reply.resume(
      throwing: ServerError(code: "no-recording", message: "Nothing was recorded for this device."))
    await settle()
    #expect(controller.replay == ReplayController.Replay(at: 6_000, rate: 0, ended: false))
    #expect(controller.error == "Nothing was recorded for this device.")
  }

  @Test func aSeekMadeWhileTheSubscriptionOpensWaitsForIt() async throws {
    let server = FakeServer()
    let controller = ReplayController(target: target, scheduler: ManualScheduler().schedule)
    controller.connect(server)
    controller.seek(at: 5_000, rate: 0)
    controller.seek(at: 7_000, rate: 1)
    #expect(server.subs.count == 1)
    await settle()
    #expect(server.take("frames.seek") == nil)
    server.subs[0].onSubscribed(["subscription": .string("s1"), "video": .string("h264")])
    await settle()
    let seek = try #require(server.take("frames.seek"))
    #expect(seek.params["at"] == .number(7_000) && seek.params["rate"] == .number(1))
  }

  @Test func resubscribesPausedAtTheFrameShown() async throws {
    let server = FakeServer()
    let controller = ReplayController(target: target, scheduler: ManualScheduler().schedule)
    controller.connect(server)
    controller.seek(at: 5_000, rate: 2)
    let sub = try #require(server.subs.first)
    sub.onSubscribed(["subscription": .string("s1"), "video": .string("h264")])
    sub.onVideo(try #require(VideoPacket(fixture("replay-packet.bin"))))
    let params = sub.params()
    #expect(params["at"] == .number(1_790_608_626_466.9521) && params["rate"] == .number(0))
    sub.onSubscribed(["subscription": .string("s2"), "video": .string("h264")])
    #expect(controller.replay?.rate == 0)
  }

  @Test func aDragSendsOnlyTheLatestSeekOnceTheOneOutIsAnswered() async throws {
    let server = FakeServer()
    let controller = ReplayController(
      target: target, scheduler: ManualScheduler().schedule, clock: TickingClock().read)
    controller.connect(server)
    controller.seek(at: 5_000, rate: 0)
    server.subs[0].onSubscribed(["subscription": .string("s1"), "video": .string("h264")])
    controller.seek(at: 6_000, rate: 0)
    controller.seek(at: 6_500, rate: 0)
    controller.seek(at: 7_000, rate: 0)
    await settle()
    let first = try #require(server.take("frames.seek"))
    #expect(first.params["at"] == .number(6_000) && server.take("frames.seek") == nil)
    #expect(controller.replay?.at == 7_000)
    first.reply.resume(returning: .object(["at": .number(5_990)]))
    await settle()
    #expect(controller.replay?.at == 7_000)
    let latest = try #require(server.take("frames.seek"))
    #expect(latest.params["at"] == .number(7_000) && server.take("frames.seek") == nil)
    latest.reply.resume(returning: .object(["at": .number(6_980)]))
    await settle()
    #expect(controller.replay == ReplayController.Replay(at: 6_980, rate: 0, ended: false))
  }

  @Test func seeksGoOutAtMostEveryMinimumInterval() async throws {
    let scheduler = ManualScheduler()
    let clock = TickingClock()
    clock.step = 0
    let server = FakeServer()
    let controller = ReplayController(target: target, scheduler: scheduler.schedule, clock: clock.read)
    controller.connect(server)
    controller.seek(at: 5_000, rate: 0)
    server.subs[0].onSubscribed(["subscription": .string("s1"), "video": .string("h264")])
    controller.seek(at: 6_000, rate: 0)
    await settle()
    try #require(server.take("frames.seek")).reply.resume(returning: .object(["at": .number(6_000)]))
    await settle()
    controller.seek(at: 7_000, rate: 0)
    await settle()
    #expect(server.take("frames.seek") == nil)
    clock.now = ReplaySeekQueue.minimumInterval
    scheduler.fire(delay: ReplaySeekQueue.minimumInterval)
    await settle()
    #expect(try #require(server.take("frames.seek")).params["at"] == .number(7_000))
  }

  @Test func framesResentForASeekDoNotMoveThePositionBack() async throws {
    let scheduler = ManualScheduler()
    let server = FakeServer()
    let controller = ReplayController(target: target, scheduler: scheduler.schedule, clock: TickingClock().read)
    var shown = 0
    controller.onVideo = { _ in shown += 1 }
    controller.connect(server)
    controller.seek(at: 5_000, rate: 0)
    server.subs[0].onSubscribed(["subscription": .string("s1"), "video": .string("h264")])
    controller.seek(at: 1_790_608_630_000, rate: 0)
    await settle()
    server.subs[0].onVideo(try #require(VideoPacket(fixture("replay-packet.bin"))))
    scheduler.fire(delay: ReplayController.positionInterval)
    #expect(shown == 1 && controller.replay?.at == 1_790_608_630_000)
    try #require(server.take("frames.seek")).reply.resume(returning: .object(["at": .number(1_790_608_629_990)]))
    await settle()
    #expect(controller.replay?.at == 1_790_608_629_990)
  }

  @Test func aSeekLostWithTheConnectionGoesOutOnTheNextSubscription() async throws {
    let server = FakeServer()
    let controller = ReplayController(
      target: target, scheduler: ManualScheduler().schedule, clock: TickingClock().read)
    controller.connect(server)
    controller.seek(at: 5_000, rate: 0)
    let sub = try #require(server.subs.first)
    sub.onSubscribed(["subscription": .string("s1"), "video": .string("h264")])
    controller.seek(at: 6_000, rate: 1)
    await settle()
    try #require(server.take("frames.seek")).reply.resume(
      throwing: ServerError(code: "connection-lost", message: "Connection lost."))
    await settle()
    controller.seek(at: 7_000, rate: 0)
    await settle()
    #expect(server.take("frames.seek") == nil && controller.error == nil)
    #expect(controller.replay == ReplayController.Replay(at: 7_000, rate: 0, ended: false))
    sub.onSubscribed(["subscription": .string("s2"), "video": .string("h264")])
    await settle()
    let seek = try #require(server.take("frames.seek"))
    #expect(seek.params == ["subscription": .string("s2"), "at": .number(7_000), "rate": .number(0)])
  }

  @Test func aSeekMadeWhileTheConnectionIsDownWaitsForTheNextSubscription() async throws {
    let server = FakeServer()
    let controller = ReplayController(
      target: target, scheduler: ManualScheduler().schedule, clock: TickingClock().read)
    controller.connect(server)
    controller.seek(at: 5_000, rate: 0)
    let sub = try #require(server.subs.first)
    sub.onSubscribed(["subscription": .string("s1"), "video": .string("h264")])
    for observer in server.controlObservers {
      observer(ControlEnded(session: nil, reason: "failed", message: "Connection lost."))
    }
    controller.seek(at: 7_000, rate: 0)
    await settle()
    #expect(server.take("frames.seek") == nil && controller.error == nil)
    sub.onSubscribed(["subscription": .string("s1"), "video": .string("h264")])
    await settle()
    #expect(try #require(server.take("frames.seek")).params["at"] == .number(7_000))
  }

  @Test func aSeekTheServerNoLongerKnowsTheSubscriptionOfWaitsForTheNextOne() async throws {
    let server = FakeServer()
    let controller = ReplayController(
      target: target, scheduler: ManualScheduler().schedule, clock: TickingClock().read)
    controller.connect(server)
    controller.seek(at: 5_000, rate: 0)
    let sub = try #require(server.subs.first)
    sub.onSubscribed(["subscription": .string("s1"), "video": .string("h264")])
    controller.seek(at: 6_000, rate: 0)
    await settle()
    try #require(server.take("frames.seek")).reply.resume(
      throwing: ServerError(code: "unknown-subscription", message: "No video subscription s1."))
    await settle()
    #expect(controller.error == nil && controller.replay?.at == 6_000)
    sub.onSubscribed(["subscription": .string("s2"), "video": .string("h264")])
    await settle()
    #expect(try #require(server.take("frames.seek")).params["subscription"] == .string("s2"))
  }

  @Test func aRefusedSeekWithANewerOneWaitingSendsTheNewerOneWithoutAnError() async throws {
    let server = FakeServer()
    let controller = ReplayController(
      target: target, scheduler: ManualScheduler().schedule, clock: TickingClock().read)
    controller.connect(server)
    controller.seek(at: 5_000, rate: 0)
    server.subs[0].onSubscribed(["subscription": .string("s1"), "video": .string("h264")])
    controller.seek(at: 6_000, rate: 0)
    controller.seek(at: 7_000, rate: 0)
    await settle()
    try #require(server.take("frames.seek")).reply.resume(
      throwing: ServerError(code: "no-recording", message: "Nothing was recorded for this device."))
    await settle()
    #expect(controller.error == nil && controller.replay?.at == 7_000)
    #expect(try #require(server.take("frames.seek")).params["at"] == .number(7_000))
  }

  @Test func aSeekOutWhenTheSubscriptionIsReplacedIsSentAgain() async throws {
    let server = FakeServer()
    let controller = ReplayController(
      target: target, scheduler: ManualScheduler().schedule, clock: TickingClock().read)
    controller.connect(server)
    controller.seek(at: 5_000, rate: 0)
    let sub = try #require(server.subs.first)
    sub.onSubscribed(["subscription": .string("s1"), "video": .string("h264")])
    controller.seek(at: 6_000, rate: 0)
    await settle()
    let lost = try #require(server.take("frames.seek"))
    sub.onSubscribed(["subscription": .string("s2"), "video": .string("h264")])
    await settle()
    let again = try #require(server.take("frames.seek"))
    #expect(again.params["subscription"] == .string("s2") && again.params["at"] == .number(6_000))
    lost.reply.resume(throwing: ServerError(code: "connection-lost", message: "Connection lost."))
    again.reply.resume(returning: .object(["at": .number(6_000)]))
    await settle()
    #expect(controller.replay == ReplayController.Replay(at: 6_000, rate: 0, ended: false) && controller.error == nil)
  }
}

@Suite struct ReplaySeekQueueTests {
  typealias Seek = ReplaySeekQueue.Seek

  @Test func keepsOneSeekOutAndOnlyTheLatestWaiting() {
    var queue = ReplaySeekQueue()
    queue.ask(Seek(at: 1, rate: 0))
    #expect(queue.next(now: 10, open: true) == Seek(at: 1, rate: 0))
    queue.ask(Seek(at: 2, rate: 0))
    queue.ask(Seek(at: 3, rate: 1))
    #expect(queue.next(now: 11, open: true) == nil)
    #expect(queue.finish() == false)
    #expect(queue.next(now: 12, open: true) == Seek(at: 3, rate: 1))
    #expect(queue.finish() == true && queue.isSettled)
  }

  @Test func holdsASeekUntilTheMinimumIntervalAndTheSubscription() {
    var queue = ReplaySeekQueue()
    queue.ask(Seek(at: 1, rate: 0))
    #expect(queue.next(now: 10, open: false) == nil && queue.delay(now: 10, open: false) == nil)
    #expect(queue.next(now: 10, open: true) == Seek(at: 1, rate: 0))
    _ = queue.finish()
    queue.ask(Seek(at: 2, rate: 0))
    #expect(queue.next(now: 10.02, open: true) == nil)
    #expect(queue.delay(now: 10.02, open: true).map { abs($0 - 0.03) < 1e-9 } == true)
    #expect(queue.next(now: 10 + ReplaySeekQueue.minimumInterval, open: true) == Seek(at: 2, rate: 0))
  }

  @Test func anInterruptedSeekWaitsUnlessANewerOneDoes() {
    var queue = ReplaySeekQueue()
    queue.ask(Seek(at: 1, rate: 0))
    _ = queue.next(now: 0, open: true)
    queue.interrupt()
    #expect(queue.next(now: 0, open: true) == Seek(at: 1, rate: 0))
    queue.ask(Seek(at: 2, rate: 0))
    queue.interrupt()
    #expect(queue.next(now: 0, open: true) == Seek(at: 2, rate: 0))
  }
}

@MainActor final class FakeTransport: ServerTransport {
  var sent: [[String: JSONValue]] = []
  var closed = false
  let onEvent: @MainActor (ServerTransportEvent) -> Void

  init(onEvent: @escaping @MainActor (ServerTransportEvent) -> Void) { self.onEvent = onEvent }

  func send(_ text: String) {
    if case .object(let message)? = try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)) {
      sent.append(message)
    }
  }

  func close() { closed = true }

  func answer(_ method: String, _ result: JSONValue) {
    guard let request = sent.last(where: { $0["method"] == .string(method) }), let id = request["id"] else { return }
    reply(["id": id, "result": result])
  }

  func refuse(_ method: String, code: String) {
    guard let request = sent.last(where: { $0["method"] == .string(method) }), let id = request["id"] else { return }
    reply(["id": id, "error": .object(["code": .string(code), "message": .string(code)])])
  }

  func reply(_ message: [String: JSONValue]) {
    onEvent(.text(String(decoding: try! JSONEncoder().encode(JSONValue.object(message)), as: UTF8.self)))
  }
}

@Suite @MainActor struct ServerClientTests {
  private final class Box<Value>: @unchecked Sendable {
    var value: Value
    init(_ value: Value) { self.value = value }
  }

  private let hello: JSONValue = .object([
    "protocol": .number(2), "server": .object(["name": .string("Mac"), "version": .string("1.14.0"), "stim": .string("1.14.0")]),
    "capabilities": .array([.string("read")]), "device": .object(["id": .string("d1"), "name": .string("Stim Desktop")]),
  ])

  @Test(arguments: [false, true]) func actionStreamsFailOnDisconnectWithoutReplaying(accepted: Bool) async throws {
    let scheduler = ManualScheduler()
    var transports: [FakeTransport] = []
    let client = ServerClient(
      endpoint: URL(fileURLWithPath: "/tmp/stim/server/local.sock"), clientName: "Desktop", clientVersion: "1",
      transport: { _, onEvent in
        let transport = FakeTransport(onEvent: onEvent)
        transports.append(transport)
        return transport
      }, scheduler: scheduler.schedule)
    client.start()
    defer { client.stop() }
    await settle()
    let first = try #require(transports.first)
    first.answer("hello", hello)
    await settle()
    var events: [ServerEvent] = []
    _ = try client.subscribeAction("desktop.stop.subscribe", params: ["cwd": .string("/selected")]) { events.append($0) }
    if accepted { first.answer("desktop.stop.subscribe", .object(["subscription": .string("s1")])) }
    first.onEvent(.closed("Lost stop connection."))
    #expect(events.count == 1 && events.first?.name == "error")
    scheduler.fire(delay: 1)
    await settle()
    let second = try #require(transports.last)
    second.answer("hello", hello)
    await settle()
    #expect(second !== first && client.isOpen)
    #expect(!second.sent.contains { $0["method"] == .string("desktop.stop.subscribe") })
    #expect(events.count == 1)
  }

  @Test func cancellingAnUnacceptedActionUnsubscribesItsLateAcceptance() async throws {
    var transport: FakeTransport?
    let client = ServerClient(
      endpoint: URL(fileURLWithPath: "/tmp/stim/server/local.sock"), clientName: "Desktop", clientVersion: "1",
      transport: { _, onEvent in
        let next = FakeTransport(onEvent: onEvent)
        transport = next
        return next
      })
    client.start()
    defer { client.stop() }
    await settle()
    let socket = try #require(transport)
    socket.answer("hello", hello)
    await settle()
    var events: [ServerEvent] = []
    let cancel = try client.subscribeAction("desktop.stop.subscribe", params: [:]) { events.append($0) }
    let cancelled = Task { try await cancel() }
    await settle()
    socket.answer("desktop.stop.subscribe", .object(["subscription": .string("s1")]))
    socket.reply(["event": .string("desktop-stop-ended"), "subscription": .string("s1")])
    await settle()
    #expect(events.isEmpty)
    #expect(socket.sent.last?["method"] == .string("unsubscribe"))
    #expect(socket.sent.last?["params"] == .object(["subscription": .string("s1")]))
    socket.answer("unsubscribe", .object([:]))
    try await cancelled.value
  }

  @Test func reconnectsAfterALostConnectionAndSendsItsSubscriptionsAgain() async throws {
    let scheduler = ManualScheduler()
    var transports: [FakeTransport] = []
    let client = ServerClient(
      endpoint: URL(fileURLWithPath: "/tmp/stim/server/local.sock"), clientName: "Stim Desktop", clientVersion: "1",
      transport: { _, onEvent in
        let transport = FakeTransport(onEvent: onEvent)
        transports.append(transport)
        return transport
      }, scheduler: scheduler.schedule)
    let at = Box(1.0)
    var subscribed: [String] = []
    _ = client.subscribe(
      "frames.subscribe", params: { ["at": .number(at.value)] },
      onSubscribed: { subscribed.append($0["subscription"]?.string ?? "") }, onEvent: { _ in }, onVideo: { _ in })
    client.start()
    await settle()
    let first = try #require(transports.first)
    #expect(first.sent.first?["method"] == .string("hello"))
    #expect(
      first.sent.first?["params"]
        == .object(["client": .object(["name": .string("Stim Desktop"), "version": .string("1")])]))
    first.answer("hello", hello)
    await settle()
    #expect(client.isOpen)
    first.answer("frames.subscribe", .object(["subscription": .string("s1")]))
    await settle()
    #expect(subscribed == ["s1"])

    at.value = 2
    first.onEvent(.closed("Connection lost."))
    #expect(client.state == .waiting(retryIn: 1, reason: "Connection lost."))
    scheduler.fire(delay: 1)
    await settle()
    let second = try #require(transports.last)
    #expect(second !== first)
    second.answer("hello", hello)
    await settle()
    let resubscribe = try #require(second.sent.last { $0["method"] == .string("frames.subscribe") })
    #expect(resubscribe["params"] == .object(["at": .number(2)]))
    second.answer("frames.subscribe", .object(["subscription": .string("s1")]))
    await settle()
    #expect(subscribed == ["s1", "s1"])
  }

  @Test func stopsOnARefusalInsteadOfRetrying() async throws {
    let scheduler = ManualScheduler()
    var transports: [FakeTransport] = []
    let client = ServerClient(
      endpoint: URL(fileURLWithPath: "/tmp/stim/server/local.sock"), clientName: "Stim Desktop", clientVersion: "1",
      transport: { _, onEvent in
        let transport = FakeTransport(onEvent: onEvent)
        transports.append(transport)
        return transport
      }, scheduler: scheduler.schedule)
    client.start()
    await settle()
    transports[0].refuse("hello", code: "unauthorized")
    await settle()
    #expect(client.state == .refused(ServerError(code: "unauthorized", message: "unauthorized")))
    #expect(transports[0].closed && scheduler.work.isEmpty)
  }

  @Test func sampleBuildTimingsReadTheServerWithoutCLIAndKeepTheSharedConnectionOnFailure() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).resolvingSymlinksInPath()
    let support = directory.appendingPathComponent("Application Support")
    let alias = directory.appendingPathComponent("support-link")
    let actual = WizardSample(applicationSupport: support).folder
    try FileManager.default.createDirectory(at: actual, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: support)
    let sample = WizardSample(applicationSupport: alias)
    let (client, socket) = try await openConnection()
    defer { client.stop() }
    let cli = StimCLI(environment: ["STIM_HOME": "/tmp/stim"], override: "/does-not-exist/stim")
    let request = Task { try await readServerBuildTimings(cli: cli, connection: (client, "/tmp/stim"), cwd: sample.folder.path) }
    await settle()
    #expect(
      socket.sent.last?["params"]
        == .object([
          "workspace": .string(actual.path), "sources": .array([.string("build")]), "grep": .string("^built on "),
          "tail": .number(5),
        ]))
    socket.answer(
      "logs.query",
      .object([
        "records": .array([
          .object([
            "event": .string("offload_done"),
            "timings": .object([
              "offerMs": .number(1), "syncMs": .number(2), "workerMs": .number(3), "fetchMs": .number(4), "totalMs": .number(10),
            ]),
          ])
        ])
      ]))
    #expect(try await request.value == BuildTimings(offerMs: 1, syncMs: 2, workerMs: 3, fetchMs: 4, totalMs: 10))
    let failed = Task { try await readServerBuildTimings(cli: cli, connection: (client, "/tmp/stim"), cwd: "/sample") }
    await settle()
    socket.refuse("logs.query", code: "unknown-workspace")
    let error = await #expect(throws: ServerError.self) { try await failed.value }
    #expect(error?.code == "unknown-workspace")
    #expect(client.isOpen)
  }

  private func openConnection(
    capabilities: [String] = ["read"], state: String = "open", features: [String]? = nil,
    versions: (stim: String, server: String)? = nil
  ) async throws
    -> (
      ServerClient, FakeTransport
    )
  {
    var transport: FakeTransport?
    let client = ServerClient(
      endpoint: URL(fileURLWithPath: "/tmp/stim/server/local.sock"), clientName: "Stats test", clientVersion: "1",
      transport: { _, onEvent in
        let next = FakeTransport(onEvent: onEvent)
        transport = next
        return next
      })
    client.start()
    await settle()
    let socket = try #require(transport)
    guard case .object(var fields) = hello else { fatalError("Invalid test hello") }
    fields["capabilities"] = .array(capabilities.map(JSONValue.string))
    if let versions, case .object(var server) = fields["server"] {
      server["stim"] = .string(versions.stim)
      server["version"] = .string(versions.server)
      fields["server"] = .object(server)
    }
    if let features { fields["features"] = .array(features.map(JSONValue.string)) }
    if state == "refused" {
      socket.refuse("hello", code: "unauthorized")
    } else if state != "connecting" {
      socket.answer("hello", .object(fields))
    }
    await settle()
    return (client, socket)
  }

  @Test func cancellingARequestKeepsOtherRequestsSubscriptionsAndControlConnected() async throws {
    let (client, socket) = try await openConnection()
    defer { client.stop() }
    var events: [String] = []
    var controlEnded: [String] = []
    let removeObserver = client.observeControlEnded { controlEnded.append($0.reason) }
    defer { removeObserver() }
    let unsubscribe = client.subscribe(
      "frames.subscribe", params: { [:] }, onSubscribed: { _ in },
      onEvent: { events.append($0.name) }, onVideo: { _ in })
    defer { unsubscribe() }
    await settle()
    socket.answer("frames.subscribe", .object(["subscription": .string("frames")]))
    await settle()
    let cancelled = Task { try await client.request("stats.get", [:]) }
    let other = Task { try await client.request("machine.get", [:]) }
    await settle()
    let cancelledID = try #require(socket.sent.last { $0["method"] == .string("stats.get") }?["id"])
    cancelled.cancel()
    await #expect(throws: CancellationError.self) { try await cancelled.value }
    socket.reply(["id": cancelledID, "result": .number(99)])
    socket.answer("machine.get", .number(42))
    #expect(try await other.value == .number(42))
    socket.reply(["event": .string("status"), "subscription": .string("frames")])
    #expect(events == ["status"])
    #expect(controlEnded.isEmpty && client.isOpen && !socket.closed)
    socket.reply(["event": .string("control-ended"), "session": .string("control"), "reason": .string("released")])
    #expect(controlEnded == ["released"])
  }

  @Test func aCancelledRequestDoesNotSendAndReplyCancellationRacesSettleOnce() async throws {
    let (client, socket) = try await openConnection()
    defer { client.stop() }
    let cancelled = Task { try await client.request("stats.get", [:]) }
    cancelled.cancel()
    await #expect(throws: CancellationError.self) { try await cancelled.value }
    #expect(!socket.sent.contains { $0["method"] == .string("stats.get") })
    let answered = Task { try await client.request("stats.get", [:]) }
    await settle()
    socket.answer("stats.get", .number(1))
    answered.cancel()
    #expect(try await answered.value == .number(1))
    await settle()
    socket.answer("stats.get", .number(2))
    let disconnected = Task { try await client.request("stats.get", [:]) }
    await settle()
    disconnected.cancel()
    socket.onEvent(.closed("test disconnect"))
    let result = await Result.awaiting { try await disconnected.value }
    switch result {
    case .success: Issue.record("A disconnected request unexpectedly succeeded")
    case .failure(let error):
      #expect(error is CancellationError || (error as? ServerError)?.code == "connection-lost")
    }
    await settle()
  }

  private let statsJSON =
    #"{"version":1,"project":{"ios":{"runs":3,"failed":1,"hits":1,"misses":1},"android":null},"offload":{"today":{"here":1,"offloaded":0,"fellBack":0},"machines":{"mini":{"today":{"offloaded":0,"offloadedMs":0,"savedMs":0,"fallbacks":0},"total":{"offloaded":1,"offloadedMs":2000,"savedMs":-500,"fallbacks":0}}},"placements":[]}}"#

  private func statsCLI(in directory: URL) throws -> StimCLI {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let executable = directory.appendingPathComponent("stim")
    let script = """
      #!/bin/sh
      printf '%s|%s\\n' "$PWD" "$*" >> "$STIM_HOME/calls"
      printf '%s\\n' '\(statsJSON)'
      """
    try Data(script.utf8).write(to: executable)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
    return StimCLI(environment: ["PATH": "/usr/bin:/bin", "STIM_HOME": directory.path], override: executable.path)
  }

  @Test func statsUseTheMatchingHomeSessionAndDoNotRetryRPCFailuresThroughCLI() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("stats-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let cli = try statsCLI(in: directory)
    let alias = directory.appendingPathComponent("alias")
    try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: directory)
    let (client, socket) = try await openConnection()
    defer { client.stop() }
    let reader = StatsReader(cli: Task { cli }) { (client, alias.path) }
    let payload = try JSONDecoder().decode(JSONValue.self, from: Data(statsJSON.utf8))
    let project = Task { try await reader.project(workspace: directory.path) }
    await settle()
    #expect(socket.sent.last?["params"] == .object(["workspace": .string(directory.path)]))
    socket.answer("stats.get", payload)
    let result = try await project.value
    #expect(result.project?.ios?.runs == 3 && result.project?.ios?.hitRate == 0.5 && result.project?.android == nil)
    let machine = Task { try await reader.machine() }
    await settle()
    #expect(socket.sent.last?["params"] == .object([:]))
    socket.answer("stats.get", payload)
    #expect(try await machine.value.offload?.machines["mini"]?.total.savedMs == -500)
    let failed = Task { try await reader.project(workspace: directory.path) }
    await settle()
    socket.refuse("stats.get", code: "unknown-workspace")
    let error = await #expect(throws: ServerError.self) { try await failed.value }
    #expect(error?.code == "unknown-workspace")
    let cancelled = Task { try await reader.project(workspace: directory.path) }
    await settle()
    cancelled.cancel()
    await #expect(throws: CancellationError.self) { try await cancelled.value }
    let dropped = Task { try await reader.machine() }
    await settle()
    socket.onEvent(.closed("Receive limit exceeded"))
    let droppedError = await #expect(throws: ServerError.self) { try await dropped.value }
    #expect(droppedError?.code == "connection-lost")
    #expect(!FileManager.default.fileExists(atPath: directory.appendingPathComponent("calls").path))
  }

  @Test(arguments: ["off", "connecting", "refused", "no-read", "wrong-home"])
  func statsRequireAnEligibleRPCWithoutInvokingCLI(_ state: String) async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("stats-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let cli = try statsCLI(in: directory)
    let (client, socket) = try await openConnection(
      capabilities: state == "no-read" ? ["build"] : ["read"], state: state)
    defer { client.stop() }
    let reader = StatsReader(cli: Task { cli }) {
      state == "off" ? nil : (client, state == "wrong-home" ? directory.appendingPathComponent("other").path : directory.path)
    }
    let projectError = await #expect(throws: ServerError.self) { try await reader.project(workspace: directory.path) }
    let machineError = await #expect(throws: ServerError.self) { try await reader.machine() }
    #expect(projectError?.code == "not-connected")
    #expect(machineError?.code == "not-connected")
    #expect(!FileManager.default.fileExists(atPath: directory.appendingPathComponent("calls").path))
    #expect(!socket.sent.contains { $0["method"] == .string("stats.get") })
  }

  @Test func copiedDiagnosticsReadRunningVersionsAndPreserveTheCompleteReportWithoutCLI() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("diagnostics-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let cli = try statsCLI(in: directory)
    let (client, socket) = try await openConnection(
      features: ["desktop-reports"], versions: (stim: "producer-stim", server: "producer-server"))
    defer { client.stop() }
    let read = Task { await readDoctorDiagnostics(cli: cli, connection: (client, directory.path), cwd: "/workspace") }
    await settle()
    #expect(socket.sent.last?["method"] == .string("desktop.reports.invalidate"))
    #expect(!socket.sent.contains { $0["method"] == .string("desktop.reports.get") })
    socket.answer("desktop.reports.invalidate", .object([:]))
    await settle()
    #expect(socket.sent.last?["params"] == .object(["report": .string("doctor"), "cwd": .string("/workspace")]))
    let report: JSONValue = .object([
      "findings": .array([.object(["detail": .string("HttpStore endpoint https://alice:shortpw@cache.example")])]),
      "futureDetails": .object(["tool": .string("unmodeled"), "ready": .bool(true)]),
    ])
    socket.answer("desktop.reports.get", .object(["pending": .bool(false), "value": report]))
    let result = await read.value
    #expect(result.stimVersion == "producer-stim" && result.serverVersion == "producer-server")
    #expect(try JSONDecoder().decode(JSONValue.self, from: Data(result.report.utf8)) == report)
    let copied = DebugLogRedaction.redact(result.report)
    #expect(!copied.contains("shortpw"))
    #expect(copied.contains("cache.example") && copied.contains(DebugLogRedaction.placeholder))

    let failed = Task { await readDoctorDiagnostics(cli: cli, connection: (client, directory.path), cwd: "/workspace") }
    await settle()
    socket.answer("desktop.reports.invalidate", .object([:]))
    await settle()
    socket.refuse("desktop.reports.get", code: "stim-failed")
    let failure = await failed.value
    #expect(failure.report.contains("stim-failed"))
    #expect(failure.stimVersion == "producer-stim" && failure.serverVersion == "producer-server")
    #expect(!FileManager.default.fileExists(atPath: directory.appendingPathComponent("calls").path))
  }

  @Test(arguments: ["off", "connecting", "refused", "no-read", "wrong-home", "old-server"])
  func copiedDiagnosticsRequireTheMatchingReportServerWithoutCLI(_ state: String) async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("diagnostics-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let cli = try statsCLI(in: directory)
    let (client, socket) = try await openConnection(
      capabilities: state == "no-read" ? ["build"] : ["read"], state: state,
      features: state == "old-server" ? nil : ["desktop-reports"])
    defer { client.stop() }
    let connection: (client: ServerClient, home: String)? =
      state == "off"
      ? nil
      : (
        client, state == "wrong-home" ? directory.appendingPathComponent("other").path : directory.path
      )
    let result = await readDoctorDiagnostics(cli: cli, connection: connection, cwd: directory.path)
    #expect(result.report.contains("unavailable"))
    if state != "old-server" { #expect(result.stimVersion == nil && result.serverVersion == nil) }
    #expect(!socket.sent.contains { $0["method"] == .string("desktop.reports.invalidate") })
    #expect(!FileManager.default.fileExists(atPath: directory.appendingPathComponent("calls").path))
  }

  @Test(arguments: [true, false])
  func copiedDiagnosticsDoNotPresentIncompleteSnapshotsAsDoctorJSON(_ pending: Bool) async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("diagnostics-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let cli = try statsCLI(in: directory)
    let (client, socket) = try await openConnection(features: ["desktop-reports"])
    defer { client.stop() }
    let read = Task { await readDoctorDiagnostics(cli: cli, connection: (client, directory.path), cwd: directory.path) }
    await settle()
    socket.answer("desktop.reports.invalidate", .object([:]))
    await settle()
    socket.answer(
      "desktop.reports.get", .object(pending ? ["pending": .bool(true), "value": .object([:])] : ["pending": .bool(false)]))
    #expect(await read.value.report.contains("unavailable"))
    #expect(!FileManager.default.fileExists(atPath: directory.appendingPathComponent("calls").path))
  }

  @Test func gcInvalidatesBeforeReadingAndNeverRetriesServerFailuresThroughCLI() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("gc-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let cli = try statsCLI(in: directory)
    let alias = directory.appendingPathComponent("alias")
    try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: directory)
    let (client, socket) = try await openConnection(features: ["desktop-reports"])
    defer { client.stop() }
    let reader = GcReportReader(cli: Task { cli }) { (client, alias.path) }
    let read = Task { try await reader.refresh() }
    await settle()
    #expect(socket.sent.last?["method"] == .string("desktop.reports.invalidate"))
    #expect(!socket.sent.contains { $0["method"] == .string("desktop.reports.get") })
    socket.answer("desktop.reports.invalidate", .object([:]))
    await settle()
    #expect(socket.sent.last?["params"] == .object(["report": .string("gc")]))
    let report: JSONValue = .object([
      "sections": .object([
        "linkedWorktrees": .array([
          .object(["path": .string("fresh"), "willRemove": .bool(false)])
        ])
      ])
    ])
    socket.answer("desktop.reports.get", .object(["pending": .bool(false), "value": report]))
    #expect(try await read.value.sections.linkedWorktrees?.first?.path == "fresh")

    let failed = Task { try await reader.refresh() }
    await settle()
    socket.answer("desktop.reports.invalidate", .object([:]))
    await settle()
    socket.refuse("desktop.reports.get", code: "stim-failed")
    let error = await #expect(throws: ServerError.self) { try await failed.value }
    #expect(error?.code == "stim-failed")
    #expect(!FileManager.default.fileExists(atPath: directory.appendingPathComponent("calls").path))
  }

  @Test func refusedOrCancelledGcInvalidationDoesNotReadOrDisconnectTheSession() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("gc-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let cli = try statsCLI(in: directory)
    let (client, socket) = try await openConnection(features: ["desktop-reports"])
    defer { client.stop() }
    let reader = GcReportReader(cli: Task { cli }) { (client, directory.path) }
    let refused = Task { try await reader.refresh() }
    await settle()
    socket.refuse("desktop.reports.invalidate", code: "forbidden")
    let error = await #expect(throws: ServerError.self) { try await refused.value }
    #expect(error?.code == "forbidden")
    let cancelled = Task { try await reader.refresh() }
    await settle()
    cancelled.cancel()
    await #expect(throws: CancellationError.self) { try await cancelled.value }
    socket.answer("desktop.reports.invalidate", .object([:]))
    await settle()
    #expect(!socket.sent.contains { $0["method"] == .string("desktop.reports.get") })
    #expect(client.isOpen && !socket.closed)
    #expect(!FileManager.default.fileExists(atPath: directory.appendingPathComponent("calls").path))
  }

  @Test(arguments: ["off", "connecting", "refused", "no-read", "wrong-home", "old-server"])
  func gcRequiresAnEligibleReportServerWithoutCLI(_ state: String) async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("gc-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let cli = try statsCLI(in: directory)
    let (client, socket) = try await openConnection(
      capabilities: state == "no-read" ? ["build"] : ["read"], state: state,
      features: state == "old-server" ? nil : ["desktop-reports"])
    defer { client.stop() }
    let reader = GcReportReader(cli: Task { cli }) {
      state == "off" ? nil : (client, state == "wrong-home" ? directory.appendingPathComponent("other").path : directory.path)
    }
    let error = await #expect(throws: ServerError.self) { try await reader.refresh() }
    #expect(error?.code == (state == "old-server" ? "unsupported" : "not-connected"))
    #expect(!socket.sent.contains { $0["method"] == .string("desktop.reports.invalidate") })
    #expect(!FileManager.default.fileExists(atPath: directory.appendingPathComponent("calls").path))
  }

  @Test(arguments: ["ios", "android"])
  func platformToolsReadFreshFilteredFindingsWithoutCLI(_ platform: String) async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("tools-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let cli = try statsCLI(in: directory)
    let (client, socket) = try await openConnection(features: ["desktop-reports", "desktop-report-platform"])
    defer { client.stop() }
    let read = Task {
      try await readPlatformDoctor(cli: cli, connection: (client, directory.path), cwd: "/workspace", platform: platform)
    }
    await settle()
    #expect(socket.sent.last?["method"] == .string("desktop.reports.invalidate"))
    #expect(!socket.sent.contains { $0["method"] == .string("desktop.reports.get") })
    socket.answer("desktop.reports.invalidate", .object([:]))
    await settle()
    #expect(
      socket.sent.last?["params"]
        == .object([
          "report": .string("doctor"), "cwd": .string("/workspace"), "platform": .string(platform),
        ]))
    socket.answer(
      "desktop.reports.get",
      .object([
        "pending": .bool(false),
        "value": .object([
          "project": .string("/workspace"),
          "findings": .array([.object(["level": .string("cost"), "title": .string("Missing tool"), "detail": .string(platform)])]
          ),
        ]),
      ]))
    let report = try await read.value
    #expect(report.costFindings.first?.detail == platform)
    let failed = Task {
      try await readPlatformDoctor(cli: cli, connection: (client, directory.path), cwd: "/workspace", platform: platform)
    }
    await settle()
    socket.refuse("desktop.reports.invalidate", code: "forbidden")
    let error = await #expect(throws: ServerError.self) { try await failed.value }
    #expect(error?.code == "forbidden")
    let gets = socket.sent.filter { $0["method"] == .string("desktop.reports.get") }.count
    let cancelled = Task {
      try await readPlatformDoctor(cli: cli, connection: (client, directory.path), cwd: "/workspace", platform: platform)
    }
    await settle()
    cancelled.cancel()
    await #expect(throws: CancellationError.self) { try await cancelled.value }
    socket.answer("desktop.reports.invalidate", .object([:]))
    await settle()
    #expect(socket.sent.filter { $0["method"] == .string("desktop.reports.get") }.count == gets)
    #expect(client.isOpen && !socket.closed)
    #expect(!FileManager.default.fileExists(atPath: directory.appendingPathComponent("calls").path))
  }

  @Test(arguments: ["off", "connecting", "refused", "no-read", "wrong-home", "old-server"])
  func platformToolsRefuseIneligibleServersWithoutCLI(_ state: String) async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("tools-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let cli = try statsCLI(in: directory)
    let (client, socket) = try await openConnection(
      capabilities: state == "no-read" ? ["build"] : ["read"], state: state,
      features: state == "old-server" ? ["desktop-reports"] : ["desktop-reports", "desktop-report-platform"])
    defer { client.stop() }
    let connection =
      state == "off" ? nil : (client, state == "wrong-home" ? directory.appendingPathComponent("other").path : directory.path)
    let error = await #expect(throws: ServerError.self) {
      try await readPlatformDoctor(cli: cli, connection: connection, cwd: directory.path, platform: "ios")
    }
    #expect(error?.code == (state == "old-server" ? "unsupported" : "not-connected"))
    #expect(!socket.sent.contains { $0["method"] == .string("desktop.reports.invalidate") })
    #expect(!FileManager.default.fileExists(atPath: directory.appendingPathComponent("calls").path))
  }

  @Test func gcDoesNotAcceptAPendingSnapshotAsAFreshMeasurement() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("gc-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let cli = try statsCLI(in: directory)
    let (client, socket) = try await openConnection(features: ["desktop-reports"])
    defer { client.stop() }
    let reader = GcReportReader(cli: Task { cli }) { (client, directory.path) }
    let read = Task { try await reader.refresh() }
    await settle()
    socket.answer("desktop.reports.invalidate", .object([:]))
    await settle()
    socket.answer(
      "desktop.reports.get",
      .object([
        "pending": .bool(true), "value": .object(["sections": .object([:])]),
      ]))
    let error = await #expect(throws: ServerError.self) { try await read.value }
    #expect(error?.code == "bad-response")
    #expect(!FileManager.default.fileExists(atPath: directory.appendingPathComponent("calls").path))
  }

  @Test func settingsReadSelectedFolderLayersAndPropagateFailureOrCancellationWithoutCLI() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("settings-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let cli = try statsCLI(in: directory)
    let (client, socket) = try await openConnection(features: ["desktop-settings"])
    defer { client.stop() }
    let read = Task {
      try await readServerSettings(cli: cli, connection: (client, directory.path), cwd: "/selected")
    }
    await settle()
    #expect(socket.sent.last?["method"] == .string("desktop.settings.get"))
    #expect(socket.sent.last?["params"] == .object(["cwd": .string("/selected")]))
    socket.answer(
      "desktop.settings.get",
      .object([
        "project": .string("/selected"), "files": .object(["committed": .string("/selected/.stim.json")]),
        "settings": .array([
          .object([
            "key": .string("android.keystorePassword"), "value": .string("********"), "sensitive": .bool(true),
            "origin": .string("committed"), "layers": .object(["committed": .string("********")]),
          ])
        ]),
        "unknown": .array([
          .object([
            "key": .string("other"), "scope": .string("committed"), "file": .string("/selected/.stim.json"), "value": .bool(true),
          ])
        ]),
      ]))
    let payload = try await read.value
    #expect(payload.project == "/selected")
    #expect(payload.entry("android.keystorePassword")?.layer(.committed) == .string("********"))
    #expect(payload.entry("android.keystorePassword")?.sensitive == true)
    #expect(payload.unknown.first?.key == "other")
    let failed = Task {
      try await readServerSettings(cli: cli, connection: (client, directory.path), cwd: "/selected")
    }
    await settle()
    socket.refuse("desktop.settings.get", code: "stim-failed")
    let error = await #expect(throws: ServerError.self) { try await failed.value }
    #expect(error?.code == "stim-failed")
    let cancelled = Task {
      try await readServerSettings(cli: cli, connection: (client, directory.path), cwd: "/selected")
    }
    await settle()
    cancelled.cancel()
    await #expect(throws: CancellationError.self) { try await cancelled.value }
    socket.answer("desktop.settings.get", .object([:]))
    #expect(client.isOpen && !socket.closed)
    #expect(!FileManager.default.fileExists(atPath: directory.appendingPathComponent("calls").path))
  }

  @Test(arguments: ["off", "connecting", "refused", "no-read", "wrong-home", "old-server"])
  func settingsRefuseIneligibleServersWithoutCLI(_ state: String) async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("settings-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let cli = try statsCLI(in: directory)
    let (client, socket) = try await openConnection(
      capabilities: state == "no-read" ? ["build"] : ["read"], state: state,
      features: state == "old-server" ? nil : ["desktop-settings"])
    defer { client.stop() }
    let connection =
      state == "off" ? nil : (client, state == "wrong-home" ? directory.appendingPathComponent("other").path : directory.path)
    let error = await #expect(throws: ServerError.self) {
      try await readServerSettings(cli: cli, connection: connection, cwd: directory.path)
    }
    #expect(error?.code == (state == "old-server" ? "unsupported" : "not-connected"))
    #expect(!socket.sent.contains { $0["method"] == .string("desktop.settings.get") })
    #expect(!FileManager.default.fileExists(atPath: directory.appendingPathComponent("calls").path))
  }

  @Test func machineAccessReadsFreshBuildAndHostStatesWithoutCLIAndPropagatesFailures() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("access-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let cli = try statsCLI(in: directory)
    let (client, socket) = try await openConnection(features: ["desktop-reports"])
    defer { client.stop() }
    let reader = MachineAccessReader(cli: Task { cli }) { (client, directory.path) }
    let read = Task { try await reader.report(cwd: "/workspace", ask: false) }
    await settle()
    #expect(socket.sent.last?["method"] == .string("desktop.reports.invalidate"))
    #expect(!socket.sent.contains { $0["method"] == .string("desktop.reports.get") })
    socket.answer("desktop.reports.invalidate", .object([:]))
    await settle()
    #expect(socket.sent.last?["params"] == .object(["report": .string("doctor"), "cwd": .string("/workspace")]))
    socket.answer(
      "desktop.reports.get",
      .object([
        "pending": .bool(false),
        "value": .object([
          "project": .string("/workspace"), "findings": .array([]),
          "remoteMachines": .array([.object(["machine": .string("builder"), "state": .string("approved")])]),
          "deviceHosts": .array([.object(["machine": .string("host"), "state": .string("pending")])]),
        ]),
      ]))
    let report = try await read.value
    #expect(report.remoteMachines?.first?.state == .approved)
    #expect(report.deviceHosts?.first?.state == .pending)

    let failed = Task { try await reader.report(cwd: "/workspace", ask: false) }
    await settle()
    socket.answer("desktop.reports.invalidate", .object([:]))
    await settle()
    socket.refuse("desktop.reports.get", code: "stim-failed")
    let error = await #expect(throws: ServerError.self) { try await failed.value }
    #expect(error?.code == "stim-failed")
    let gets = socket.sent.filter { $0["method"] == .string("desktop.reports.get") }.count
    let cancelled = Task { try await reader.report(cwd: "/workspace", ask: false) }
    await settle()
    cancelled.cancel()
    await #expect(throws: CancellationError.self) { try await cancelled.value }
    socket.answer("desktop.reports.invalidate", .object([:]))
    await settle()
    #expect(socket.sent.filter { $0["method"] == .string("desktop.reports.get") }.count == gets)
    #expect(client.isOpen && !socket.closed)
    #expect(!FileManager.default.fileExists(atPath: directory.appendingPathComponent("calls").path))
  }

  @Test(arguments: ["off", "connecting", "refused", "no-read", "wrong-home", "old-server"])
  func machineAccessReadsRequireTheMatchingReportServerWithoutCLI(_ state: String) async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("access-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let cli = try statsCLI(in: directory)
    let (client, socket) = try await openConnection(
      capabilities: state == "no-read" ? ["build"] : ["read"], state: state,
      features: state == "old-server" ? nil : ["desktop-reports"])
    defer { client.stop() }
    let reader = MachineAccessReader(cli: Task { cli }) {
      state == "off" ? nil : (client, state == "wrong-home" ? directory.appendingPathComponent("other").path : directory.path)
    }
    let error = await #expect(throws: ServerError.self) { try await reader.report(cwd: directory.path, ask: false) }
    #expect(error?.code == (state == "old-server" ? "unsupported" : "not-connected"))
    #expect(!socket.sent.contains { $0["method"] == .string("desktop.reports.invalidate") })
    #expect(!FileManager.default.fileExists(atPath: directory.appendingPathComponent("calls").path))
  }

  @Test func explicitMachineAccessRequestsKeepTheirIOSFixCommandAndTicketWithoutAReportConnection() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("access-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let executable = directory.appendingPathComponent("stim")
    let script = """
      #!/bin/sh
      printf '%s' "$*" > "$STIM_HOME/arguments"
      printf '%s' "$PWD" > "$STIM_HOME/cwd"
      printf '%s' "$STIM_ACCESS_TICKET" > "$STIM_HOME/ticket"
      printf '%s' '{"project":"/workspace","findings":[],"remoteMachines":[{"machine":"builder","state":"pending"}]}'
      """
    try Data(script.utf8).write(to: executable)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
    let cli = StimCLI(environment: ["PATH": "/usr/bin:/bin", "STIM_HOME": directory.path], override: executable.path)
    var reads = 0
    let reader = MachineAccessReader(cli: Task { cli }) {
      reads += 1
      return nil
    }
    let cwd = directory.resolvingSymlinksInPath().path
    let report = try await reader.report(cwd: cwd, ask: true, extraEnvironment: ["STIM_ACCESS_TICKET": "synthetic-ticket"])
    #expect(report.remoteMachines?.first?.state == .pending)
    #expect(
      try String(contentsOf: directory.appendingPathComponent("arguments"), encoding: .utf8)
        == "doctor --json --platform ios --fix")
    #expect(try String(contentsOf: directory.appendingPathComponent("ticket"), encoding: .utf8) == "synthetic-ticket")
    let actualCwd = try String(contentsOf: directory.appendingPathComponent("cwd"), encoding: .utf8)
    #expect(URL(fileURLWithPath: actualCwd).resolvingSymlinksInPath().path == cwd)
    #expect(reads == 0)
  }

}
