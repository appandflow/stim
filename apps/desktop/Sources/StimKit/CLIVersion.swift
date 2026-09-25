import Foundation

/// A `major.minor.patch[-prerelease]` version, ordered by the semver precedence rules.
public struct SemanticVersion: Comparable, Sendable, CustomStringConvertible {
  public var major: Int
  public var minor: Int
  public var patch: Int
  public var prerelease: [String]

  /// Parses the last whitespace-separated word of the first non-empty line, so `1.11.0`,
  /// `v1.11.0` and `stim 1.11.0` all read. Build metadata after `+` is ignored.
  public init?(_ text: String) {
    guard
      let line = text.split(whereSeparator: \.isNewline).first(where: { !$0.allSatisfy(\.isWhitespace) }),
      var word = line.split(whereSeparator: \.isWhitespace).last.map(String.init)
    else { return nil }
    if word.hasPrefix("v") { word.removeFirst() }
    word = String(word.prefix { $0 != "+" })
    let parts = word.split(separator: "-", maxSplits: 1)
    let numbers = parts[0].split(separator: ".", omittingEmptySubsequences: false).map { Int($0) }
    guard numbers.count == 3, let major = numbers[0], let minor = numbers[1], let patch = numbers[2] else {
      return nil
    }
    self.major = major
    self.minor = minor
    self.patch = patch
    self.prerelease = parts.count > 1 ? parts[1].split(separator: ".").map(String.init) : []
  }

  public var description: String {
    "\(major).\(minor).\(patch)" + (prerelease.isEmpty ? "" : "-" + prerelease.joined(separator: "."))
  }

  public static func < (lhs: SemanticVersion, rhs: SemanticVersion) -> Bool {
    if (lhs.major, lhs.minor, lhs.patch) != (rhs.major, rhs.minor, rhs.patch) {
      return (lhs.major, lhs.minor, lhs.patch) < (rhs.major, rhs.minor, rhs.patch)
    }
    if lhs.prerelease.isEmpty || rhs.prerelease.isEmpty { return !lhs.prerelease.isEmpty && rhs.prerelease.isEmpty }
    for (left, right) in zip(lhs.prerelease, rhs.prerelease) where left != right {
      switch (Int(left), Int(right)) {
      case (let l?, let r?): return l < r
      case (.some, nil): return true
      case (nil, .some): return false
      case (nil, nil): return left < right
      }
    }
    return lhs.prerelease.count < rhs.prerelease.count
  }
}

/// Whether an installed `stim` or `stim-server` is one Stim Desktop can run.
public enum CLICompatibility: Equatable, Sendable {
  case missing
  /// Older than the minimum, or a version the app could not read, with the text it printed.
  case outdated(found: String?)
  case compatible(SemanticVersion)

  /// `versionOutput` is what `--version` printed, or nil when it failed to run or exited non-zero.
  public static func check(executable: String?, versionOutput: String?, minimum: SemanticVersion) -> Self {
    guard executable != nil else { return .missing }
    guard let output = versionOutput, let version = SemanticVersion(output) else {
      return .outdated(found: versionOutput?.trimmingCharacters(in: .whitespacesAndNewlines))
    }
    return version < minimum ? .outdated(found: version.description) : .compatible(version)
  }

  public var isCompatible: Bool {
    if case .compatible = self { return true }
    return false
  }
}

/// The Stim viewer settings that make owned simulators and emulators open in Stim Desktop.
public enum DesktopViewerSettings {
  public static let value = "stim-desktop"
  public static let keys = ["iosSimulatorApp", "androidEmulatorApp"]

  /// The viewer keys `settings` lists with a value other than Stim Desktop, in `keys` order. A key the
  /// installed `stim` does not list is one it cannot set.
  public static func unset(in settings: [SettingEntry]) -> [String] {
    keys.filter { key in settings.first { $0.key == key }.map { $0.value.string != value } ?? false }
  }
}
