#if DEBUG
  import AppKit
  import StimKit
  import SwiftUI
  import XCTest

  @testable import StimDesktop
  @testable import StimStores

  final class ToolbarStatusErrorScreenshotTests: XCTestCase {
    @MainActor private func errorSummary() -> MachineSummary {
      let status = StatusStore(cli: Task { StimCLI(environment: ["PATH": "/nonexistent"]) })
      let gc = GcReportStore(run: { throw CancellationError() })
      let metrics = MetricsStore(status: status, gc: gc, disks: DiskVolumeStore(status: status))
      status.refresh()
      return MachineSummary(store: status, metrics: metrics, gc: gc, width: 600) {}
    }

    @MainActor func testToolbarStatusErrorScreenshots() throws {
      guard let directory = ProcessInfo.processInfo.environment["STIM_TOOLBAR_STATUS_SHOTS"] else {
        throw XCTSkip("Set STIM_TOOLBAR_STATUS_SHOTS to render the toolbar status error.")
      }
      _ = NSApplication.shared
      BrandAssets.registerFonts()
      try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
      for dark in [false, true] {
        let summary = errorSummary()
        XCTAssertNotNil(summary.store.error)
        let root = Color.clear
          .frame(width: 720, height: 160)
          .toolbar {
            ToolbarItem(placement: .navigation) {
              summary.frame(maxWidth: 600, alignment: .leading).frame(height: ToolbarMetrics.glassHeight)
            }
          }
          .environment(\.colorScheme, dark ? .dark : .light)
        let controller = NSHostingController(rootView: root)
        let window = NSWindow(contentViewController: controller)
        window.styleMask = [.titled]
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        window.setContentSize(NSSize(width: 720, height: 160))
        window.layoutIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        let frame = try XCTUnwrap(window.contentView?.superview)
        let rep = try XCTUnwrap(frame.bitmapImageRepForCachingDisplay(in: frame.bounds))
        frame.cacheDisplay(in: frame.bounds, to: rep)
        let png = try XCTUnwrap(rep.representation(using: .png, properties: [:]))
        try png.write(to: URL(fileURLWithPath: directory).appendingPathComponent("toolbar-\(dark ? "dark" : "light").png"))
      }
    }
  }
#endif
