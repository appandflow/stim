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

struct RowTitleLine: View {
  var title: String
  var titleColor: Color
  var status: String?
  var statusColor: Color
  var statusWeight: Font.Weight = .medium
  var isHidden = false

  private func statusText(_ status: String) -> some View {
    Text(status).font(.stim(.caption, weight: statusWeight)).foregroundStyle(statusColor).lineLimit(1).fixedSize()
  }

  private func name(fitting: Bool) -> some View {
    Text(title).foregroundStyle(titleColor).lineLimit(1).truncationMode(.middle).fixedSize(horizontal: fitting, vertical: false)
  }

  var body: some View {
    ViewThatFits(in: .horizontal) {
      HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
        name(fitting: true)
        Spacer(minLength: 0)
        if isHidden { HiddenIndicator() }
        if let status { statusText(status) }
      }
      VStack(alignment: .leading, spacing: Space.xs) {
        HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
          name(fitting: false)
          Spacer(minLength: 0)
          if isHidden { HiddenIndicator() }
        }
        if let status { statusText(status) }
      }
    }
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
