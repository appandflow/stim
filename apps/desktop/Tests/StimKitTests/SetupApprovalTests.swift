import Foundation
import Testing

@testable import StimKit

struct SetupApprovalTests {
  private let ticket = SetupTicket.generate(
    now: Date(timeIntervalSince1970: 1_791_284_400), randomBytes: { $0 = Array(0..<32) })

  @Test func readsTheCommandStimDesktopPrintsOnTheRequestingMachine() throws {
    let command = setupCommand(
      version: "1.21.0", ticket: ticket, capabilities: [.build, .deviceHost], known: SetupKnown(clientName: "Laptop"))
    let request = try SetupRequest.parse(command)
    #expect(request.ticket == ticket)
    #expect(request.expires == ticket.isoExpires)
    #expect(request.capabilities == [.build, .deviceHost])
  }

  @Test func readsTheOneLineCommandStimRemoteAddPrints() throws {
    let request = try SetupRequest.parse(
      "STIM_SETUP_TICKET=\(ticket.value) STIM_SETUP_ORIGIN=doctor npx --yes stim@1.21.0 setup --expires 2026-10-06T12:30:00.000Z --device-host\n"
    )
    #expect(request.ticket.value == ticket.value)
    #expect(request.expires == "2026-10-06T12:30:00.000Z")
    #expect(request.capabilities == [.deviceHost])
  }

  @Test(arguments: [
    ("--yes", SetupRequest.Problem.unsupported("--yes")),
    ("--port 7788", .unsupported("--port")),
    ("--label other", .unsupported("--label")),
  ])
  func refusesSetupOptionsDesktopWouldNotApply(option: String, problem: SetupRequest.Problem) {
    let command = "STIM_SETUP_TICKET=\(ticket.value) stim setup --expires \(ticket.isoExpires) --build \(option)"
    #expect(throws: problem) { try SetupRequest.parse(command) }
  }

  @Test func refusesACommandWithoutItsTicket() {
    #expect(throws: SetupRequest.Problem.noTicket) {
      try SetupRequest.parse("stim setup --expires \(ticket.isoExpires) --build")
    }
  }
}
