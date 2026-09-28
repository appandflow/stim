import StimKit
import SwiftUI

struct InboxView: View {
  @ObservedObject var inbox: NotificationInbox
  @State private var filter = InboxFilter()
  @State private var confirmsClear = false

  var body: some View {
    let days = inbox.inbox.days(filter)
    ScrollView {
      VStack(alignment: .leading, spacing: Space.xxl) {
        header(empty: days.isEmpty)
        if days.isEmpty {
          EmptyState(
            title: filter == InboxFilter() ? "No notifications" : "Nothing matches",
            message: filter == InboxFilter()
              ? "What Stim notifies about in the last 7 days appears here, including Silent and Off categories."
              : "No notification matches these filters.")
          .frame(maxWidth: .infinity)
          .padding(.top, Space.huge)
        }
        ForEach(days, id: \.day) { day in
          VStack(alignment: .leading, spacing: Space.md) {
            Text(Self.dayTitle(day.day)).font(.stim(.headline))
            Card {
              VStack(spacing: 0) {
                ForEach(Array(day.entries.enumerated()), id: \.element.id) { index, entry in
                  if index > 0 { Rectangle().fill(Palette.border).frame(height: 1) }
                  InboxRow(entry: entry) { inbox.open(entry) }
                }
              }
            }
          }
        }
      }
      .padding(Space.xxxl)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .confirmationDialog("Clear these notifications?", isPresented: $confirmsClear) {
      Button("Clear", role: .destructive) { inbox.clear(filter) }
    } message: {
      Text("They are removed from this Mac's notification history.")
    }
  }

  private func header(empty: Bool) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: Space.md) {
      Text("Notifications").font(.stim(.title))
      Spacer()
      Picker("Category", selection: $filter.category) {
        Text("All categories").tag(OversightCategory?.none)
        ForEach(OversightCategory.desktop, id: \.self) { category in
          Label(category.label, systemImage: category.symbol).tag(Optional(category))
        }
      }
      .labelsHidden()
      .fixedSize()
      .help("Show one category")
      Picker("Workspace", selection: $filter.workspace) {
        Text("All workspaces").tag(String?.none)
        Text("Machine").tag(Optional(""))
        ForEach(workspaceChoices, id: \.path) { workspace in
          Text(workspace.title).tag(Optional(workspace.path))
        }
      }
      .labelsHidden()
      .fixedSize()
      .help("Show one workspace")
      Button("Mark all read") { inbox.markAllRead(filter) }
        .buttonStyle(.stim())
        .disabled(!inbox.inbox.entries.contains { !$0.read && filter.matches($0) })
      Button("Clear") { confirmsClear = true }
        .buttonStyle(.stim(.destructive))
        .disabled(empty)
    }
  }

  private var workspaceChoices: [(path: String, title: String)] {
    let listed = inbox.inbox.workspaces
    guard let selected = filter.workspace, !selected.isEmpty, !listed.contains(where: { $0.path == selected }) else {
      return listed
    }
    return listed + [(selected, URL(fileURLWithPath: selected).lastPathComponent)]
  }

  static func dayTitle(_ day: Date) -> String {
    let calendar = Calendar.current
    if calendar.isDateInToday(day) { return "Today" }
    if calendar.isDateInYesterday(day) { return "Yesterday" }
    return day.formatted(.dateTime.weekday(.wide).month(.abbreviated).day())
  }
}

private struct InboxRow: View {
  var entry: InboxEntry
  var open: () -> Void
  @State private var hovering = false

  var body: some View {
    HStack(alignment: .top, spacing: Space.lg) {
      Circle().fill(entry.read ? Color.clear : Palette.primary).frame(width: 8, height: 8).padding(.top, 6)
        .accessibilityHidden(true)
      Image(systemName: entry.category.symbol)
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(OversightNotifier.tone(entry.category).color)
        .frame(width: 20)
        .padding(.top, 1)
        .help(entry.category.label)
      VStack(alignment: .leading, spacing: Space.xxs) {
        HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
          Text(entry.title).textStyle(.callout, weight: entry.read ? nil : .semibold).lineLimit(1)
          Spacer(minLength: Space.md)
          Text(detail).textStyle(.caption).foregroundStyle(Palette.tertiary).lineLimit(1)
        }
        Text(entry.body).textStyle(.footnote).foregroundStyle(Palette.secondary).lineLimit(2)
      }
      Button(entry.target.actionTitle, action: open).buttonStyle(.stim())
    }
    .padding(.horizontal, Space.xl)
    .padding(.vertical, Space.lg)
    .background(hovering ? Palette.accent.opacity(Opacity.subtle / 2) : .clear)
    .contentShape(Rectangle())
    .onTapGesture(perform: open)
    .onHover { hovering = $0 }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(
      "\(entry.read ? "" : "Unread, ")\(entry.category.label), \(entry.title), \(entry.body), \(detail)")
    .accessibilityAddTraits(.isButton)
    .accessibilityAction(named: entry.target.actionTitle, open)
  }

  private var detail: String {
    let time = entry.date.formatted(date: .omitted, time: .shortened)
    return entry.suppressed.map { "\(time) \u{00B7} \($0.title)" } ?? time
  }
}
