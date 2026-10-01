import AppKit
import StimKit
import StimStores
import SwiftUI

struct InboxView: View {
  @ObservedObject var inbox: NotificationInbox
  var openLogs: (String) -> Void
  @EnvironmentObject private var actions: ActionCenter
  @State private var filter = InboxFilter()
  @State private var confirmsClear = false
  @State private var fixing: (title: String, command: StimCommand)?

  var body: some View {
    let days = inbox.inbox.days(filter)
    let titles = inbox.inbox.displayTitles
    ScrollView {
      VStack(alignment: .leading, spacing: Space.xxl) {
        header(empty: days.isEmpty)
        if days.isEmpty {
          EmptyState(
            title: filter == InboxFilter() ? "No notifications" : "Nothing matches",
            message: filter == InboxFilter()
              ? "What Stim notifies about in the last 7 days appears here, including Silent and Off categories."
              : "No notification matches these filters."
          )
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
                  InboxRow(
                    entry: entry, title: titles[entry.id] ?? entry.title, openLogs: openLogs,
                    run: { actions.run("Fix \($0)", $1) }, fix: { fixing = ($0, $1) }
                  ) { inbox.open(entry) }
                }
              }
            }
          }
        }
      }
      .padding(Space.xxxl)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .confirmationDialog(
      "Run stim doctor --fix?", isPresented: Binding(get: { fixing != nil }, set: { if !$0 { fixing = nil } }),
      titleVisibility: .visible, presenting: fixing
    ) { fix in
      Button("Run the fix") { actions.run("Fix \(fix.title)", fix.command) }
    } message: { fix in
      Text(
        "\(fix.command.displayLine())\n\nStop native builds in this checkout first. Doctor repairs only what its report names.")
    }
    .confirmationDialog("Clear these notifications?", isPresented: $confirmsClear) {
      Button("Clear", role: .destructive) { inbox.clear(filter) }
    } message: {
      Text("They are removed from this Mac's notification history.")
    }
  }

  private func header(empty: Bool) -> some View {
    ViewThatFits(in: .horizontal) {
      HStack(alignment: .firstTextBaseline, spacing: Space.md) {
        title
        Spacer()
        filters(empty: empty)
      }
      VStack(alignment: .leading, spacing: Space.lg) {
        title
        HStack(spacing: Space.md) { filters(empty: empty) }
      }
    }
  }

  private var title: some View {
    Text("Notifications").font(.stim(.title)).fixedSize()
  }

  @ViewBuilder private func filters(empty: Bool) -> some View {
    MenuPill(
      label: "Category",
      selection: $filter.category,
      options: [MenuPillOption(value: OversightCategory?.none, title: "All categories")]
        + OversightCategory.desktop.map {
          MenuPillOption(value: Optional($0), title: $0.label, symbol: $0.symbol)
        },
      isActive: filter.category != nil
    )
    .help("Show one category")
    MenuPill(
      label: "Workspace",
      selection: $filter.workspace,
      options: [
        MenuPillOption(value: String?.none, title: "All workspaces"),
        MenuPillOption(value: Optional(""), title: "Machine"),
      ] + workspaceChoices.map { MenuPillOption(value: Optional($0.path), title: $0.title) },
      isActive: filter.workspace != nil
    )
    .help("Show one workspace")
    Button("Mark all read") { inbox.markAllRead(filter) }
      .buttonStyle(.stim())
      .fixedSize()
      .disabled(!inbox.inbox.entries.contains { !$0.read && filter.matches($0) })
    Button("Clear") { confirmsClear = true }
      .buttonStyle(.stim(.destructive))
      .fixedSize()
      .disabled(empty)
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
  var title: String
  var openLogs: (String) -> Void
  var run: (String, StimCommand) -> Void
  var fix: (String, StimCommand) -> Void
  var open: () -> Void
  @EnvironmentObject private var actions: ActionCenter

  var body: some View {
    HStack(alignment: .center, spacing: Space.lg) {
      Circle().fill(entry.read ? Color.clear : Palette.primary).frame(width: 8, height: 8)
        .accessibilityHidden(true)
      Image(systemName: entry.category.symbol)
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(Color(OversightNotifier.tone(entry.category)))
        .frame(width: 20)
        .help(entry.category.label)
      VStack(alignment: .leading, spacing: Space.xxs) {
        Text(title).textStyle(.callout, weight: entry.read ? nil : .semibold).lineLimit(1)
        Text(entry.body).textStyle(.footnote).foregroundStyle(Palette.secondary).lineLimit(2)
        if entry.category == .attention { remedies }
      }
      Spacer(minLength: Space.md)
      Text(detail).textStyle(.caption).foregroundStyle(Palette.tertiary).lineLimit(1).fixedSize()
      actionColumn
    }
    .padding(.horizontal, Space.xl)
    .padding(.vertical, Space.lg)
    .hoverHighlight(radius: 0)
    .onTapGesture(perform: open)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(
      "\(entry.read ? "" : "Unread, ")\(entry.category.label), \(title), \(entry.body), \(detail)"
    )
    .accessibilityAddTraits(.isButton)
    .accessibilityAction(named: entry.target.actionTitle, open)
  }

  private var command: StimCommand? { remedyCommand(entry.remedy, workspace: entry.target.path) }

  @ViewBuilder private var remedies: some View {
    let path = entry.target.path
    HStack(spacing: Space.sm) {
      if case .build = entry.target, let path {
        Button("Open logs") { openLogs(path) }
          .accessibilityLabel("Open logs, \(title)")
          .help("Show this workspace's errors")
      }
      if case .url = entry.target, let path {
        Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)]) }
          .accessibilityLabel("Show in Finder, \(title)")
          .help("The autopilot keeps this worktree. Review it, then run stim worktree remove yourself.")
      }
      if let command {
        Button("Copy command") {
          NSPasteboard.general.clearContents()
          NSPasteboard.general.setString(command.shellLine, forType: .string)
        }
        .accessibilityLabel("Copy command, \(command.displayLine())")
        .help(command.displayLine())
        if command.isRunnable && command.isFix {
          Button("Fix\u{2026}") { fix(title, command) }
            .accessibilityLabel("Fix, \(command.displayLine())")
            .help(command.displayLine())
        } else if command.isRunnable {
          runButton(command)
        }
      }
    }
    .buttonStyle(.stim())
    .padding(.top, Space.xs)
  }

  @ViewBuilder private func runButton(_ command: StimCommand) -> some View {
    if let active = actions.active(for: command.cwd) {
      Button {
        actions.presented = active
      } label: {
        HStack(spacing: Space.sm) {
          ProgressView().controlSize(.small)
          Text("Running")
        }
      }
    } else {
      Button("Run") { run(title, command) }
        .accessibilityLabel("Run, \(command.displayLine())")
        .help(command.displayLine())
    }
  }

  private var detail: String {
    let time = entry.date.formatted(date: .omitted, time: .shortened)
    return entry.suppressed.map { "\(time) \u{00B7} \($0.title)" } ?? time
  }

  /// Reserves a column as wide as the widest possible action label, with this row's button flush to its
  /// trailing edge, so buttons -- and the timestamps immediately before them -- line up across rows.
  private var actionColumn: some View {
    ZStack(alignment: .trailing) {
      ForEach(OversightTarget.actionTitles, id: \.self) { title in
        Text(title).textStyle(.footnote, weight: .semibold).padding(.horizontal, Space.md + Space.xxs)
          .frame(height: 24).hidden().accessibilityHidden(true)
      }
      Button(entry.target.actionTitle, action: open).buttonStyle(.stim())
    }
  }
}
