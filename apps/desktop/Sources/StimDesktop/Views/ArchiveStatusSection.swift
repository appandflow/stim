import StimKit
import SwiftUI

struct ArchiveStatusSection: View {
  var page: ArchivedPage

  var body: some View {
    VStack(alignment: .leading, spacing: Space.md) {
      SectionLabel(title: "Status")
      Text(page.statusLine)
      if let date = page.removedAt {
        Text(date, format: .dateTime.month(.abbreviated).day().hour().minute())
          .font(.stim(.footnote)).foregroundStyle(Palette.tertiary)
      }
      if let label = page.lastUsedLabel { Text(label).foregroundStyle(Palette.secondary) }
      if page.replacedBy != nil { Text("Replaced by a newer workspace").foregroundStyle(Palette.secondary) }
      Text("Retained \(page.sizeLabel)").font(.stim(.callout, weight: .semibold))
      Card(radius: Radius.control, border: nil, clipsContent: false) {
        VStack(alignment: .leading, spacing: Space.md) {
          ForEach(page.retention) { part in
            VStack(alignment: .leading, spacing: Space.xs) {
              HStack {
                Text(part.title)
                Spacer(minLength: Space.sm)
                Text(Format.fileSize(part.bytes)).monospacedDigit().foregroundStyle(Palette.secondary)
              }
              if part.expired {
                Text("Expired").foregroundStyle(Palette.tertiary)
              } else if let until = part.until {
                Text("Until \(until, format: .dateTime.month(.abbreviated).day().hour().minute())")
                  .foregroundStyle(part.expiresSoon ? Palette.warning : Palette.secondary)
              } else {
                Text(part.bytes == 0 ? "None" : "No expiry reported").foregroundStyle(Palette.tertiary)
              }
            }
          }
        }.font(.stim(.footnote)).padding(Space.lg)
      }
      Text(countLabel(page.record.builds.count, "build"))
      if let hits = page.cacheHits, let offloaded = page.offloadedBuilds {
        Text("\(countLabel(hits, "cache hit")) \u{00B7} \(countLabel(offloaded, "build")) on a build machine")
          .foregroundStyle(Palette.secondary)
      }
      Text("\(countLabel(page.record.builds.lastErrorCount, "error")) at removal")
        .foregroundStyle(Palette.secondary)
    }
  }
}
