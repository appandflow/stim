import XCTest

@testable import StimKit

final class CrashScrubberTests: XCTestCase {
  private let scrubber = CrashScrubber(
    hostNames: ["Janics-MacBook-Pro.local", "Janics-MacBook-Pro", "Janic's MacBook Pro"], appBundleName: "Stim.app")

  func testRemovesWorkspaceAndHomePaths() {
    XCTAssertEqual(
      scrubber.scrub("stim start failed in /Users/janic/Developer/stim-1659-sentry/apps/mobile: exit 1"),
      "stim start failed in <path>: exit 1")
    XCTAssertEqual(scrubber.scrub("open ~/Developer/app (branch feat/x)"), "open <path> (branch feat/x)")
    XCTAssertEqual(scrubber.scrub("/Volumes/SSD/work/app"), "<path>")
    XCTAssertEqual(scrubber.scrub("file:///Users/janic/app/index.js"), "file://<path>")
  }

  func testKeepsSystemPathsAndTheAppBundleTail() {
    XCTAssertEqual(
      scrubber.scrub("/System/Library/Frameworks/AppKit.framework/Versions/C/AppKit"),
      "/System/Library/Frameworks/AppKit.framework/Versions/C/AppKit")
    XCTAssertEqual(scrubber.scrub("/usr/lib/libobjc.A.dylib"), "/usr/lib/libobjc.A.dylib")
    XCTAssertEqual(
      scrubber.scrub("/Users/janic/Downloads/Stim.app/Contents/MacOS/StimDesktop"),
      "<path>/Stim.app/Contents/MacOS/StimDesktop")
    XCTAssertEqual(
      scrubber.scrub("/Applications/Stim.app/Contents/MacOS/StimDesktop"),
      "/Applications/Stim.app/Contents/MacOS/StimDesktop")
  }

  func testRemovesHostNamesAndPrivateAddresses() {
    XCTAssertEqual(scrubber.scrub("connected to Janics-MacBook-Pro.local"), "connected to <host>")
    XCTAssertEqual(scrubber.scrub("Janic's MacBook Pro is busy"), "<host> is busy")
    XCTAssertEqual(scrubber.scrub("peer mini.tail1234.ts.net at 100.101.102.103"), "peer <host> at <ip>")
    XCTAssertEqual(scrubber.scrub("fd7a:115c:a1e0::1234 refused"), "<ip> refused")
  }

  func testRemovesURLHostsAndQueriesButKeepsLocalhost() {
    XCTAssertEqual(
      scrubber.scrub("GET https://user:pw@api.example.com:8443/v1/pairs?token=abc&x=1 failed"),
      "GET https://<host>:8443/v1/pairs?<redacted> failed")
    XCTAssertEqual(
      scrubber.scrub("http://localhost:8081/index.bundle?platform=ios"),
      "http://localhost:8081/index.bundle?<redacted>")
  }

  func testRemovesCredentials() {
    XCTAssertEqual(scrubber.scrub("Authorization: Bearer eyJhbGciOi.abc"), "Authorization: <redacted> <redacted>")
    XCTAssertEqual(scrubber.scrub("pairingToken=s3cr3t other"), "pairingToken=<redacted> other")
    XCTAssertEqual(scrubber.scrub(#"{"pushToken":"abc123"}"#), #"{"pushToken":"<redacted>"}"#)
    XCTAssertEqual(
      scrubber.scrub("key 9f8e7d6c5b4a39281706f5e4d3c2b1a0ZYXWVUTSRQ ok"), "key <redacted> ok")
  }

  func testLeavesOrdinaryTextAlone() {
    let text = "NSInvalidArgumentException: exit code 1 in apps/mobile, stim 1.2.3, port 8084, 12:30:45"
    XCTAssertEqual(scrubber.scrub(text), text)
  }

  func testScrubsNestedValues() {
    let value = scrubber.scrub(["path": "/Users/janic/x", "list": ["Janics-MacBook-Pro", 3], "n": 4] as [String: Any])
    let dictionary = value as? [String: Any]
    XCTAssertEqual(dictionary?["path"] as? String, "<path>")
    XCTAssertEqual((dictionary?["list"] as? [Any])?.first as? String, "<host>")
    XCTAssertEqual((dictionary?["list"] as? [Any])?.last as? Int, 3)
    XCTAssertEqual(dictionary?["n"] as? Int, 4)
  }
}
