import StimKit
import SwiftUI

struct TipCard: View {
  var topic: TipTopic
  var prompt: String?
  var hasNext: Bool
  var position: Int
  var total: Int
  var perform: () -> Void
  var previous: () -> Void
  var next: () -> Void
  var close: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: Space.sm) {
      HStack(spacing: Space.sm) {
        Image(systemName: "lightbulb")
          .iconFont(IconSize.large)
          .foregroundStyle(Palette.accent)
        Text("Tip").textStyle(.caption, weight: .semibold).foregroundStyle(Palette.secondary)
        Spacer()
        Button(action: close) {
          Image(systemName: "xmark")
            .iconFont(IconSize.compact, weight: .semibold)
            .foregroundStyle(Palette.tertiary)
        }
        .buttonStyle(.hoverRow(outset: Space.xs))
        .help("Dismiss")
        .accessibilityLabel("Dismiss")
      }
      Text(topic.title).font(.stim(.headline))
      Text(topic.body).font(.stim(.callout)).foregroundStyle(Palette.secondary)
      VStack(alignment: .center, spacing: Space.xs) {
        if let prompt {
          CopyButton(
            prompt, variant: .primary, title: topic.actionTitle, help: prompt,
            accessibilityLabel: "Copy prompt: \(topic.title)")
        } else {
          Button(action: perform) {
            Text(topic.actionTitle)
              .frame(maxWidth: topic == .hideWorkspaces || topic == .statusFilter ? nil : .infinity)
          }
          .buttonStyle(.stim(.primary, .small))
        }
        if hasNext {
          HStack(spacing: Space.lg) {
            Button(action: previous) { Image(systemName: "chevron.left") }
              .accessibilityLabel("Previous tip")
              .help("Previous tip")
            Button(action: next) { Image(systemName: "chevron.right") }
              .accessibilityLabel("Next tip")
              .help("Next tip")
          }
          .buttonStyle(.stim(.plain, .small))
        }
      }
      .frame(maxWidth: .infinity)
      .padding(.top, Space.xxs)
      Text("\(position)/\(total)")
        .font(.stim(.caption2))
        .foregroundStyle(Palette.secondary)
        .monospacedDigit()
        .frame(maxWidth: .infinity, alignment: .trailing)
        .accessibilityLabel("Tip \(position) of \(total)")
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(Space.xl)
    .background(RoundedRectangle(cornerRadius: Radius.card).fill(Palette.accent.opacity(Opacity.pressed)))
    .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Palette.accent.opacity(0.35)))
    .accessibilityElement(children: .contain)
  }
}
