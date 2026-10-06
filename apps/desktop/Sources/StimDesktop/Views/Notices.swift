import AppKit
import StimKit
import SwiftUI

struct Notice: Identifiable {
  let id = UUID()
  var icon: String
  var tone: Tone = .accent
  var title: String
  var detail: String?
  var actionTitle: String
  var perform: @MainActor () -> Void
  var onDismiss: (@MainActor () -> Void)?
  var key: String?
  var workspacePath: String?
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

  func remove(_ id: Notice.ID) {
    guard let position = notices.firstIndex(where: { $0.id == id }) else { return }
    notices.remove(at: position)
    if position < index { index -= 1 }
    index = min(index, max(notices.count - 1, 0))
  }

  func removeAll() {
    notices = []
    index = 0
  }

  func dismiss(_ id: Notice.ID) {
    let onDismiss = notices.first { $0.id == id }?.onDismiss
    remove(id)
    onDismiss?()
  }

  func remove(key: String) {
    for notice in notices where notice.key == key { remove(notice.id) }
  }

  func dismissCards(notIn payload: StatusPayload) {
    for notice in notices {
      if let path = notice.workspacePath, !payload.lists(workspace: path) { remove(notice.id) }
    }
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
          Card(fill: Palette.raised, border: Palette.separator, clipsContent: false) {
            Color.clear
          }
          .shadow(color: .black.opacity(0.12), radius: 4, y: 1)
          .padding(.horizontal, CGFloat(depth + 1) * Space.md)
          .frame(height: 40)
          .offset(y: CGFloat(depth + 1) * Space.md)
          .accessibilityHidden(true)
        }
        NoticeCard(notice: notice, center: center)
          .id(notice.id)
          .transition(reduceMotion ? .opacity : .move(edge: .leading).combined(with: .opacity))
      }
    }
    .frame(width: 320)
    .padding(.leading, Space.xl)
    .padding(.bottom, Space.xl + CGFloat(min(max(center.notices.count - 1, 0), 2)) * Space.md)
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
