import AppKit
import SwiftUI

/// How long a copy button shows "Copied" before it returns to "Copy". A repeat copy restarts the wait, and only one wait
/// is ever pending.
@MainActor final class CopyFeedback: ObservableObject {
  nonisolated static let delay: Duration = .seconds(2)

  @Published private(set) var copied = false
  private let delay: Duration
  private let sleep: @Sendable (Duration) async throws -> Void
  private var revert: Task<Void, Never>?

  init(
    delay: Duration = CopyFeedback.delay,
    sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
  ) {
    self.delay = delay
    self.sleep = sleep
  }

  deinit { revert?.cancel() }

  func didCopy() {
    revert?.cancel()
    copied = true
    revert = Task { [weak self, delay, sleep] in
      do { try await sleep(delay) } catch { return }
      guard !Task.isCancelled else { return }
      self?.copied = false
    }
  }
}

/// Stim's Copy button. A click writes to the Mac pasteboard and the button morphs to "Copied": the symbol is replaced,
/// the label crossfades, the capsule springs to its new width and takes the success tint. It returns to "Copy" after
/// two seconds. With Reduce Motion on it swaps at once.
struct CopyButton: View {
  var variant: ButtonVariant = .secondary
  var size: ButtonSize = .small
  var title = "Copy"
  var copiedTitle = "Copied"
  var showsTitle = true
  var help: String?
  var accessibilityLabel: String?
  var onCopy: (() -> Void)?
  var copy: () async -> Bool

  @StateObject private var feedback = CopyFeedback()
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  init(
    _ text: @autoclosure @escaping () -> String?,
    variant: ButtonVariant = .secondary,
    size: ButtonSize = .small,
    title: String = "Copy",
    copiedTitle: String = "Copied",
    showsTitle: Bool = true,
    help: String? = nil,
    accessibilityLabel: String? = nil,
    onCopy: (() -> Void)? = nil
  ) {
    self.copy = {
      guard let value = text() else { return false }
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(value, forType: .string)
      return true
    }
    self.variant = variant
    self.size = size
    self.title = title
    self.copiedTitle = copiedTitle
    self.showsTitle = showsTitle
    self.help = help
    self.accessibilityLabel = accessibilityLabel
    self.onCopy = onCopy
  }

  /// A button whose copy is an async operation. It shows "Copied" only when `copy` returns true.
  init(
    variant: ButtonVariant = .secondary,
    size: ButtonSize = .small,
    title: String = "Copy",
    help: String? = nil,
    copy: @escaping () async -> Bool
  ) {
    self.copy = copy
    self.variant = variant
    self.size = size
    self.title = title
    self.help = help
  }

  var body: some View {
    let copied = feedback.copied
    Button {
      Task {
        guard await copy() else { return }
        feedback.didCopy()
        AccessibilityNotification.Announcement(copiedTitle).post()
        onCopy?()
      }
    } label: {
      HStack(spacing: Space.xs) {
        Image(systemName: copied ? "checkmark" : "doc.on.doc")
          .contentTransition(reduceMotion ? .identity : .symbolEffect(.replace))
        if showsTitle {
          Text(copied ? copiedTitle : title)
            .contentTransition(reduceMotion ? .identity : .interpolate)
            .lineLimit(1)
            .fixedSize()
        }
      }
    }
    .buttonStyle(.stim(variant, size))
    .environment(\.stimButtonAccent, copied ? Palette.success : nil)
    .animation(reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.8), value: copied)
    .help(help ?? title)
    .accessibilityLabel(copied ? "\(copiedTitle), \(accessibilityLabel ?? title)" : (accessibilityLabel ?? title))
  }
}
