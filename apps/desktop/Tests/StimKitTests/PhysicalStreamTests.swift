import Foundation
import Testing

@testable import StimKit

@Suite @MainActor struct PhysicalStreamTests {
  let target = ReplayTarget(workspace: "/w", platform: "android", slot: "default")

  private func started() async throws -> (PhysicalStream, FakeServer, String) {
    let server = FakeServer()
    let stream = PhysicalStream(target: target)
    stream.connect(server)
    stream.begin()
    await settle()
    try #require(server.take("control.begin")).reply.resume(returning: .object(["session": .string("c1")]))
    await settle()
    #expect(stream.control == .on(session: "c1"))
    return (stream, server, "c1")
  }

  @Test func asksForThePhysicalDeviceSoAnOlderServerCannotStreamTheSlotsEmulator() throws {
    let server = FakeServer()
    let stream = PhysicalStream(target: target)
    stream.connect(server)
    let params = try #require(server.subs.first).params()
    #expect(params["physical"] == .bool(true))
    #expect(params["video"] == .array([.string("h264")]))
  }

  @Test func beginsControlOfThePhysicalDeviceAndSendsInputOnlyInItsSession() async throws {
    let server = FakeServer()
    let stream = PhysicalStream(target: target)
    stream.connect(server)
    stream.touch("down", x: 0.5, y: 0.5)
    stream.begin()
    await settle()
    #expect(server.requests.map(\.method) == ["control.begin"])
    let begin = try #require(server.take("control.begin"))
    #expect(begin.params["physical"] == .bool(true))
    begin.reply.resume(returning: .object(["session": .string("c1")]))
    await settle()
    stream.button("back")
    await settle()
    let button = try #require(server.take("input.button"))
    #expect(button.params == ["session": .string("c1"), "button": .string("back")])
  }

  @Test func endsASessionTheServerGrantsAfterTheUserReleased() async throws {
    let server = FakeServer()
    let stream = PhysicalStream(target: target)
    stream.connect(server)
    stream.begin()
    await settle()
    let begin = try #require(server.take("control.begin"))
    stream.end()
    begin.reply.resume(returning: .object(["session": .string("late")]))
    await settle()
    #expect(stream.control == .off(ended: nil))
    #expect(try #require(server.take("control.end")).params == ["session": .string("late")])
  }

  @Test func stopsControllingWhenTheServerEndsTheSessionOrTheConnectionDrops() async throws {
    let (stream, server, session) = try await started()
    for observer in server.controlObservers {
      observer(ControlEnded(session: "other", reason: "idle", message: "Another session ended."))
    }
    #expect(stream.control == .on(session: session))
    for observer in server.controlObservers {
      observer(ControlEnded(session: session, reason: "device-gone", message: "The phone disconnected."))
    }
    #expect(stream.control == .off(ended: "The phone disconnected."))
    stream.touch("down", x: 0.1, y: 0.1)
    await settle()
    #expect(server.take("input.touch") == nil)

    let (dropped, droppedServer, _) = try await started()
    for observer in droppedServer.controlObservers {
      observer(ControlEnded(session: nil, reason: "failed", message: "Connection lost."))
    }
    #expect(dropped.control == .off(ended: "Connection lost."))
  }

  @Test func liftsAFingerStillDownBeforeEndingTheSession() async throws {
    let (stream, server, session) = try await started()
    stream.touch("down", x: 0.2, y: 0.3)
    stream.touch("move", x: 0.4, y: 0.5)
    stream.end()
    await settle()
    let touches = server.requests.filter { $0.method == "input.touch" }.map { $0.params["phase"] }
    #expect(touches == [.string("down"), .string("move"), .string("up")])
    let up = try #require(server.requests.last { $0.method == "input.touch" })
    #expect(up.params["x"] == .number(0.4) && up.params["session"] == .string(session))
    #expect(server.requests.contains { $0.method == "control.end" })
  }

  @Test func keepsWhyControlEndedWhenTheTileReleasesAfterwards() async throws {
    let (stream, server, session) = try await started()
    for observer in server.controlObservers {
      observer(ControlEnded(session: session, reason: "idle", message: "No input for 5 minutes."))
    }
    stream.end()
    #expect(stream.control == .off(ended: "No input for 5 minutes."))

    let refused = FakeServer()
    let other = PhysicalStream(target: target)
    other.connect(refused)
    other.begin()
    await settle()
    try #require(refused.take("control.begin")).reply.resume(
      throwing: ServerError(code: "forbidden", message: "/w does not hold the lease on this device."))
    await settle()
    other.end()
    #expect(other.control == .failed("/w does not hold the lease on this device."))
  }

  @Test func showsWhyFramesStoppedUntilTheyFlowAgain() throws {
    let server = FakeServer()
    let stream = PhysicalStream(target: target)
    stream.connect(server)
    let sub = try #require(server.subs.first)
    sub.onSubscribed(["subscription": .string("s1")])
    sub.onEvent(
      ServerEvent(
        name: "frame-delayed", subscription: "s1",
        fields: ["delayed": .bool(true), "reason": .string("The iPhone is locked.")]))
    #expect(stream.problem == "The iPhone is locked.")
    sub.onEvent(ServerEvent(name: "frame-delayed", subscription: "s1", fields: ["delayed": .bool(false)]))
    #expect(stream.problem == nil)
    sub.onEvent(
      ServerEvent(
        name: "error", subscription: "",
        fields: ["error": .object(["code": .string("action-failed"), "message": .string("No helper.")])]))
    #expect(stream.problem == "No helper.")
  }
}

@Suite @MainActor struct ServerClientControlTests {
  @Test func routesControlEndedBySessionAndEndsEverySessionWhenTheConnectionDrops() async throws {
    var transports: [FakeTransport] = []
    let client = ServerClient(
      endpoint: URL(string: "ws://127.0.0.1:7787")!, clientName: "Stim Desktop", clientVersion: "1",
      auth: { .device(token: "secret") },
      transport: { _, onEvent in
        let transport = FakeTransport(onEvent: onEvent)
        transports.append(transport)
        return transport
      }, scheduler: { _, _ in {} })
    var ended: [ControlEnded] = []
    _ = client.observeControlEnded { ended.append($0) }
    client.start()
    await settle()
    let transport = try #require(transports.first)
    transport.answer(
      "hello",
      .object([
        "protocol": .number(1),
        "server": .object(["name": .string("Mac"), "version": .string("1"), "stim": .string("1")]),
        "capabilities": .array([.string("read"), .string("control")]),
        "features": .array([.string("physical-android")]),
      ]))
    await settle()
    let hello = try #require({ if case .open(let hello) = client.state { return hello } else { return nil } }())
    #expect(hello.features == ["physical-android"])
    transport.reply([
      "event": .string("control-ended"), "session": .string("c1"), "reason": .string("idle"),
      "message": .string("No input for 5 minutes."),
    ])
    #expect(ended == [ControlEnded(session: "c1", reason: "idle", message: "No input for 5 minutes.")])
    transport.onEvent(.closed("Connection lost."))
    #expect(ended.last == ControlEnded(session: nil, reason: "failed", message: "Connection lost."))
  }
}
