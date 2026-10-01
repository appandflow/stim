import AppKit
import StimKit
import SwiftUI

/// A card at the main window's bottom left for news the user can act on later: it stays until it is acted on or
/// dismissed, so it never competes with the page they are on.
struct Notice: Identifiable {
  let id = UUID()
  var icon: String
  var tone: Tone = .accent
  var title: String
  var detail: String?
  var actionTitle: String
  var perform: @MainActor () -> Void
  var onDismiss: (@MainActor () -> Void)?
  /// Showing a notice replaces any shown one with the same key.
  var key: String?
}

@MainActor
final class NoticeCenter: ObservableObject {
  static let shared = NoticeCenter()

  @Published private(set) var notices: [Notice] = []
  @Published private(set) var index = 0

  var current: Notice? { notices.indices.contains(index) ? notices[index] : nil }

  func show(_ notice: Notice) {
    if let key = notice.key { notices.removeAll { $0.key == key } }
    notices.insert(notice, at: 0)
    index = 0
    guard NSWorkspace.shared.isVoiceOverEnabled else { return }
    let text = [notice.title, notice.detail, "Action: \(notice.actionTitle)"].compactMap { $0 }.joined(separator: ". ")
    NSAccessibility.post(
      element: NSApp as Any, notification: .announcementRequested,
      userInfo: [.announcement: text, .priority: NSAccessibilityPriorityLevel.high.rawValue])
  }

  func step(_ offset: Int) {
    guard !notices.isEmpty else { return }
    index = (index + offset + notices.count) % notices.count
  }

  /// Takes the notice away after the user acted on it or it stopped applying; `onDismiss` runs only for a dismissal.
  func remove(_ id: Notice.ID) {
    notices.removeAll { $0.id == id }
    index = min(index, max(notices.count - 1, 0))
  }

  func dismiss(_ id: Notice.ID) {
    let onDismiss = notices.first { $0.id == id }?.onDismiss
    remove(id)
    onDismiss?()
  }

  func remove(key: String) {
    for notice in notices where notice.key == key { remove(notice.id) }
  }
}

struct NoticeStack: View {
  @ObservedObject var center: NoticeCenter
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    ZStack(alignment: .bottom) {
      if let notice = center.current {
        let behind = min(center.notices.count - 1, 2)
        ForEach(Array((0..<behind).reversed()), id: \.self) { depth in
          RoundedRectangle(cornerRadius: Radius.card)
            .fill(.regularMaterial)
            .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Palette.border))
            .padding(.horizontal, CGFloat(depth + 1) * Space.md)
            .frame(height: 40)
            .offset(y: CGFloat(depth + 1) * Space.sm)
            .accessibilityHidden(true)
        }
        NoticeCard(notice: notice, center: center)
          .id(notice.id)
          .transition(reduceMotion ? .opacity : .move(edge: .leading).combined(with: .opacity))
      }
    }
    .frame(width: 320)
    .padding(.leading, Space.xl)
    .padding(.bottom, Space.xl + CGFloat(min(max(center.notices.count - 1, 0), 2)) * Space.sm)
    .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: center.notices.map(\.id))
    .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: center.index)
  }
}

private struct NoticeCard: View {
  var notice: Notice
  @ObservedObject var center: NoticeCenter

  var body: some View {
    Banner(tone: notice.tone, icon: notice.icon, style: .floating, onDismiss: { center.dismiss(notice.id) }) {
      if center.notices.count > 1 { stepper }
      Text(notice.title).font(.stim(.headline)).lineLimit(2)
      if let detail = notice.detail {
        Text(detail).foregroundStyle(Palette.secondary).lineLimit(1).truncationMode(.middle)
      }
      Button(notice.actionTitle) {
        center.remove(notice.id)
        notice.perform()
      }
      .buttonStyle(.stim(.primary))
      .padding(.top, Space.xxs)
    }
    .accessibilityElement(children: .contain)
  }

  private var stepper: some View {
    HStack(spacing: Space.xs) {
      stepButton("chevron.left", label: "Previous notice", offset: -1)
      Text("\(center.index + 1) of \(center.notices.count)")
        .textStyle(.caption, weight: .semibold)
        .foregroundStyle(Palette.secondary)
        .monospacedDigit()
      stepButton("chevron.right", label: "Next notice", offset: 1)
    }
  }

  private func stepButton(_ symbol: String, label: String, offset: Int) -> some View {
    Button {
      center.step(offset)
    } label: {
      Image(systemName: symbol).font(.system(size: 10, weight: .semibold)).foregroundStyle(Palette.tertiary)
    }
    .buttonStyle(.hoverRow(outset: Space.xs))
    .help(label)
    .accessibilityLabel(label)
  }
}
