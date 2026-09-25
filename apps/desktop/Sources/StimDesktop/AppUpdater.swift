import Combine
import Foundation
import Sparkle

/// Sparkle's updater, started only in a bundled app whose Info.plist carries the appcast's EdDSA public
/// key. Builds without the key, which is every build `scripts/bundle.sh` makes without
/// `SPARKLE_PUBLIC_ED_KEY` and every `swift run`, never check for updates.
@MainActor
final class AppUpdater: ObservableObject {
  static let shared = AppUpdater()

  @Published private(set) var canCheckForUpdates = false
  private let controller: SPUStandardUpdaterController?
  private var observation: AnyCancellable?

  var isAvailable: Bool { controller != nil }

  var automaticallyChecksForUpdates: Bool {
    get { controller?.updater.automaticallyChecksForUpdates ?? false }
    set {
      objectWillChange.send()
      controller?.updater.automaticallyChecksForUpdates = newValue
    }
  }

  private init() {
    let key = Bundle.main.object(forInfoDictionaryKey: "SUPublicEDKey") as? String ?? ""
    guard Bundle.main.bundleURL.pathExtension == "app", !key.trimmingCharacters(in: .whitespaces).isEmpty else {
      controller = nil
      return
    }
    let controller = SPUStandardUpdaterController(
      startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
    self.controller = controller
    observation = controller.updater.publisher(for: \.canCheckForUpdates)
      .receive(on: DispatchQueue.main)
      .sink { [weak self] value in self?.canCheckForUpdates = value }
  }

  func checkForUpdates() {
    controller?.checkForUpdates(nil)
  }
}
