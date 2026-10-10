import StimKit
import SwiftUI

struct TutorialCompletionCard: View {
  var snapshot: TutorialSnapshot
  var steps: [TutorialStep]
  var archiveOff: Bool
  var openArchived: () -> Void

  private var record: TutorialRecord { snapshot.record }
  private var stats: TutorialStats { record.stats ?? TutorialStats() }

  var body: some View {
    VStack(alignment: .leading, spacing: Space.lg) {
      VStack(alignment: .leading, spacing: Space.xxs) {
        Label("Tutorial Complete", systemImage: "checkmark.circle.fill")
          .font(.stim(.headline)).foregroundStyle(Palette.success)
        if let total {
          Text("\(Format.duration(total)) from clone to archive")
            .font(.stim(.footnote)).foregroundStyle(Palette.secondary)
        }
      }
      if !tiles.isEmpty {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: Space.md), GridItem(.flexible())], spacing: Space.md) {
          ForEach(tiles, id: \.caption) { tile in
            VStack(alignment: .leading, spacing: Space.xxs) {
              Text(tile.value).font(.stim(.headline)).monospacedDigit()
              Text(tile.caption).font(.stim(.caption)).foregroundStyle(Palette.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Space.md)
            .background(RoundedRectangle(cornerRadius: Radius.card).fill(Palette.surface))
            .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Palette.border))
            .accessibilityElement(children: .combine)
          }
        }
      }
      if !achievements.isEmpty {
        FlowLayout(spacing: Space.sm) {
          ForEach(achievements, id: \.title) { achievement in
            Text(achievement.title)
              .font(.stim(.caption))
              .foregroundStyle(achievement.earned ? Palette.primary : Palette.tertiary)
              .padding(.horizontal, Space.md)
              .padding(.vertical, Space.xxs)
              .overlay(
                Capsule().strokeBorder(
                  achievement.earned ? Palette.primary : Palette.tertiary,
                  style: StrokeStyle(lineWidth: 1, dash: achievement.earned ? [] : [3, 3]))
              )
              .accessibilityLabel("\(achievement.title), \(achievement.earned ? "earned" : "skipped")")
          }
        }
      }
      Text(
        archiveOff
          ? "Archived is off. The tutorial workspace has been removed."
          : "Your workspace, builds, logs and recordings stay in Archived when archiving is enabled."
      )
      .foregroundStyle(Palette.secondary)
      .fixedSize(horizontal: false, vertical: true)
      Button("Open Archived", action: openArchived)
        .buttonStyle(.stim(.primary)).accessibilityLabel("Open Archived workspaces")
    }
  }

  private static func time(_ ms: Double) -> String {
    ms < 60_000 ? "\(Int(ms / 1000))s" : Format.elapsed(ms: ms)
  }

  private var total: TimeInterval? {
    let end = record.stepTimes?["delete"] ?? record.stepTimes?["done"]
    return end.map { $0.timeIntervalSince(record.startedAt) }.flatMap { $0 > 0 ? $0 : nil }
  }

  private struct Tile {
    var value: String
    var caption: String
  }

  private var tiles: [Tile] {
    var tiles: [Tile] = []
    if let ms = stats.firstBuild?.durationMs {
      tiles.append(Tile(value: Self.time(ms), caption: "first build"))
    }
    if let second = stats.secondBuild, let ms = second.durationMs {
      let saved = stats.savedMs.map { ", saved \(Self.time($0))" } ?? ""
      tiles.append(
        Tile(value: Self.time(ms), caption: (second.cache == "none" ? "second build" : "cache hit") + saved))
    }
    if record.secondPath != nil {
      tiles.append(
        Tile(value: "2", caption: stats.buildsOverlapped == true ? "worktrees building at once" : "worktrees side by side"))
    }
    if let actions = stats.agentActions, actions > 0 {
      tiles.append(Tile(value: "\(actions)", caption: actions == 1 ? "agent action to replay" : "agent actions to replay"))
    }
    if record.done.contains("delete"), let bytes = stats.measuredBytes, bytes > 0 {
      tiles.append(Tile(value: Format.fileSize(Int64(bytes)), caption: "freed"))
    }
    return tiles
  }

  private struct Achievement {
    var title: String
    var earned: Bool
  }

  private static let titles = [
    "device": "Hands on", "agent": "Replay", "logs": "Logs", "phone": "Pocket Stim", "share": "Shared",
    "delete": "Clean slate",
  ]

  private var achievements: [Achievement] {
    steps.filter { $0.optional && (record.done.contains($0.id) || record.skipped.contains($0.id)) }.compactMap { step in
      Self.titles[step.id].map { Achievement(title: $0, earned: record.done.contains(step.id)) }
    }
  }
}
