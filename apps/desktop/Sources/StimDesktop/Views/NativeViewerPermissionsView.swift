import AppKit
import StimKit
import SwiftUI

struct NativeViewerPermissionsView: View {
  @ObservedObject var permissions: NativeViewerPermissions

  var body: some View {
    VStack(alignment: .leading, spacing: Space.xl) {
      Label("Native app viewer", systemImage: "macwindow")
        .font(.stim(.title))
      Text(
        "Allow Stim to show your native Mac app and send clicks, scrolling and typing to its owned window. You choose the permissions in macOS; builds, status and logs work without them."
      )
      .foregroundStyle(Palette.secondary)
      permission(
        permissions.screenPermissionTitle, detail: permissions.screenPermissionDetail,
        allowed: permissions.screenRecording, pane: "Privacy_ScreenCapture")
      permission(
        permissions.controlPermissionTitle,
        detail: permissions.controlPermissionDetail,
        allowed: permissions.accessibility, pane: "Privacy_Accessibility")
      if permissions.serverOwned == false {
        Text(
          "This server was started outside this Desktop app. Grant permissions to the app that started the server, or start it from Stim Desktop. A grant to this copy of Stim may not apply to that server."
        )
        .foregroundStyle(Palette.secondary)
      } else {
        Text(
          "Allow this Stim app in the system dialog. After granting access, reconnect the phone viewer to verify the server's capture access; if macOS asks for a relaunch, follow its instructions."
        )
        .foregroundStyle(Palette.secondary)
      }
      HStack {
        Button("Not now") { permissions.showsSetup = false }.buttonStyle(.stim(.plain))
        Spacer()
        Button("Check again") { permissions.refresh() }.buttonStyle(.stim())
        if permissions.screenRecording && permissions.accessibility {
          Button("Done") { permissions.showsSetup = false }.buttonStyle(.stim(.primary))
        } else {
          Button("Request permissions") { permissions.requestPermissions() }.buttonStyle(.stim(.primary))
        }
      }
    }
    .padding(Space.xxl)
    .frame(width: 580)
    .background(Palette.background)
    .font(.stim(.body))
    .foregroundStyle(Palette.text)
    .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
      permissions.refresh()
    }
  }

  private func permission(_ title: String, detail: String, allowed: Bool, pane: String) -> some View {
    HStack(alignment: .top, spacing: Space.md) {
      Image(systemName: allowed ? "checkmark.circle.fill" : "circle")
        .foregroundStyle(allowed ? Palette.success : Palette.secondary)
      VStack(alignment: .leading, spacing: Space.xs) {
        HStack {
          Text(title).font(.stim(.headline))
          Text(allowed ? "Allowed" : "Needed").foregroundStyle(Palette.secondary)
        }
        Text(detail).foregroundStyle(Palette.secondary).fixedSize(horizontal: false, vertical: true)
      }
      Spacer()
      Button("Settings") { permissions.openSettings(pane) }.buttonStyle(.stim())
    }
  }
}
