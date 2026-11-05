import StimKit
import SwiftUI

struct ArchivedRow: View {
  var archive: ArchivedWorkspace
  var now: Date
  var subtitle: String? = nil

  var showsGit = true
  var isHidden = false

  var body: some View {
    let page = ArchivedPage(archive: archive, now: now)
    WorkspaceRowContent(
      env: page.workspace, now: now,
      place: [archive.names.inCheckout.map { ($0 as NSString).lastPathComponent }, subtitle].compactMap { $0 },
      showsGit: showsGit, openLogs: { _ in }, archive: page, isHidden: isHidden)
  }
}

struct ArchiveRowFacts: View {
  var page: ArchivedPage
  var showsGit: Bool

  var body: some View {
    HStack(spacing: Space.sm) {
      if showsGit, let pr = page.pullRequestLabel {
        Text(pr).foregroundStyle(page.merged ? Palette.success : Palette.secondary)
      }
      if let expiry = page.expiryLabel {
        Label(expiry, systemImage: "clock").foregroundStyle(Palette.warning)
      }
    }.font(.stim(.caption)).lineLimit(1)
  }
}

struct ArchivedStorageSection: View {
  var usage: ArchivedUsage

  var body: some View {
    if !usage.storageRows.isEmpty {
      VStack(alignment: .leading, spacing: Space.md) {
        SectionLabel(title: "Archived workspaces")
        Text("\(countLabel(usage.count, "archive")) \u{00B7} \(Format.fileSize(usage.bytes))")
        Text("Bounded by archive.maxTotalGb").foregroundStyle(Palette.secondary)
        ForEach(usage.storageRows, id: \.title) { row in
          HStack {
            VStack(alignment: .leading, spacing: Space.xxs) {
              Text(row.title)
              Text(row.settings).font(.stim(.caption)).foregroundStyle(Palette.secondary)
            }
            Spacer()
            Text(Format.fileSize(row.bytes)).foregroundStyle(Palette.secondary)
          }
        }
      }
    }
  }
}
