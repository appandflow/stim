import StimKit
import SwiftUI

struct SessionLine: View {
  var session: AgentSession
  var others: Int

  var body: some View {
    HStack(spacing: Space.xs) {
      AgentIcon(tool: session.tool, size: 11)
      Text(session.title.flatMap { $0.isEmpty ? nil : $0 } ?? session.toolName).lineLimit(1).truncationMode(.tail)
      if others > 0 { Text("+\(others)").foregroundStyle(Palette.tertiary).fixedSize() }
    }
    .font(.stim(.caption))
    .foregroundStyle(Palette.secondary)
  }
}

struct RowDetailLine: View {
  var context: Text?
  var git: GitChip?

  static func joined(_ parts: [Text]) -> Text? {
    guard let first = parts.first else { return nil }
    return parts.dropFirst().reduce(first) { $0 + Text(" \u{00B7} ").foregroundStyle(Palette.tertiary) + $1 }
  }

  private var gitText: Text? {
    guard let git else { return nil }
    var parts: [Text] = []
    if let pull = git.pullRequest { parts.append(Text(pull.text).fontWeight(.medium).foregroundStyle(Color(pull.tone))) }
    for part in git.parts {
      parts.append(Text(part.text).foregroundStyle(part.tone == .normal ? Palette.secondary : Color(part.tone)))
    }
    return Self.joined(parts)
  }

  var body: some View {
    let lines = [context, gitText].compactMap { $0 }
    Group {
      if lines.count == 2, let joined = Self.joined(lines) {
        ViewThatFits(in: .horizontal) {
          joined.lineLimit(1).fixedSize()
          VStack(alignment: .leading, spacing: Space.xs) {
            ForEach(lines.indices, id: \.self) { lines[$0].lineLimit(1).truncationMode(.tail) }
          }
        }
      } else if let line = lines.first {
        line.lineLimit(1).truncationMode(.tail)
      }
    }
    .font(.stim(.caption))
    .monospacedDigit()
  }
}
