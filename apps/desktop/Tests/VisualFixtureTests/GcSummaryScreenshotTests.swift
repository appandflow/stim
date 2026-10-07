#if DEBUG
  import AppKit
  import StimKit
  import SwiftUI
  import XCTest

  @testable import StimDesktop

  final class GcSummaryScreenshotTests: XCTestCase {
    @MainActor func testGcSummaryScreenshots() throws {
      guard let directory = ProcessInfo.processInfo.environment["STIM_GC_SUMMARY_SHOTS"] else {
        throw XCTSkip("Set STIM_GC_SUMMARY_SHOTS to render the notification text.")
      }
      _ = NSApplication.shared
      BrandAssets.registerFonts()
      try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
      let json = """
        {"mode":"delete","failures":0,"sections":{},"results":[
          {"kind":"worktree","status":"done","label":"/r/.worktrees/fix-login","id":null,"bytes":null,"detail":null},
          {"kind":"worktree","status":"done","label":"/r/.worktrees/add-dark-mode","id":null,"bytes":null,"detail":null},
          {"kind":"device","status":"done","label":"stim-a (iPhone 18 Pro 27.0)","id":"U1","bytes":null,"detail":null},
          {"kind":"workspaceOutputs","status":"done","label":"/p/app","id":null,"bytes":3800000000,"detail":null}
        ]}
        """
      let body = try GcOutcome(json: Data(json.utf8)).summary(name: { PathNames(path: $0).title })
      for dark in [false, true] {
        let view = ZStack {
          Palette.background
          Card {
            VStack(alignment: .leading, spacing: Space.sm) {
              Text("Notification text").textStyle(.caption).foregroundStyle(Palette.secondary)
              Text("Free disk is under the Stim budget").font(.stim(.headline))
              Text(body).foregroundStyle(Palette.secondary)
            }
            .padding(Space.md)
          }
          .padding(Space.xl)
        }
        .frame(width: 420, height: 200)
        let renderer = ImageRenderer(
          content: view.environment(\.colorScheme, dark ? .dark : .light).environment(\.locale, Locale(identifier: "en_US")))
        renderer.scale = 2
        let image = try XCTUnwrap(renderer.cgImage)
        let png = try XCTUnwrap(NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]))
        try png.write(to: URL(fileURLWithPath: directory).appendingPathComponent("gc-summary-\(dark ? "dark" : "light").png"))
      }
    }
  }
#endif
