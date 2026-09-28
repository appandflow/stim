import CoreGraphics
import Foundation
import Testing

@testable import StimKit

private let target = ReplayTarget(workspace: "/work/app", platform: "ios", slot: "default")

private func keyframe(start: Double, end: Double) -> JSONValue {
  .object([
    "start": .number(start), "end": .number(end), "at": .number(start), "width": .number(330),
    "height": .number(720), "data": .string(Data([0, 0, 0, 1, 0x65]).base64EncodedString()),
  ])
}

private let image = CGContext(
  data: nil, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4, space: CGColorSpaceCreateDeviceRGB(),
  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!.makeImage()!

@Suite @MainActor struct ReplayPreviewsTests {
  private func previews(_ server: FakeServer, decodes: @escaping (ReplayKeyframe) -> CGImage? = { _ in image })
    -> ReplayPreviews
  {
    let previews = ReplayPreviews(target: target)
    previews.decode = { keyframe, done in done(decodes(keyframe)) }
    previews.connect(server)
    return previews
  }

  private func answer(_ server: FakeServer, start: Double, end: Double) async throws -> Double {
    let request = try #require(server.take("replay.keyframe"))
    request.reply.resume(returning: keyframe(start: start, end: end))
    await settle()
    return try #require(request.params["at"]?.number)
  }

  @Test func asksForTheHoveredSegmentThenItsNeighboursOneAtATime() async throws {
    let server = FakeServer()
    let previews = previews(server)
    previews.want(12_000, within: 0...20_000)
    await settle()
    #expect(server.requests.count == 1)
    #expect(server.requests[0].params["workspace"] == .string("/work/app"))
    #expect(try await answer(server, start: 10_000, end: 15_000) == 12_000)
    #expect(previews.image(at: 14_000) != nil)
    #expect(previews.aspect == 330.0 / 720)
    #expect(try await answer(server, start: 15_000, end: 20_000) == 17_000)
    #expect(try await answer(server, start: 5000, end: 10_000) == 7000)
    #expect(try await answer(server, start: 0, end: 5000) == 2000)
    #expect(server.requests.isEmpty)

    previews.want(3000, within: 0...20_000)
    previews.want(19_000, within: 0...20_000)
    await settle()
    #expect(server.requests.isEmpty)
  }

  @Test func aHoverThatMovesOnDropsTheTimesWaitingButKeepsTheAnswerOut() async throws {
    let server = FakeServer()
    let previews = previews(server)
    var images = 0
    previews.onImage = { images += 1 }
    previews.want(50_000, within: 0...100_000)
    await settle()
    previews.want(90_000, within: 0...100_000)
    await settle()
    #expect(server.requests.count == 1)
    #expect(try await answer(server, start: 50_000, end: 55_000) == 50_000)
    #expect(images == 1)
    #expect(previews.image(at: 51_000) != nil)
    #expect(try await answer(server, start: 90_000, end: 95_000) == 90_000)
    #expect(try await answer(server, start: 85_000, end: 90_000) == 85_000)
    #expect(try await answer(server, start: 95_000, end: 100_000) == 100_000)
    #expect(try await answer(server, start: 80_000, end: 85_000) == 80_000)
    #expect(server.requests.isEmpty)
  }

  @Test func aTimeInAShortGapIsCoveredByTheSegmentTheServerAnswersWith() async throws {
    let server = FakeServer()
    let previews = previews(server)
    previews.want(10_500, within: 10_500...10_500)
    await settle()
    #expect(try await answer(server, start: 11_000, end: 16_000) == 10_500)
    previews.want(10_500, within: 10_500...10_500)
    await settle()
    #expect(server.requests.isEmpty)
    #expect(previews.image(at: 10_500) != nil)
  }

  @Test func aKeyframeThatFailsToDecodeIsAskedForAgain() async throws {
    let server = FakeServer()
    var fail = true
    let previews = previews(server) { _ in fail ? nil : image }
    previews.want(1000, within: 1000...1000)
    await settle()
    _ = try await answer(server, start: 0, end: 5000)
    #expect(previews.image(at: 1000) == nil)
    fail = false
    previews.want(1000, within: 1000...1000)
    await settle()
    _ = try await answer(server, start: 0, end: 5000)
    #expect(previews.image(at: 1000) != nil)
  }

  @Test func stopsAskingAServerWithoutReplayKeyframe() async throws {
    let server = FakeServer()
    let previews = previews(server)
    previews.want(1000, within: 0...20_000)
    await settle()
    try #require(server.take("replay.keyframe")).reply.resume(
      throwing: ServerError(code: "unknown-method", message: "Unknown method replay.keyframe."))
    await settle()
    #expect(!previews.isAvailable)
    previews.want(9000, within: 0...20_000)
    await settle()
    #expect(server.requests.isEmpty)
  }
}
