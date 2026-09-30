import Foundation

/// Every byte, duration, age and device-name format Stim Desktop shows. Variants that differ on purpose keep their
/// own names, so a change to one wording is made here and nowhere else.
public enum Format {
  // MARK: Bytes

  /// "1.2 GB" for a file or disk size, decimal units. Zero reads "0 bytes".
  public static func fileSize(_ bytes: Int64) -> String {
    let formatter = ByteCountFormatter()
    formatter.countStyle = .file
    formatter.allowsNonnumericFormatting = false
    return formatter.string(fromByteCount: bytes)
  }

  /// "16 GB" for memory, binary units (a GB is 1024^3 bytes), as Activity Monitor counts it.
  public static func memory(_ bytes: Int64) -> String {
    ByteCountFormatter.string(fromByteCount: bytes, countStyle: .memory)
  }

  /// `value` with one decimal, a tie rounded up the way the phone app's `toFixed(1)` does.
  public static func tenths(_ value: Double) -> String {
    let scaled = value * 10
    let tie = scaled - scaled.rounded(.down) == 0.5 && (-scaled).addingProduct(value, 10) == 0
    return String(format: "%.1f", tie ? scaled.rounded(.up) / 10 : value)
  }

  /// "512 MB" or "1.5 GB" from a megabyte count.
  public static func memoryMb(_ mb: Double) -> String {
    mb >= 1024 ? "\(tenths(mb / 1024)) GB" : "\(Int(mb.rounded())) MB"
  }

  /// "1.5 GB" from a megabyte count, always in gigabytes with one decimal.
  public static func gigabytes(mb: Int) -> String {
    let tenths = Int((Double(mb) / 1024 * 10).rounded())
    return "\(tenths / 10).\(tenths % 10) GB"
  }

  /// "7.5/16 GB": memory in use over the Mac's total, in whole gigabytes for the total.
  public static func memoryPair(usedBytes: Int64, totalBytes: Int64) -> String {
    let used = gigabytes(mb: Int(usedBytes >> 20)).replacingOccurrences(of: " GB", with: "")
    let totalGb = Int((Double(totalBytes >> 20) / 1024).rounded())
    return "\(used)/\(totalGb) GB"
  }

  /// "412 GB" or "1.2 TB" for free disk space, decimal units, with a tie rounded up the way the phone app's
  /// `toFixed(1)` does, so both apps word the same volume the same way.
  public static func freeSpace(_ bytes: Double) -> String {
    if bytes >= 1e12 { return "\(tenths(bytes / 1e12)) TB" }
    let gb = bytes / 1e9
    return gb >= 100 ? "\(Int(gb.rounded())) GB" : "\(tenths(gb)) GB"
  }

  // MARK: Durations and ages

  /// "12m", "1h05m", "3d" for a duration, "<1m" under a minute. Truncates; negative reads as zero.
  public static func duration(_ seconds: TimeInterval) -> String {
    let minutes = Int(max(0, seconds) / 60)
    if minutes < 1 { return "<1m" }
    if minutes < 60 { return "\(minutes)m" }
    let hours = minutes / 60
    if hours < 24 { return minutes % 60 == 0 ? "\(hours)h" : "\(hours)h\(String(format: "%02d", minutes % 60))m" }
    return "\(hours / 24)d"
  }

  /// "12s" under a minute, else `duration`.
  public static func since(_ seconds: TimeInterval) -> String {
    let clamped = max(0, seconds)
    return clamped < 60 ? "\(Int(clamped))s" : duration(clamped)
  }

  /// "40s", "14m", "2h", "3d": a gap or an age in its largest unit, rounded, with hours up to 47.
  public static func roundedDuration(ms: Double) -> String {
    let seconds = max(0, Int((ms / 1000).rounded()))
    if seconds < 60 { return "\(seconds)s" }
    let minutes = Int((Double(seconds) / 60).rounded())
    if minutes < 60 { return "\(minutes)m" }
    let hours = Int((Double(minutes) / 60).rounded())
    return hours < 48 ? "\(hours)h" : "\(Int((Double(hours) / 24).rounded()))d"
  }

  /// "2:38" for a build time.
  public static func clock(ms: Double) -> String {
    let seconds = max(0, Int(ms / 1000))
    return "\(seconds / 60):\(String(format: "%02d", seconds % 60))"
  }

  /// "3m 5s", or "1h 2m" from an hour up, for how long a run took.
  public static func elapsed(ms: Double) -> String {
    let s = Int(ms / 1000)
    if s >= 3600 { return "\(s / 3600)h \((s % 3600) / 60)m" }
    return "\(s / 60)m \(s % 60)s"
  }

  /// "just now", "5m ago", "3h ago" for how long ago something happened.
  public static func age(_ seconds: TimeInterval) -> String {
    let minutes = Int(seconds / 60)
    if minutes < 1 { return "just now" }
    if minutes < 60 { return "\(minutes)m ago" }
    return "\(minutes / 60)h ago"
  }

  // MARK: Devices

  private static let modelPattern = try! NSRegularExpression(pattern: #"\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*$"#)

  /// "iPhone 17 Pro" from a Stim simulator name such as "stim-app (iPhone 17 Pro iOS 26.0)", the last parenthesized
  /// group; "iOS Simulator" when there is none.
  public static func simulatorModel(_ name: String?) -> String {
    let name = name ?? ""
    let range = NSRange(name.startIndex..., in: name)
    guard let match = modelPattern.firstMatch(in: name, range: range),
      let group = Range(match.range(at: 1), in: name)
    else { return "iOS Simulator" }
    return String(name[group])
  }
}
