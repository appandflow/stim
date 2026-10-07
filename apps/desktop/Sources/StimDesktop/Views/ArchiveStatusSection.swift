import StimKit
import StimStores
import SwiftUI

/// What an archive still holds: the size of each kind with its expiry, and the actions that drop one kind or the whole
/// archive through `stim gc --cache archived-<kind>:<id>` and `archived:<id>`.
struct ArchiveStatusSection: View {
  var page: ArchivedPage
  @EnvironmentObject private var actions: ActionCenter
  @State private var confirming: ArchivedPage.Retention?
  @State private var clearing: Set<String> = []
  @State private var cleared: Set<String> = []

  private var busy: Bool { actions.active(for: ActionCenter.machineKey) != nil }

  var body: some View {
    VStack(alignment: .leading, spacing: Space.md) {
      HStack(alignment: .firstTextBaseline) {
        SectionLabel(title: "Retained")
        Spacer(minLength: Space.sm)
        Text(page.sizeLabel).font(.stim(.callout, weight: .semibold)).monospacedDigit()
      }
      Card(radius: Radius.control, border: nil, clipsContent: false) {
        VStack(alignment: .leading, spacing: Space.lg) {
          usageBar
          ForEach(page.retention) { part in
            if part.id != page.retention.first?.id { Divider().overlay(Palette.border) }
            row(part)
          }
        }.font(.stim(.footnote)).padding(Space.lg)
      }
    }
    .confirmationDialog(
      confirming.map { $0.kind == nil ? "Delete this archive?" : "Delete this workspace's archived \($0.kind!.noun)?" } ?? "",
      isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
      titleVisibility: .visible, presenting: confirming
    ) { part in
      if let kind = part.kind {
        Button("Delete \(kind.noun)", role: .destructive) { clear(kind, part) }
      } else {
        Button("Delete archive", role: .destructive) {
          actions.run(
            "Delete \(page.record.title)", steps: [page.record.deleteCommand(cwd: NSHomeDirectory())],
            key: ActionCenter.machineKey)
        }
      }
    } message: { part in
      Text(
        part.kind == nil
          ? "This permanently deletes this archive's logs, recordings, agent actions and record."
          : "Its record stays.")
    }
  }

  private func tint(_ part: ArchivedPage.Retention) -> Color {
    switch part.kind {
    case .logs: return Palette.info
    case .recordings: return Palette.accent
    case .agentActions: return Palette.success
    case nil: return Palette.tertiary
    }
  }

  private var usageBar: some View {
    GeometryReader { geo in
      let total = page.retention.reduce(Int64(0)) { $0 + $1.bytes }
      HStack(spacing: 1) {
        if total > 0 {
          ForEach(page.retention.filter { $0.bytes > 0 }) { part in
            Rectangle().fill(tint(part))
              .frame(width: max(3, geo.size.width * CGFloat(part.bytes) / CGFloat(total)))
          }
        }
      }
      .frame(width: geo.size.width, height: 6, alignment: .leading)
      .background(Palette.border)
      .clipShape(Capsule())
    }
    .frame(height: 6)
    .accessibilityHidden(true)
  }

  private func row(_ part: ArchivedPage.Retention) -> some View {
    VStack(alignment: .leading, spacing: Space.xs) {
      HStack(spacing: Space.sm) {
        StatusDot(color: tint(part), size: 8)
        Text(part.title).font(.stim(.callout))
        Spacer(minLength: Space.sm)
        Text(Format.fileSize(part.bytes)).monospacedDigit().foregroundStyle(Palette.secondary)
      }
      HStack(spacing: Space.sm) {
        expiry(part).padding(.leading, Space.sm + 8)
        Spacer(minLength: Space.sm)
        if part.kind == nil {
          Button("Delete archive") { confirming = part }
            .buttonStyle(.stim(.destructive)).fixedSize().disabled(busy)
            .help("Delete \(page.record.title) permanently")
        } else if part.clearable {
          Button(clearing.contains(part.id) ? "Clearing" : "Clear") { confirming = part }
            .buttonStyle(.stim()).fixedSize().disabled(busy || clearing.contains(part.id))
            .help("Delete this workspace's archived \(part.kind!.noun); its record stays")
        }
      }
    }
  }

  @ViewBuilder private func expiry(_ part: ArchivedPage.Retention) -> some View {
    if part.kind != nil && part.bytes == 0 {
      Text(cleared.contains(part.id) ? "Cleared" : part.expired ? "Expired" : "None kept").foregroundStyle(Palette.tertiary)
    } else if part.expired {
      Text("Expired").foregroundStyle(Palette.tertiary)
    } else if let until = part.until {
      Text("Until \(until, format: .dateTime.month(.abbreviated).day())")
        .foregroundStyle(part.expiresSoon ? Palette.warning : Palette.secondary)
    } else {
      Text("No expiry reported").foregroundStyle(Palette.tertiary)
    }
  }

  private func clear(_ kind: RetainedKind, _ part: ArchivedPage.Retention) {
    clearing.insert(part.id)
    let started = actions.run(
      "Delete \(page.record.title) \(kind.noun)",
      steps: [page.record.clearCommand(kind, cwd: NSHomeDirectory())], key: ActionCenter.machineKey, present: false
    ) { run in
      clearing.remove(part.id)
      if run.exitStatus == 0 { cleared.insert(part.id) }
    }
    if started == nil { clearing.remove(part.id) }
  }
}
