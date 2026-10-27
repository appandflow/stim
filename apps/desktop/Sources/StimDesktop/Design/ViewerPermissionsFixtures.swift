#if DEBUG
  import SwiftUI

  enum ViewerPermissionsFixture: String, CaseIterable, Identifiable {
    case screenRecording, deviceControl, ready, readyWithLimits, otherServer
    var id: Self { self }

    @MainActor func make() -> NativeViewerPermissions {
      switch self {
      case .screenRecording: NativeViewerPermissions(screenRecording: false, accessibility: false)
      case .deviceControl: NativeViewerPermissions(screenRecording: true, accessibility: false)
      case .ready: NativeViewerPermissions(screenRecording: true, accessibility: true)
      case .readyWithLimits: NativeViewerPermissions(screenRecording: true, accessibility: false)
      case .otherServer: NativeViewerPermissions(screenRecording: false, accessibility: false, serverOwned: false)
      }
    }
  }

  struct ViewerPermissionsPlayground: View {
    @State private var fixture = ViewerPermissionsFixture.screenRecording
    @State private var permissions = ViewerPermissionsFixture.screenRecording.make()

    var body: some View {
      VStack(spacing: 0) {
        Picker("Sheet state", selection: $fixture) {
          ForEach(ViewerPermissionsFixture.allCases) { Text($0.rawValue).tag($0) }
        }.padding(Space.md)
        NativeViewerPermissionsView(
          permissions: permissions, relaunch: {}, polls: false, skipped: fixture == .readyWithLimits ? [1] : []
        ).id(fixture)
      }
      .onChange(of: fixture) { permissions = fixture.make() }
    }
  }
#endif
