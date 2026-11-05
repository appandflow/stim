import AppKit
import StimKit
import SwiftUI

struct NativeViewerPermissionsView: View {
  @ObservedObject var permissions: NativeViewerPermissions
  var relaunch: (() -> Void)?
  private var polls = true
  @State private var skipped: Set<Int> = []

  init(permissions: NativeViewerPermissions, relaunch: (() -> Void)? = nil) {
    self.permissions = permissions
    self.relaunch = relaunch
  }

  #if DEBUG
    init(permissions: NativeViewerPermissions, relaunch: (() -> Void)?, polls: Bool, skipped: Set<Int>) {
      self.init(permissions: permissions, relaunch: relaunch)
      self.polls = polls
      _skipped = State(initialValue: skipped)
    }
  #endif

  private static let titles = ["Screen Recording", "Device Control", "Done"]

  private func granted(_ index: Int) -> Bool { index == 0 ? permissions.screenRecording : permissions.accessibility }

  private var step: Int { (0..<2).first { !granted($0) && !skipped.contains($0) } ?? 2 }
  private var allGranted: Bool { granted(0) && granted(1) }

  var body: some View {
    HStack(spacing: 0) {
      VStack(alignment: .leading, spacing: Space.sm) {
        Text("Native App Viewer").font(.stim(.headline)).padding(.bottom, Space.xl)
        ForEach(Array(Self.titles.enumerated()), id: \.offset) { index, title in
          let done = index < 2 ? granted(index) : allGranted
          let current = index == step
          let skippedStep = index < 2 && !done && skipped.contains(index)
          HStack(spacing: Space.md) {
            Image(
              systemName: done
                ? "checkmark.circle.fill" : skippedStep ? "minus.circle" : current ? "circle.inset.filled" : "circle")
            Text(title).font(.stim(.callout, weight: current ? .semibold : .regular))
          }
          .foregroundStyle(current ? (done ? Palette.success : Palette.accent) : done ? Palette.secondary : Palette.tertiary)
          .frame(height: 30)
          .accessibilityLabel(title + (done ? ", done" : skippedStep ? ", skipped" : current ? ", current step" : ", waiting"))
        }
        Spacer()
      }
      .padding(Space.xl).frame(width: 170).background(Palette.sidebar)
      Divider()
      VStack(spacing: 0) {
        content
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
          .padding(Space.xxl)
        Divider()
        footer.padding(Space.xl)
      }
    }
    .frame(width: 740, height: 520)
    .font(.stim(.body)).foregroundStyle(Palette.text).tint(Palette.primary)
    .background(Palette.background)
    .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
      if polls { permissions.poll() }
    }
    .task(id: polls) {
      while polls && !Task.isCancelled {
        try? await Task.sleep(for: .seconds(2))
        guard !Task.isCancelled else { return }
        permissions.poll()
      }
    }
  }

  @ViewBuilder private var content: some View {
    VStack(alignment: .leading, spacing: Space.lg) {
      switch step {
      case 0:
        ViewerScreenArt()
        permissionContent(
          title: permissions.screenPermissionTitle,
          use: PhoneApp.Copy.screenPermissionUse(phoneApp: FeatureFlags.isEnabled(.phoneApp)),
          alias: permissions.screenPermissionAlias, pane: "Privacy_ScreenCapture")
      case 1:
        ViewerControlArt()
        permissionContent(
          title: permissions.controlPermissionTitle,
          use: "Lets you click, scroll and type in the app's window, and bring it forward.",
          alias: permissions.controlPermissionAlias, pane: "Privacy_Accessibility")
      default:
        doneContent
      }
      if permissions.serverOwned == false {
        Banner(tone: .warning, icon: "exclamationmark.triangle") {
          Text(
            "This server was started outside this Desktop app. Grant permissions to the app that started the server, or start it from Stim Desktop."
          )
        }
      }
    }
  }

  private func permissionContent(title: String, use: String, alias: String?, pane: String) -> some View {
    VStack(alignment: .leading, spacing: Space.md) {
      Text(title).font(.stim(.title))
      Text(use).foregroundStyle(Palette.secondary).fixedSize(horizontal: false, vertical: true)
      if let alias {
        Text(alias).font(.stim(.footnote)).foregroundStyle(Palette.tertiary)
      }
      HStack(spacing: Space.sm) {
        ProgressView().controlSize(.small)
        Text("Waiting for your approval in macOS. This updates by itself.").foregroundStyle(Palette.secondary)
      }
      .font(.stim(.footnote))
      .accessibilityElement(children: .combine)
    }
  }

  private var doneContent: some View {
    VStack(alignment: .leading, spacing: Space.lg) {
      ViewerReadyArt(complete: allGranted).id(allGranted)
      Text(allGranted ? "The Viewer Is Ready" : "The Viewer Is Set Up With Limits").font(.stim(.title))
      VStack(alignment: .leading, spacing: Space.sm) {
        resultLine(permissions.screenPermissionTitle, granted: permissions.screenRecording)
        resultLine(permissions.controlPermissionTitle, granted: permissions.accessibility)
      }
      Text(PhoneApp.Copy.screenPermissionDone(allowed: allGranted, phoneApp: FeatureFlags.isEnabled(.phoneApp)))
        .font(.stim(.footnote)).foregroundStyle(Palette.secondary).fixedSize(horizontal: false, vertical: true)
    }
  }

  private func resultLine(_ title: String, granted: Bool) -> some View {
    Label(
      granted ? "\(title) allowed" : "\(title) not allowed",
      systemImage: granted ? "checkmark.circle.fill" : "exclamationmark.triangle.fill"
    )
    .foregroundStyle(granted ? Palette.success : Palette.warning)
  }

  private var footer: some View {
    HStack(spacing: Space.md) {
      if step < 2 {
        Button("Not Now") { permissions.showsSetup = false }.buttonStyle(.stim()).keyboardShortcut(.cancelAction)
      }
      Spacer()
      switch step {
      case 0:
        Button("Skip") { skipped.insert(0) }.buttonStyle(.stim(.plain))
        Button("Open System Settings") { permissions.openSettings("Privacy_ScreenCapture") }.buttonStyle(.stim())
        Button("Allow Screen Recording") { permissions.requestScreenRecording() }
          .buttonStyle(.stim(.primary)).keyboardShortcut(.defaultAction)
      case 1:
        Button("Skip") { skipped.insert(1) }.buttonStyle(.stim(.plain))
        Button("Open System Settings") { permissions.openSettings("Privacy_Accessibility") }.buttonStyle(.stim())
        Button("Allow Device Control") { permissions.requestControl() }
          .buttonStyle(.stim(.primary)).keyboardShortcut(.defaultAction)
      default:
        if !allGranted {
          Button("Finish Setup") { skipped = [] }.buttonStyle(.stim())
        }
        if let relaunch {
          Button("Relaunch Stim", action: relaunch).buttonStyle(.stim())
        }
        Button("Done") { permissions.showsSetup = false }
          .buttonStyle(.stim(.primary)).keyboardShortcut(.defaultAction)
      }
    }
  }
}
