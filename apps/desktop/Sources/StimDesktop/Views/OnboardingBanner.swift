import StimKit
import StimStores
import SwiftUI

/// A floating toast anchored to the bottom of the main content column: one problem at a time,
/// most important first, so it never resizes content or covers the toolbar or inspector.
struct OnboardingBanner: View {
  @ObservedObject var onboarding: Onboarding
  @EnvironmentObject private var actions: ActionCenter
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var showsCommand = false

  var body: some View {
    Group {
      if let report = onboarding.report, let kind = currentKind(report) {
        popup(kind, report)
          .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
      }
    }
    .frame(maxWidth: .infinity)
    .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: onboarding.report.flatMap(currentKind))
  }

  private func currentKind(_ report: Onboarding.Report) -> Onboarding.PopupKind? {
    if onboarding.showsGuide { return nil }
    if !report.viewerKeys.isEmpty,
      !onboarding.dismissedPopups.contains(.viewer)
    {
      return .viewer
    }
    return nil
  }

  @ViewBuilder
  private func popup(_ kind: Onboarding.PopupKind, _ report: Onboarding.Report) -> some View {
    switch kind {
    case .viewer: viewerPopup(report.viewerKeys)
    }
  }

  private func viewerPopup(_ keys: [String]) -> some View {
    popupCard(kind: .viewer, icon: "macwindow", tone: .accent) {
      Text("Show Stim's Devices in Stim Desktop").font(.stim(.headline))
      Text("Stim can open the simulators and emulators it boots here instead of in their own windows.")
        .foregroundStyle(Palette.secondary)
      disclosure {
        VStack(alignment: .leading, spacing: Space.sm) {
          ForEach(keys, id: \.self) { key in
            VStack(alignment: .leading, spacing: Space.xxs) {
              Text("stim settings set \(key) stim-desktop --scope machine").font(.stim(.caption, mono: true))
              Text(Self.viewerExplanation[key] ?? "").font(.stim(.caption)).foregroundStyle(Palette.secondary)
            }
          }
        }
      }
    } buttons: {
      runButton("Use Stim Desktop", variant: .primary, key: .viewer, action: onboarding.useDesktopViewer)
      Button("Not Now") { onboarding.dismissPopup(.viewer) }.buttonStyle(.stim())
    }
  }

  private static let viewerExplanation = [
    "iosSimulatorApp":
      "iOS: an owned simulator opens here, focused on its workspace, instead of in Xcode's Simulator app.",
    "androidEmulatorApp":
      "Android: Stim boots owned emulators without a window and shows them here. One already running keeps its window until it next boots.",
  ]

  @ViewBuilder
  private func disclosure<Content: View>(@ViewBuilder content: @escaping () -> Content) -> some View {
    DisclosureGroup("Show Command", isExpanded: $showsCommand) {
      content().font(.stim(.footnote)).foregroundStyle(Palette.tertiary).padding(.top, Space.xs)
    }
    .font(.stim(.footnote)).foregroundStyle(Palette.secondary)
  }

  @ViewBuilder
  private func runButton(
    _ title: String, variant: ButtonVariant = .secondary, key: Onboarding.PopupKind, action: @escaping () -> Void
  ) -> some View {
    if let active = actions.active(for: Onboarding.actionKey) {
      Button {
        actions.presented = active
      } label: {
        HStack(spacing: Space.sm) {
          ProgressView().controlSize(.small)
          Text("Running")
        }
      }
      .buttonStyle(.stim(variant))
    } else {
      Button(title, action: action).buttonStyle(.stim(variant))
    }
  }

  private func popupCard<Body: View, Buttons: View>(
    kind: Onboarding.PopupKind, icon: String, tone: Tone, @ViewBuilder text: () -> Body,
    @ViewBuilder buttons: () -> Buttons
  ) -> some View {
    Banner(tone: tone, icon: icon, style: .floating, onDismiss: { onboarding.dismissPopup(kind) }) {
      text()
      HStack(spacing: Space.md) { buttons() }.padding(.top, Space.xxs)
    }
    .frame(minWidth: 420, maxWidth: 520)
    .padding(.bottom, Space.xxl)
  }
}
