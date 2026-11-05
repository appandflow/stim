/// The state a status color stands for. The app target maps each case to one `Color`, so every surface that shows
/// the same state shows the same color.
public enum Tone: Sendable, CaseIterable {
  /// Body text.
  case normal
  case neutral
  case tertiary
  /// Stim's primary color: a running build, a merged pull request, a selected filter.
  case brand
  /// The brighter accent behind a started or informational message.
  case accent
  case info
  case success
  /// A usage stat past its warning threshold, in the amber the usage stats use in both appearances.
  case caution
  case warning
  case error
}
