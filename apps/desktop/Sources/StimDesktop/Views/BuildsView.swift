import StimKit
import SwiftUI

/// Every native build this Mac recorded, newest first, from `stim logs --source builds`.
struct BuildsView: View {
  @ObservedObject var history: BuildHistoryModel
  @State private var filter = BuildFilter()
  @State private var visibleCount = 50

  var body: some View {
    let days = BuildHistory.days(history.items, filter)
    let choices = BuildHistory.choices(history.items)
    ScrollView {
      VStack(alignment: .leading, spacing: Space.xxl) {
        header(choices)
        if let error = history.error, history.items.isEmpty {
          VStack(alignment: .leading, spacing: Space.sm) {
            Text(abbreviatingHome(error)).foregroundStyle(Palette.error)
            Text("The build history needs a stim newer than 1.25.0; with an older one, update stim.")
              .font(.stim(.footnote)).foregroundStyle(Palette.warning)
          }
        } else if days.isEmpty {
          EmptyState(
            title: filter == BuildFilter() ? "No Builds Yet" : "Nothing Matches",
            message: filter == BuildFilter()
              ? (history.loaded
                ? "Every ios, android and macos build Stim runs is recorded here, even after its workspace is removed."
                : "Loading\u{2026}")
              : "No recorded build matches these filters."
          )
          .frame(maxWidth: .infinity)
          .padding(.top, Space.huge)
        } else {
          BuildHistoryList(days: days, limit: visibleCount)
          if visibleCount < days.reduce(0, { $0 + $1.items.count }) {
            Button("Show Older Builds") { visibleCount += 50 }
              .buttonStyle(.stim())
              .frame(maxWidth: .infinity)
          }
        }
      }
      .padding(.horizontal, PageInset.horizontal).padding(.vertical, Space.xxxl)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .task { await history.poll() }
    .onChange(of: filter) { _, _ in visibleCount = 50 }
  }

  private func header(_ choices: BuildHistory.Choices) -> some View {
    ViewThatFits(in: .horizontal) {
      HStack(spacing: Space.md) {
        Text("Builds").font(.stim(.title)).fixedSize()
        Spacer()
        filters(choices)
      }
      VStack(alignment: .leading, spacing: Space.lg) {
        Text("Builds").font(.stim(.title)).fixedSize()
        HStack(spacing: Space.md) { filters(choices) }
      }
    }
  }

  @ViewBuilder private func filters(_ choices: BuildHistory.Choices) -> some View {
    MenuPill(
      label: "Project",
      selection: $filter.project,
      options: [MenuPillOption(value: String?.none, title: "All Projects")]
        + choices.projects.map { MenuPillOption(value: Optional($0.path), title: $0.title) },
      isActive: filter.project != nil
    )
    .help("Show one project")
    MenuPill(
      label: "Platform",
      selection: $filter.platform,
      options: [MenuPillOption(value: String?.none, title: "All Platforms")]
        + choices.platforms.map { MenuPillOption(value: Optional($0), title: platformTitle($0)) },
      isActive: filter.platform != nil
    )
    .help("Show one platform")
    MenuPill(
      label: "Machine",
      selection: $filter.machine,
      options: [
        MenuPillOption(value: String?.none, title: "All Machines"),
        MenuPillOption(value: Optional(BuildFilter.thisMac), title: "This Mac"),
      ] + choices.machines.map { MenuPillOption(value: Optional($0), title: $0) },
      isActive: filter.machine != nil
    )
    .help("Show builds that ran on one machine")
    MenuPill(
      label: "Outcome",
      selection: $filter.outcome,
      options: [MenuPillOption(value: BuildHistoryItem.Outcome?.none, title: "Any Outcome")]
        + BuildHistoryItem.Outcome.allCases.map { MenuPillOption(value: Optional($0), title: $0.title) },
      isActive: filter.outcome != nil
    )
    .help("Show builds that ended this way")
  }

  private func platformTitle(_ platform: String) -> String {
    switch platform {
    case "ios": return "iOS"
    case "android": return "Android"
    case "macos": return "macOS"
    default: return platform
    }
  }
}

/// Builds grouped by day, each a row that opens to its phases and failure.
struct BuildHistoryList: View {
  var days: [(day: Date, items: [BuildHistoryItem])]
  var limit: Int
  @State private var selected: String?
  @Environment(\.calendar) private var calendar
  @Environment(\.timeZone) private var timeZone
  @Environment(\.locale) private var locale

  var body: some View {
    let visible = Set(days.flatMap(\.items).prefix(limit).map(\.id))
    ForEach(
      days.map { (day: $0.day, items: $0.items.filter { visible.contains($0.id) }) }.filter { !$0.items.isEmpty }, id: \.day
    ) {
      day in
      VStack(alignment: .leading, spacing: Space.md) {
        Text(dayTitle(day.day)).font(.stim(.headline))
        Card {
          VStack(spacing: 0) {
            ForEach(Array(day.items.enumerated()), id: \.element.id) { index, item in
              if index > 0 { Rectangle().fill(Palette.border).frame(height: 1) }
              BuildRow(item: item, expanded: selected == item.id) {
                selected = selected == item.id ? nil : item.id
              }
            }
          }
        }
      }
    }
  }

  private func dayTitle(_ day: Date) -> String {
    if calendar.isDateInToday(day) { return "Today" }
    if calendar.isDateInYesterday(day) { return "Yesterday" }
    return day.formatted(
      Date.FormatStyle(locale: locale, calendar: calendar, timeZone: timeZone)
        .weekday(.wide).month(.abbreviated).day())
  }
}

private struct BuildRow: View {
  var item: BuildHistoryItem
  var expanded: Bool
  var toggle: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .center, spacing: Space.lg) {
        Image(systemName: symbol)
          .iconFont(IconSize.row, weight: .semibold)
          .foregroundStyle(tint)
          .frame(width: 20)
          .help(item.outcome.title)
        VStack(alignment: .leading, spacing: Space.xxs) {
          Text("\(item.projectName) \u{00B7} \(item.platformTitle)").textStyle(.callout, weight: .semibold).lineLimit(1)
          Text(subtitle).textStyle(.footnote).foregroundStyle(Palette.secondary).lineLimit(1)
        }
        Spacer(minLength: Space.md)
        VStack(alignment: .trailing, spacing: Space.xxs) {
          Text(item.durationText).textStyle(.callout).monospacedDigit()
          Text(item.date.formatted(date: .omitted, time: .shortened)).textStyle(.caption).foregroundStyle(Palette.tertiary)
        }
        .fixedSize()
        Image(systemName: "chevron.right").iconFont(IconSize.micro, weight: .semibold)
          .foregroundStyle(Palette.tertiary).rotationEffect(.degrees(expanded ? 90 : 0))
          .accessibilityHidden(true)
      }
      .padding(.horizontal, Space.xl)
      .padding(.vertical, Space.lg)
      .contentShape(Rectangle())
      .hoverHighlight(radius: 0)
      .onTapGesture(perform: toggle)
      .accessibilityElement(children: .combine)
      .accessibilityLabel(
        "\(item.outcome.title), \(item.projectName), \(item.platformTitle), \(item.whereText), \(item.cacheText), \(item.durationText)"
      )
      .accessibilityAddTraits(.isButton)
      .accessibilityValue(expanded ? "Expanded" : "Collapsed")
      if expanded { BuildDetail(item: item).padding(.horizontal, Space.xl).padding(.bottom, Space.xl) }
    }
  }

  private var subtitle: String {
    [item.branch, item.target, item.whereText, item.cacheText].compactMap { $0 }.joined(separator: " \u{00B7} ")
  }

  private var symbol: String {
    switch item.outcome {
    case .succeeded: return "checkmark.circle.fill"
    case .failed: return "xmark.octagon.fill"
    case .cancelled: return "minus.circle.fill"
    }
  }

  private var tint: Color {
    switch item.outcome {
    case .succeeded: return Palette.success
    case .failed: return Palette.error
    case .cancelled: return Palette.tertiary
    }
  }
}

/// What one build did: the failure first, then its phases as bars, then the facts that explain it.
struct BuildDetail: View {
  var item: BuildHistoryItem

  var body: some View {
    VStack(alignment: .leading, spacing: Space.xl) {
      if let failure = item.failure { failureBlock(failure) }
      timeline
      facts
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .textSelection(.enabled)
  }

  private func failureBlock(_ failure: BuildHistoryItem.Failure) -> some View {
    VStack(alignment: .leading, spacing: Space.sm) {
      if let code = failure.code { Text(code).font(.stim(.callout, mono: true)).foregroundStyle(Palette.error) }
      Text(failure.message ?? "No reason was recorded.").textStyle(.callout)
      if let remedy = failure.remedy {
        Text(remedy).textStyle(.footnote).foregroundStyle(Palette.secondary)
      } else if failure.code != nil {
        Text("No remedy was recorded. stim guide errors lists the remedy for each code.")
          .textStyle(.footnote).foregroundStyle(Palette.tertiary)
      }
    }
  }

  @ViewBuilder private var timeline: some View {
    let segments = item.timeline
    if segments.isEmpty {
      InlineEmpty("No phase timing was recorded.")
    } else {
      let scale = max(item.durationMs, segments.map(\.ms).max() ?? 0)
      VStack(alignment: .leading, spacing: Space.sm) {
        ForEach(segments) { segment in
          if segment.id == segments.first(where: { $0.lane == segment.lane })?.id {
            Text(laneTitle(segment.lane)).textStyle(.caption, weight: .semibold).foregroundStyle(Palette.tertiary)
              .padding(.top, segment.lane == .local ? 0 : Space.sm)
          }
          PhaseBar(segment: segment, scale: scale)
        }
      }
    }
  }

  private func laneTitle(_ lane: BuildPhaseSegment.Lane) -> String {
    switch lane {
    case .local: return "On this Mac"
    case .machine(let name): return "On \(name), during Compile"
    }
  }

  private var facts: some View {
    VStack(alignment: .leading, spacing: Space.xs) {
      fact("Started", item.startedDate.formatted(date: .abbreviated, time: .standard))
      fact("Project", abbreviatingHome(item.project))
      fact("Branch", item.branch)
      fact("Target", item.target)
      fact("Device", item.device.map { [$0.name, $0.runtime].compactMap { $0 }.joined(separator: ", ") })
      fact("Ran on", item.whereText)
      fact("Why it fell back", item.placement.fellBack == true ? item.placement.reason : nil)
      fact("Cache", item.cacheText + (item.cache.missReason.map { " (\($0))" } ?? ""))
      fact("Cache key", item.cache.key)
      fact("Fingerprint", item.cache.fingerprint)
      fact("Stim", item.stimVersion)
    }
  }

  @ViewBuilder private func fact(_ title: String, _ value: String?) -> some View {
    if let value, !value.isEmpty {
      HStack(alignment: .firstTextBaseline, spacing: Space.md) {
        Text(title).textStyle(.footnote).foregroundStyle(Palette.tertiary).frame(width: 96, alignment: .leading)
        Text(value).textStyle(.footnote).foregroundStyle(Palette.secondary).lineLimit(2).truncationMode(.middle)
      }
    }
  }
}

private struct PhaseBar: View {
  var segment: BuildPhaseSegment
  var scale: Double

  var body: some View {
    HStack(spacing: Space.md) {
      Text(segment.title).textStyle(.footnote).frame(width: 150, alignment: .leading).lineLimit(1)
      GeometryReader { proxy in
        ZStack(alignment: .leading) {
          Capsule().fill(Palette.raised)
          Capsule().fill(segment.failed ? Palette.error : Palette.primary)
            .frame(width: max(3, proxy.size.width * min(1, segment.ms / max(scale, 1))))
        }
      }
      .frame(height: 6)
      Text(Format.elapsed(ms: segment.ms)).textStyle(.footnote).monospacedDigit().foregroundStyle(Palette.secondary)
        .frame(width: 64, alignment: .trailing)
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(segment.title), \(Format.elapsed(ms: segment.ms))\(segment.failed ? ", where it failed" : "")")
  }
}
