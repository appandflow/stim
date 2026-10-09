import Foundation
import Testing

@testable import StimKit

@Suite struct DebugLogTests {
  @Test(arguments: [
    "pairingToken=0123456789abcdef0123456789abcdef01234567",
    "{\"deviceToken\":\"abc123def456\"}",
    "deviceToken: abc123def456",
    "Authorization: Bearer abc.def-123_456",
    "stim-server pair --token abc123def456 --json",
    "stim-server pair --ticket=abc123def456",
    "https://0123456789abcdef@o123.ingest.sentry.io/456",
    "SENTRY_DSN=https://key@o1.ingest.sentry.io/2",
    "setup ticket abcdEFGH0123ijklMNOP4567qrstUVWX8901yzAB",
    "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    "open https://host.example/pair?token=abc123def456&x=1",
    "Authorization: Basic dXNlcjpwYXNz",
    "error STIM_BAD_ARG: unknown flag --token abc123def456 (run: desktop-1)",
  ])
  func redactsSecretShapes(_ line: String) {
    let redacted = DebugLogRedaction.redact(line)
    #expect(redacted.contains(DebugLogRedaction.placeholder))
    #expect(DebugLogRedaction.redact(redacted) == redacted)
    for secret in ["abc123def456", "0123456789abcdef", "abcdEFGH0123", "abc.def-123", "eyJzdWIi", "key@o1", "dXNlcjpwYXNz"] {
      #expect(!redacted.contains(secret), "\(secret) survived in \(redacted)")
    }
  }

  @Test func keepsDiagnosticText() {
    let line =
      "failed run=desktop-1a2b3c4d5e6f exit=2 STIM_BAD_ARG stim ios --scheme App cwd=/Users/me/Developer/stim/.worktrees/feature-with-a-long-branch-name-1234"
    #expect(DebugLogRedaction.redact(line) == line)
  }

  @Test func keepsSimulatorUDIDs() {
    let line = "stim ios --device 3F2504E0-4F89-11D3-9A0C-0305E82C3301"
    #expect(DebugLogRedaction.redact(line) == line)
  }

  @Test func hidesSettingValues() {
    #expect(
      DebugLog.CLIRun.loggable(["settings", "set", "android.keystorePassword", "hunter2", "--scope", "machine"])
        == ["settings", "set", "android.keystorePassword", "[redacted]", "--scope", "machine"])
  }

  @Test func singleLineCapsLength() {
    #expect(DebugLogRedaction.singleLine("a\nb\r\nc") == "a | b | c")
    #expect(DebugLogRedaction.singleLine(String(repeating: "x", count: 50), limit: 10) == "xxxxxxxxxx...")
  }

  @Test func quietLevelKeepsWarningsAndErrors() {
    #expect(!DebugLog.shouldLog(.debug, verbose: false))
    #expect(!DebugLog.shouldLog(.info, verbose: false))
    #expect(DebugLog.shouldLog(.warning, verbose: false))
    #expect(DebugLog.shouldLog(.error, verbose: false))
    #expect(DebugLog.shouldLog(.debug, verbose: true))
  }

  @Test func extractsStimErrorCode() {
    #expect(DebugLog.stimCode(in: "error STIM_BAD_ARG: unknown flag") == "STIM_BAD_ARG")
    #expect(DebugLog.stimCode(in: "plain failure") == nil)
  }

  @Test func decodeFailureNamesTypeAndCodingPath() throws {
    struct Inner: Decodable { var count: Int }
    struct Outer: Decodable { var items: [Inner] }
    let json = Data(#"{"items":[{"count":1},{"count":"two"}]}"#.utf8)
    do {
      _ = try JSONDecoder().decode(Outer.self, from: json)
      Issue.record("decoding succeeded")
    } catch let error as DecodingError {
      #expect(DebugLog.describe(error) == "expected Int at .items[1].count")
    }
  }

  @Test func onlyTheReleaseBundleWritesDesktopLog() {
    #expect(DebugLog.logFileName(bundleIdentifier: "dev.stim.desktop") == "Desktop.log")
    #expect(DebugLog.logFileName(bundleIdentifier: nil) == "Desktop.log")
    #expect(DebugLog.logFileName(bundleIdentifier: "dev.stim.desktop.dev") == "Desktop-dev.log")
    #expect(DebugLog.logFileName(bundleIdentifier: "dev.stim.desktop.minitest2") == "Desktop-minitest2.log")
    #expect(DebugLog.logFileName(bundleIdentifier: "com.example/app") == "Desktop-com.example-app.log")
  }

  @Test func rotationKeepsBoundedFiles() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("debuglog-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = DebugLogFile(url: directory.appendingPathComponent("Desktop.log"), maxBytes: 100, keep: 2)
    for index in 0..<20 { file.appendSync(String(format: "line %02d %@\n", index, String(repeating: "x", count: 30))) }
    let names = try FileManager.default.contentsOfDirectory(atPath: directory.path).sorted()
    #expect(names == ["Desktop.1.log", "Desktop.2.log", "Desktop.log"])
    let current = try String(contentsOf: directory.appendingPathComponent("Desktop.log"), encoding: .utf8)
    #expect(current.contains("line 19"))
    for name in names {
      let size = try FileManager.default.attributesOfItem(atPath: directory.appendingPathComponent(name).path)[.size] as? Int
      #expect((size ?? 0) <= 100)
    }
  }
}
