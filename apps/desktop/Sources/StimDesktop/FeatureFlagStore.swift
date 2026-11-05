import Combine
import Foundation
import StimKit

/// The feature flags as SwiftUI sees them: views observe this and ask `isEnabled`; code outside views calls
/// `FeatureFlags.isEnabled` directly.
@MainActor
final class FeatureFlagStore: ObservableObject {
  static let shared = FeatureFlagStore()

  @Published private(set) var enabled: Set<FeatureFlag>
  @Published private(set) var hasOverrides: Bool
  private let defaults: UserDefaults
  private var subscription: AnyCancellable?

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    enabled = Self.read(defaults)
    hasOverrides = Self.overridden(defaults)
    subscription = NotificationCenter.default.publisher(for: UserDefaults.didChangeNotification, object: defaults)
      .receive(on: DispatchQueue.main)
      .sink { [weak self] _ in self?.refresh() }
  }

  func isEnabled(_ flag: FeatureFlag) -> Bool { enabled.contains(flag) }

  var phoneApp: Bool { isEnabled(.phoneApp) }

  func set(_ flag: FeatureFlag, enabled value: Bool) {
    FeatureFlags.set(flag, enabled: value, defaults: defaults)
    refresh()
  }

  func reset() {
    FeatureFlags.reset(defaults: defaults)
    refresh()
  }

  private func refresh() {
    let current = Self.read(defaults)
    if current != enabled { enabled = current }
    let overridden = Self.overridden(defaults)
    if overridden != hasOverrides { hasOverrides = overridden }
  }

  private static func overridden(_ defaults: UserDefaults) -> Bool {
    FeatureFlag.allCases.contains { FeatureFlags.isOverridden($0, defaults: defaults) }
  }

  private static func read(_ defaults: UserDefaults) -> Set<FeatureFlag> {
    Set(FeatureFlag.allCases.filter { FeatureFlags.isEnabled($0, defaults: defaults) })
  }
}
