import StimKit
import SwiftUI

struct TerminalCard: View {
  enum Mode: Equatable {
    case scripted(loop: Bool)
    case live
  }

  var lines: [TerminalLine]
  var mode: Mode
  var width: CGFloat = 236
  var animates = true
  var height: CGFloat?
  var maxVisibleLines: Int?
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var typed = 0
  @State private var cursorOn = true
  @State private var previousLines: [TerminalLine] = []
  @State private var liveLines: [TerminalLine] = []

  private struct AnimationInput: Equatable {
    var lines: [TerminalLine]
    var mode: Mode
    var reduceMotion: Bool
    var animates: Bool
  }

  private var cardHeight: CGFloat { height ?? (mode == .live ? 199 : 112) }
  private var lineLimit: Int {
    min(maxVisibleLines ?? (mode == .live ? 10 : 5), max(1, Int((cardHeight - Space.lg * 2 - 7 - Space.md) / 16)))
  }
  private var total: Int { lines.reduce(0) { $0 + $1.text.count } }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 5) {
        ForEach([Color(rgba: 0xFF5F57FF), Color(rgba: 0xFEBC2EFF), Color(rgba: 0x28C840FF)], id: \.self) {
          Circle().fill($0).frame(width: 7, height: 7)
        }
      }
      .padding(.bottom, Space.md)
      let visible = TerminalLine.visibleWindow(displayedLines, maxVisibleLines: lineLimit)
      ForEach(Array(visible.indices), id: \.self) { index in
        let line = visible[index]
        HStack(spacing: 0) {
          if let symbol = line.kind.symbolName {
            Image(systemName: symbol)
              .foregroundStyle(symbolColor(line.kind))
              .padding(.trailing, Space.xs)
          }
          Text(line.text)
            .foregroundStyle(line.kind == .output ? Media.textTertiary : Media.text)
          if index == visible.indices.last {
            Rectangle().fill(Palette.accent).frame(width: 6, height: 11).opacity(cursorOn ? 1 : 0)
          }
        }
        .font(.stim(.caption, mono: true))
        .lineLimit(1)
        .frame(height: 16)
      }
      Spacer(minLength: 0)
    }
    .padding(Space.lg)
    .frame(width: width, height: cardHeight, alignment: .topLeading)
    .background(RoundedRectangle(cornerRadius: Radius.card).fill(Media.screen))
    .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Palette.accent.opacity(0.4)))
    .shadow(color: Palette.brand.opacity(0.3), radius: 16, y: 8)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(TerminalLine.spokenSummary(lines))
    .task(id: AnimationInput(lines: mode == .live ? lines : [], mode: mode, reduceMotion: reduceMotion, animates: animates)) {
      switch mode {
      case .scripted(let loop): await playScript(loop: loop)
      case .live: await typeLiveLines()
      }
    }
  }

  private var displayedLines: [TerminalLine] {
    if reduceMotion || !animates { return lines }
    if mode == .live { return liveLines }
    var left = typed
    var out: [TerminalLine] = []
    for line in lines {
      guard left > 0 || out.isEmpty else { break }
      out.append(TerminalLine(text: String(line.text.prefix(left)), kind: line.kind))
      left -= min(left, line.text.count)
    }
    return out
  }

  private func symbolColor(_ kind: TerminalLine.Kind) -> Color {
    switch kind {
    case .ok: Palette.success
    case .failed: Palette.error
    default: Media.textTertiary
    }
  }

  private func playScript(loop: Bool) async {
    guard !reduceMotion, animates else {
      typed = total
      cursorOn = true
      return
    }
    repeat {
      for count in 0...total {
        guard !Task.isCancelled else { return }
        typed = count
        cursorOn = true
        try? await Task.sleep(for: .milliseconds((lines.first?.text.count ?? 0) > count ? 55 : 30))
      }
      for _ in 0..<6 {
        guard !Task.isCancelled else { return }
        try? await Task.sleep(for: .milliseconds(450))
        guard !Task.isCancelled else { return }
        cursorOn.toggle()
      }
    } while loop && !Task.isCancelled
  }

  private func typeLiveLines() async {
    let changed = TerminalLine.indexesToType(previous: previousLines, lines: lines)
    liveLines = lines
    cursorOn = true
    guard !reduceMotion, animates else {
      previousLines = lines
      return
    }
    let visible = TerminalLine.visibleWindow(lines, maxVisibleLines: lineLimit)
    let indexes = changed.filter { visible.indices.contains($0) }
    for index in indexes { liveLines[index].text = "" }
    for index in indexes {
      for character in lines[index].text {
        guard !Task.isCancelled else { return }
        liveLines[index].text.append(character)
        try? await Task.sleep(for: .milliseconds(index == 0 ? 55 : 30))
      }
      previousLines = Array(lines.prefix(index + 1)) + previousLines.dropFirst(index + 1)
    }
    previousLines = lines
    while !Task.isCancelled {
      try? await Task.sleep(for: .milliseconds(500))
      guard !Task.isCancelled else { return }
      cursorOn.toggle()
    }
  }
}
