import StimKit
import SwiftUI

struct CleanupHistorySection: View {
  @ObservedObject var history: GcHistoryModel

  var body: some View {
    Section {
      if let error = history.error, history.runs.isEmpty {
        Text(abbreviatingHome(error)).foregroundStyle(Palette.error)
      } else if history.runs.isEmpty {
        InlineEmpty(history.loaded ? "Nothing has been cleared yet." : "Loading\u{2026}")
      } else {
        ForEach(history.runs.prefix(50)) { run in CleanupRunRow(run: run) }
      }
    } header: {
      Text("Cleanup History")
    } footer: {
      Text(
        "Every run that deleted or changed something: stim gc, automatic maintenance and the disk and memory budget before a build. It comes from the machine gc log, which stim logs --source gc prints."
      )
      .multilineTextAlignment(.leading)
      .frame(maxWidth: .infinity, alignment: .leading)
      .foregroundStyle(Palette.tertiary)
    }
  }
}

private struct CleanupRunRow: View {
  var run: GcRun
  @State private var expanded = false

  var body: some View {
    DisclosureGroup(isExpanded: $expanded) {
      VStack(alignment: .leading, spacing: Space.sm) {
        ForEach(Array(run.items.enumerated()), id: \.offset) { _, item in CleanupItemRow(item: item) }
      }
      .padding(.top, Space.xs)
    } label: {
      HStack(alignment: .firstTextBaseline, spacing: Space.md) {
        Image(systemName: run.failed.isEmpty ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
          .foregroundStyle(run.failed.isEmpty ? Palette.success : Palette.error)
          .frame(width: 18)
        VStack(alignment: .leading, spacing: Space.xxs) {
          HStack {
            Text(run.title)
            Spacer()
            Text(run.date.formatted(date: .abbreviated, time: .shortened)).foregroundStyle(Palette.tertiary)
          }
          Text(run.summary).font(.stim(.footnote)).foregroundStyle(Palette.secondary)
          if let reason = run.reason {
            Text(reason).font(.stim(.caption, mono: true)).foregroundStyle(Palette.tertiary)
          }
        }
      }
    }
    .textSelection(.enabled)
  }
}

private struct CleanupItemRow: View {
  var item: GcHistoryItem

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
      Image(systemName: symbol).foregroundStyle(tint).frame(width: 16)
      VStack(alignment: .leading, spacing: Space.xxs) {
        HStack {
          Text(abbreviatingHome(item.path ?? item.label)).lineLimit(1).truncationMode(.middle)
          Spacer()
          if let bytes = item.bytes, bytes > 0 {
            Text(Format.fileSize(Int64(bytes))).foregroundStyle(Palette.tertiary)
          }
        }
        Text(item.kindTitle + (item.detail.map { " \u{00B7} \(abbreviatingHome($0))" } ?? ""))
          .font(.stim(.footnote)).foregroundStyle(Palette.secondary).lineLimit(2)
      }
    }
    .font(.stim(.footnote))
  }

  private var symbol: String {
    switch item.status {
    case .done: return "checkmark.circle"
    case .kept: return "minus.circle"
    case .failed: return "xmark.octagon"
    }
  }

  private var tint: Color {
    switch item.status {
    case .done: return Palette.success
    case .kept: return Palette.tertiary
    case .failed: return Palette.error
    }
  }
}
