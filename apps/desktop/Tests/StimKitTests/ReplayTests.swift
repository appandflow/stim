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

  @Test func laysSpansOutByRecordedLengthWithAFixedGap() throws {
    let timeline = try #require(ReplayTimeline(spans: spans))
    let (first, gap, second) = (timeline.pieces[0], timeline.pieces[1], timeline.pieces[2])
    #expect(gap.isGap && gap.start == 4 * minute && gap.end == 2 * hour)
    #expect(abs((gap.to - gap.from) - (0.8 * minute) / (10.8 * minute)) < 1e-9)
    #expect(abs((second.to - second.from) / (first.to - first.from) - 1.5) < 1e-9)
    #expect(abs(second.to - 1) < 1e-9)
    #expect(timeline.recordedLength == 10 * minute)
    #expect(ReplayTimeline(spans: []) == nil)
  }

  @Test func mapsTimesToPlacesAndGapsToTheRecordingAfterThem() throws {
    let timeline = try #require(ReplayTimeline(spans: spans))
    let at = 2 * hour + 3 * minute
    #expect(abs(timeline.time(at: timeline.position(of: at)) - at) < 1)
    let gap = timeline.pieces[1]
    #expect(timeline.time(at: (gap.from + gap.to) / 2) == 2 * hour)
    #expect(timeline.position(of: hour) == gap.to)
    #expect(timeline.time(at: -1) == 0 && timeline.time(at: 2) == 2 * hour + 6 * minute)
  }

  @Test func landsALittleBeforeAMarkerButNotBeforeItsSpan() throws {
    let timeline = try #require(ReplayTimeline(spans: spans))
    #expect(timeline.seekTime(for: ReplayMarker(at: 2 * minute, kind: "action", label: "Tapped")) == 2 * minute - 1500)
    #expect(timeline.seekTime(for: ReplayMarker(at: 2 * hour + 500, kind: "error", label: "boom")) == 2 * hour)
    #expect([40_000, 14 * minute, 2 * hour, 72 * hour].map(ReplayTimeline.shortDuration) == ["40s", "14m", "2h", "3d"])
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
    #expect(range.markers.first == ReplayMarker(at: 1_790_608_621_703, kind: "action", command: "press", label: "Tapped (38, 84)"))
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
  private let hello: JSONValue = .object([
    "protocol": .number(1), "server": .object(["name": .string("Mac"), "version": .string("1.14.0"), "stim": .string("1.14.0")]),
    "capabilities": .array([.string("read")]), "device": .object(["id": .string("d1"), "name": .string("Stim Desktop")]),
  ])

  @Test func reconnectsAfterALostConnectionAndSendsItsSubscriptionsAgain() async throws {
    let scheduler = ManualScheduler()
    var transports: [FakeTransport] = []
    let client = ServerClient(
      endpoint: URL(string: "ws://127.0.0.1:7787")!, clientName: "Stim Desktop", clientVersion: "1",
      auth: { .device(token: "secret") },
      transport: { _, onEvent in
        let transport = FakeTransport(onEvent: onEvent)
        transports.append(transport)
        return transport
      }, scheduler: scheduler.schedule)
    var at = 1.0
    var subscribed: [String] = []
    _ = client.subscribe(
      "frames.subscribe", params: { ["at": .number(at)] },
      onSubscribed: { subscribed.append($0["subscription"]?.string ?? "") }, onEvent: { _ in }, onVideo: { _ in })
    client.start()
    await settle()
    let first = try #require(transports.first)
    #expect(first.sent.first?["method"] == .string("hello"))
    if case .object(let params)? = first.sent.first?["params"] {
      #expect(params["auth"] == .object(["deviceToken": .string("secret")]))
    }
    first.answer("hello", hello)
    await settle()
    #expect(client.isOpen)
    first.answer("frames.subscribe", .object(["subscription": .string("s1")]))
    await settle()
    #expect(subscribed == ["s1"])

    at = 2
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
      endpoint: URL(string: "ws://127.0.0.1:7787")!, clientName: "Stim Desktop", clientVersion: "1",
      auth: { .device(token: "revoked") },
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
}
