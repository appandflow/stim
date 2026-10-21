import Foundation

/// The newest `stim` on the npm registry, and whether the installed one should be offered it.
public enum StimRelease {
  public static let registryURL = URL(string: "https://registry.npmjs.org/stim/latest")!
  public static let checkInterval: TimeInterval = 24 * 60 * 60
  public static let settingsInterval: TimeInterval = 60 * 60
  public static let staleRetryInterval: TimeInterval = 5 * 60

  private struct Manifest: Decodable { var version: String }

  /// The version in the registry's `latest` manifest, nil when the body is not one.
  public static func latest(in data: Data) -> SemanticVersion? {
    (try? JSONDecoder().decode(Manifest.self, from: data)).flatMap { SemanticVersion($0.version) }
  }

  /// The version to offer: `latest` when the installed `stim` is older and a package manager owns it. A
  /// `stim` no manager owns, such as a linked development checkout, is never offered an update.
  public static func offer(
    installed: CLICompatibility?, latest: SemanticVersion?, owner: PackageManager?
  ) -> SemanticVersion? {
    guard owner != nil, case .compatible(let version)? = installed, let latest, version < latest else { return nil }
    return latest
  }

  /// The latest to show beside `installed`: nil when it is older, which only a stale cache or a prerelease install
  /// produces, so the row never lists a "latest" below what is installed.
  public static func shownLatest(installed: SemanticVersion, latest: SemanticVersion?) -> SemanticVersion? {
    latest.flatMap { $0 < installed ? nil : $0 }
  }

  /// Whether to ask the registry again. A cache older than `interval` is due, and so is one the installed `stim`
  /// has overtaken, at most every `staleRetryInterval` because a prerelease stays ahead of the registry.
  public static func isDue(
    lastChecked: Date?, now: Date, interval: TimeInterval = checkInterval,
    installed: SemanticVersion? = nil, cachedLatest: SemanticVersion? = nil
  ) -> Bool {
    guard let lastChecked, lastChecked <= now else { return true }
    let age = now.timeIntervalSince(lastChecked)
    if let installed, let cachedLatest, cachedLatest < installed { return age >= min(interval, staleRetryInterval) }
    return age >= interval
  }

  /// Asks the registry; nil when it cannot be reached or answers anything but a manifest.
  public static func fetch() async -> SemanticVersion? {
    var request = URLRequest(url: registryURL, timeoutInterval: 15)
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    guard let (data, response) = try? await URLSession.shared.data(for: request),
      (response as? HTTPURLResponse)?.statusCode == 200
    else { return nil }
    return latest(in: data)
  }
}

/// The last registry answer, kept in `UserDefaults` so a launch within a day does not ask again.
public struct StimReleaseCache {
  static let versionKey = "stimRelease.latest"
  static let checkedKey = "stimRelease.checkedAt"
  private let defaults: UserDefaults

  public init(_ defaults: UserDefaults = .standard) { self.defaults = defaults }

  public var latest: SemanticVersion? { defaults.string(forKey: Self.versionKey).flatMap { SemanticVersion($0) } }
  public var checkedAt: Date? { defaults.object(forKey: Self.checkedKey) as? Date }

  public func store(_ version: SemanticVersion, at date: Date) {
    defaults.set(version.description, forKey: Self.versionKey)
    defaults.set(date, forKey: Self.checkedKey)
  }
}
