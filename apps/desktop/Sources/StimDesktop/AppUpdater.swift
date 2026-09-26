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
  /// A valid update was found and not yet resolved by an install, skip, or a later check that found none.
  @Published private(set) var updateAvailable = false
  private let controller: SPUStandardUpdaterController?
  private var delegate: UpdaterDelegateForwarder?
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
    let delegate = UpdaterDelegateForwarder()
    self.delegate = delegate
    let controller = SPUStandardUpdaterController(
      startingUpdater: true, updaterDelegate: delegate, userDriverDelegate: nil)
    self.controller = controller
    delegate.onFoundUpdate = { [weak self] in self?.updateAvailable = true }
    delegate.onNoUpdate = { [weak self] in self?.updateAvailable = false }
    observation = controller.updater.publisher(for: \.canCheckForUpdates)
      .receive(on: DispatchQueue.main)
      .sink { [weak self] value in self?.canCheckForUpdates = value }
  }

  func checkForUpdates() {
    controller?.checkForUpdates(nil)
  }
}

/// Forwards the two Sparkle delegate callbacks the footer needs into plain closures.
/// `SPUUpdaterDelegate` requires `NSObject` conformance, which `AppUpdater` does not have.
@MainActor
private final class UpdaterDelegateForwarder: NSObject, SPUUpdaterDelegate {
  var onFoundUpdate: (() -> Void)?
  var onNoUpdate: (() -> Void)?

  func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) {
    onFoundUpdate?()
  }

  func updaterDidNotFindUpdate(_ updater: SPUUpdater, error: Error) {
    onNoUpdate?()
  }
}
