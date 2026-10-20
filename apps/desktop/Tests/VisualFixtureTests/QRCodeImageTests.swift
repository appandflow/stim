#if DEBUG
  import AppKit
  import SwiftUI
  import Vision
  import XCTest

  @testable import StimDesktop

  final class QRCodeImageTests: XCTestCase {
    @MainActor func testBrandedInstallationCodesRemainScannable() throws {
      _ = NSApplication.shared
      for dark in [false, true] {
        for scale in [CGFloat(1), 2] {
          let renderer = ImageRenderer(
            content: PairPhoneSheet(model: PairPhoneFixture.app.make())
              .environment(\.colorScheme, dark ? .dark : .light))
          renderer.scale = scale
          let image = try XCTUnwrap(renderer.cgImage)
          let request = VNDetectBarcodesRequest()
          request.symbologies = [.qr]
          try VNImageRequestHandler(cgImage: image).perform([request])
          XCTAssertEqual(
            Set(request.results?.compactMap(\.payloadStringValue) ?? []),
            Set([PhoneInstallApp.stim.storeURL.absoluteString, PhoneInstallApp.tailscale.storeURL.absoluteString]))
        }
      }
    }
  }
#endif
