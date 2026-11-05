#if DEBUG
  import AppKit
  import StimKit
  import SwiftUI
  import XCTest

  @testable import StimDesktop
  @testable import StimKit

  final class BuildLedgerScreenshotTests: XCTestCase {
    private func line(
      _ id: String, minutesAgo: Double, platform: String = "ios", project: String = "/Users/me/dev/mobile-app",
      outcome: String = "succeeded", placement: String = #"{"where":"local"}"#,
      cache: String = #"{"result":"miss","key":"a1b2c3-debug-sim","fingerprint":"9f8e7d6c"}"#, durationMs: Int = 142_000,
      phases: String = #"{"prepare":3000,"cache-lookup":1000,"pods":21000,"compile":104000,"install":6000,"launch":7000}"#,
      extra: String = ""
    ) -> String {
      let ts = Int((Date().timeIntervalSince1970 - minutesAgo * 60) * 1000)
      return """
        {"ts":\(ts),"src":"builds","level":"info","msg":"m","event":"build","id":"\(id)","startedAt":\(ts - durationMs),\
        "project":"\(project)","workspace":"w--1","branch":"feat/checkout","platform":"\(platform)",\
        "configuration":"Debug","placement":\(placement),"cache":\(cache),"durationMs":\(durationMs),"phases":\(phases),\
        "outcome":"\(outcome)","stimVersion":"1.26.0"\(extra)}
        """
    }

    private func parse(_ lines: [String]) -> [LedgerBuild] {
      BuildLedger.parse(Data(lines.joined(separator: "\n").utf8))
    }

    private var items: [LedgerBuild] {
      parse([
        line(
          "a", minutesAgo: 4, extra: #","scheme":"MobileApp","device":{"name":"stim-checkout (iPhone 17)","runtime":"iOS 26.0"}"#),
        line(
          "b", minutesAgo: 35, platform: "android",
          placement: #"{"where":"offloaded","machine":"janics-mac-mini"}"#,
          durationMs: 318_000, phases: #"{"prepare":2000,"cache-lookup":1000,"compile":290000,"install":15000,"launch":10000}"#,
          extra:
            #","variant":"debug","offloadPhases":{"sync":18000,"deps":42000,"build":201000,"fetch":29000},"device":{"name":"stim-checkout"}"#
        ),
        line(
          "c", minutesAgo: 61, outcome: "failed", cache: #"{"result":"miss","key":"d4e5f6-debug-sim","fingerprint":"1a2b3c4d"}"#,
          durationMs: 88_000, phases: #"{"prepare":3000,"cache-lookup":1000,"pods":84000}"#,
          extra:
            #","failure":{"code":"STIM_POD_INSTALL_FAILED","message":"pod install exited 1: could not find compatible versions for pod \"RNScreens\"","remedy":"Run stim ios again after pnpm install, or delete ios/Pods and retry.","phase":"pods"}"#
        ),
        line(
          "d", minutesAgo: 62, cache: #"{"result":"hit","source":"remote","key":"77aa-debug-sim","fingerprint":"77aa"}"#,
          durationMs: 21_000, phases: #"{"prepare":2000,"cache-lookup":4000,"install":8000,"launch":7000}"#),
        line(
          "e", minutesAgo: 60 * 20, platform: "macos", project: "/Users/me/dev/website", outcome: "cancelled",
          placement: #"{"where":"local","fellBack":true,"reason":"janics-mac-mini is busy"}"#, durationMs: 40_000,
          phases: #"{"prepare":1000,"compile":39000}"#),
      ])
    }

    @MainActor private func render(_ name: String, in directory: String, opens: String?) throws {
      let view = BuildsView(history: BuildLedgerModel(items: items), opens: opens)
      for dark in [false, true] {
        let host = NSHostingView(
          rootView: view.font(.stim(.body)).foregroundStyle(Palette.text).background(Palette.background)
            .environment(\.colorScheme, dark ? .dark : .light))
        host.frame = NSRect(x: 0, y: 0, width: 900, height: opens == nil ? 640 : 1000)
        host.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        let window = NSWindow(contentRect: host.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.appearance = host.appearance
        window.contentView = host
        host.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.3))
        let rep = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds), "\(name) did not render")
        host.cacheDisplay(in: host.bounds, to: rep)
        let png = try XCTUnwrap(rep.representation(using: .png, properties: [:]))
        try png.write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(name)-\(dark ? "dark" : "light").png"))
      }
    }

    @MainActor func testBuildsScreenshots() throws {
      guard let directory = ProcessInfo.processInfo.environment["STIM_BUILDS_SHOTS"] else {
        throw XCTSkip("Set STIM_BUILDS_SHOTS to render the Builds fixtures.")
      }
      _ = NSApplication.shared
      BrandAssets.registerFonts()
      try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
      try render("builds-list", in: directory, opens: nil)
      try render("builds-failed", in: directory, opens: "c")
      try render("builds-offloaded", in: directory, opens: "b")
    }
  }
#endif
