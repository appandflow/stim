import Foundation
import Testing

@testable import StimKit

@Suite struct WorkspaceRowVectorTests {
  struct Vectors: Decodable {
    struct Status: Decodable, Equatable {
      var kind: String
      var text: String
      var label: String
      var tone: String
    }

    struct Problem: Decodable, Equatable {
      var kind: String
      var text: String
      var tone: String
    }

    struct Idle: Decodable, Equatable {
      var text: String
      var label: String
    }

    struct Devices: Decodable, Equatable {
      var names: String?
      var drivers: String?
      var idle: Idle?
      var remote: Int
    }

    struct Case: Decodable {
      var name: String
      var workspace: Workspace
      var status: Status
      var problems: [Problem]
      var devices: Devices
    }

    var now: String
    var cases: [Case]
  }

  static let vectors: Vectors = {
    let url = Bundle.module.url(forResource: "workspace-row-vectors", withExtension: "json", subdirectory: "Fixtures")!
    return try! JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
  }()

  static let now = parseTimestamp(vectors.now)!

  @Test(arguments: vectors.cases.map(\.name))
  func summarizesTheRowAsThePhoneDoes(name: String) throws {
    let c = try #require(Self.vectors.cases.first { $0.name == name })
    let status = c.workspace.rowStatus(now: Self.now)
    #expect(
      Vectors.Status(
        kind: status.kind.rawValue, text: status.text, label: status.label, tone: String(describing: status.tone))
        == c.status)
    #expect(
      c.workspace.rowProblems(now: Self.now).map {
        Vectors.Problem(kind: $0.kind.rawValue, text: $0.text, tone: String(describing: $0.tone))
      } == c.problems)
    let devices = c.workspace.rowDevices(now: Self.now)
    #expect(
      Vectors.Devices(
        names: devices.names, drivers: devices.drivers,
        idle: devices.idle.map { Vectors.Idle(text: $0.text, label: $0.label) }, remote: devices.remote) == c.devices)
  }
}

@Suite struct WorkspaceRowLabelTests {
  static let now = parseTimestamp("2026-09-30T12:00:00.000Z")!

  static func workspace(_ fields: String) throws -> Workspace {
    let json = #"{"path":"/w","live":true,"memoryMb":0,"warnings":[],\#(fields)}"#
    return try JSONDecoder().decode(Workspace.self, from: Data(json.utf8))
  }

  static let driven =
    #"{"name":"stim-w (iPhone 18 27.0)","udid":"SIM-1","owned":true,"state":"Booted","activity":{"state":"driven","driver":{"tool":"agent-device","since":"2026-09-30T11:55:00.000Z"},"basis":[]}}"#

  @Test func speaksTheBuildStepErrorsAndEachDriver() throws {
    let env = try Self.workspace(
      #""build":{"platform":"ios","slot":"default","state":"running","phase":"compile","startedAt":"2026-09-30T11:59:00.000Z","phaseStartedAt":"2026-09-30T11:59:30.000Z","outcome":"cold","basis":0,"detail":{"step":"compile","unit":"targets","done":97,"total":214}},"logs":{"dir":"","errorsSinceMarker":2},"ios":\#(Self.driven)"#
    )
    #expect(
      env.rowLabel(now: Self.now, folder: nil, showsGit: false)
        == "w, Building iOS, Compiling, 97 of 214 targets, 2 errors, iOS, driven by agent-device for 5 minutes")
  }

  @Test func speaksADrivenWorkspaceOnceThroughItsDevices() throws {
    let env = try Self.workspace(
      #""ios":\#(Self.driven),"slots":[{"slot":"ipad","ios":{"name":"stim-w (iPad 27.0)","udid":"SIM-2","owned":true,"state":"Booted"}}]"#
    )
    #expect(
      env.rowLabel(now: Self.now, folder: "apps/mobile", showsGit: false)
        == "w, iOS, driven by agent-device for 5 minutes, iOS slot ipad running, apps/mobile")
  }
}
