import Foundation
import StimKit
import Testing

private final class Recorder: @unchecked Sendable {
  private let lock = NSLock()
  private var crumbs: [DiagnosticBreadcrumb] = []
  private var tagValues: [String: String] = [:]
  private var reportList: [DiagnosticReport] = []

  var breadcrumbs: [DiagnosticBreadcrumb] { lock.withLock { crumbs } }
  var tags: [String: String] { lock.withLock { tagValues } }
  var reports: [DiagnosticReport] { lock.withLock { reportList } }

  var sink: Diagnostics.Sink {
    Diagnostics.Sink(
      breadcrumb: { crumb in self.lock.withLock { self.crumbs.append(crumb) } },
      tag: { key, value in self.lock.withLock { self.tagValues[key] = value } },
      report: { report in self.lock.withLock { self.reportList.append(report) } })
  }

  /// Every string an event or breadcrumb would carry.
  var everything: String {
    lock.withLock {
      var strings: [String] = []
      for crumb in crumbs {
        strings += [crumb.category, crumb.message]
        for (key, value) in crumb.data { strings += [key, value] }
      }
      for (key, value) in tagValues { strings += [key, value] }
      for report in reportList {
        strings.append(report.message)
        for (key, value) in report.tags { strings += [key, value] }
        strings += report.fingerprint
      }
      return strings.joined(separator: "\n")
    }
  }
}

private struct Machine: Decodable {
  var name: String
  enum CodingKeys: String, CodingKey { case name }
}

private struct Payload: Decodable {
  var machines: [String: Machine]
  var list: [Machine]
  enum CodingKeys: String, CodingKey { case machines, list }
}

struct DiagnosticsTests {
  private func scratchDirectory() throws -> URL {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("acme-secret-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }

  @Test func reportsADecodeFailureWithTheTypeAndCodingPathButNoValues() async throws {
    let dir = try scratchDirectory()
    defer { try? FileManager.default.removeItem(at: dir) }
    let recorder = Recorder()
    let diagnostics = Diagnostics()
    diagnostics.install(recorder.sink)
    let json = #"{"machines":{"acmesecret":{"name":7}},"list":[]}"#

    #expect(throws: DecodingError.self) {
      try decodeReporting(Payload.self, from: Data(json.utf8), source: .server, diagnostics: diagnostics)
    }
    let missing = #"{"machines":{},"list":[{"name":"a"},{}]}"#
    #expect(throws: DecodingError.self) {
      try decodeReporting(Payload.self, from: Data(missing.utf8), source: .cli, diagnostics: diagnostics)
    }

    #expect(
      recorder.reports.map(\.tags) == [
        ["source": "server", "type": "Payload", "coding_path": "machines.<key>.name", "reason": "type-mismatch"],
        ["source": "cli", "type": "Payload", "coding_path": "list.[].name", "reason": "key-not-found"],
      ])
    #expect(!recorder.everything.contains("acmesecret"))
  }

  @Test func masksADictionaryKeyEvenWhenTheDecoderConvertsKeys() {
    let recorder = Recorder()
    let diagnostics = Diagnostics()
    diagnostics.install(recorder.sink)
    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase
    #expect(throws: DecodingError.self) {
      try decodeReporting(
        Payload.self, from: Data(#"{"machines":{"acme_secret":{"name":7}},"list":[]}"#.utf8), source: .cli,
        decoder: decoder, diagnostics: diagnostics)
    }
    #expect(recorder.reports.first?.tags["coding_path"] == "machines.<key>.name")
  }

  @Test func reportsNoDecodeFailureForAValidPayload() throws {
    let recorder = Recorder()
    let diagnostics = Diagnostics()
    diagnostics.install(recorder.sink)
    let payload = try decodeReporting(
      Payload.self, from: Data(#"{"machines":{},"list":[{"name":"a"}]}"#.utf8), source: .cli, diagnostics: diagnostics)
    #expect(payload.list.count == 1)
    #expect(recorder.reports.isEmpty)
  }

  @Test func sendsEachDistinctFailureOnceAndCapsTheSession() {
    let recorder = Recorder()
    let diagnostics = Diagnostics(maxReports: 3)
    diagnostics.install(recorder.sink)
    diagnostics.report(.server(.noAnswer))
    diagnostics.report(.server(.noAnswer))
    diagnostics.report(.server(.exited))
    diagnostics.report(.server(.tooOld))
    diagnostics.report(.server(.launchFailed))
    #expect(
      recorder.reports.map(\.tags) == [
        ["kind": "no-answer"], ["kind": "exited"], ["kind": "too-old"],
      ])
  }

  @Test func recordsNothingAndSpendsNoBudgetWithoutASink() {
    let diagnostics = Diagnostics(maxReports: 1)
    diagnostics.report(.server(.noAnswer))
    diagnostics.breadcrumb("navigation", "overview")
    let recorder = Recorder()
    diagnostics.install(recorder.sink)
    diagnostics.report(.server(.noAnswer))
    #expect(recorder.reports.count == 1)
    #expect(recorder.breadcrumbs.isEmpty)
  }

  @Test func startsTheCrashReporterOnlyForABundleThatCarriesADSN() {
    #expect(Diagnostics.sentryDSN(nil) == nil)
    #expect(Diagnostics.sentryDSN("") == nil)
    #expect(Diagnostics.sentryDSN("  \n") == nil)
    #expect(Diagnostics.sentryDSN(3) == nil)
    #expect(Diagnostics.sentryDSN(" https://key@o1.ingest.sentry.io/2\n") == "https://key@o1.ingest.sentry.io/2")
  }

  @Test func reportsEveryServerFailureKindAsAFixedMessage() {
    for kind in [ServerFailureKind.adoptionHomeMismatch, .launchFailed, .noAnswer, .exited, .tooOld] {
      let report = DiagnosticFailure.server(kind).report
      #expect(report.message == "stim-server start failed")
      #expect(report.tags == ["kind": kind.rawValue])
    }
  }
}
