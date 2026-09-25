import AppKit
import Foundation
import StimKit

/// Checks at launch that the `stim` and, while phones are served, `stim-server` Stim Desktop runs are
/// recent enough, and whether Stim already opens its devices here.
@MainActor
final class Onboarding: ObservableObject {
  struct Report: Equatable {
    var stim: CLICompatibility
    var stimPath: String?
    /// The executable the launch resolved differs from the one the preferences resolve now.
    var needsRelaunch: Bool
    var server: CLICompatibility?
    var serverPath: String?
    var viewerKeys: [String]
  }

  static let actionKey = "onboarding"

  @Published private(set) var report: Report?
  private let environment: Task<[String: String], Never>
  private let cli: Task<StimCLI, Never>
  private let actions: ActionCenter

  init(environment: Task<[String: String], Never>, cli: Task<StimCLI, Never>, actions: ActionCenter) {
    self.environment = environment
    self.cli = cli
    self.actions = actions
  }

  func check() {
    let environment = environment
    let cli = cli
    let defaults = UserDefaults.standard
    let stimOverride = defaults.string(forKey: AppPreferences.Key.stimExecutable)
    let serverOverride =
      defaults.bool(forKey: AppPreferences.Key.servesPhones)
      ? defaults.string(forKey: AppPreferences.Key.stimServerExecutable) ?? "" : nil
    let offersViewer = !defaults.bool(forKey: AppPreferences.Key.viewerOfferDismissed)
    Task {
      let environment = await environment.value
      let launched = await cli.value.executable
      let report = await Task.detached {
        let stim = StimCLI(environment: environment, override: stimOverride)
        let compatibility = CLICompatibility.check(
          executable: stim.executable, versionOutput: stim.versionOutput(), minimum: StimCLI.minimumVersion)
        let server = serverOverride.map { StimServerCLI(environment: environment, override: $0) }
        let viewerKeys =
          compatibility.isCompatible && offersViewer
          ? (try? stim.settings(cwd: NSHomeDirectory())).map { DesktopViewerSettings.unset(in: $0.settings) } ?? []
          : []
        return Report(
          stim: compatibility,
          stimPath: stim.executable,
          needsRelaunch: compatibility.isCompatible && stim.executable != launched,
          server: server.map {
            CLICompatibility.check(
              executable: $0.executable, versionOutput: $0.versionOutput(), minimum: StimServerCLI.minimumVersion)
          },
          serverPath: server?.executable,
          viewerKeys: viewerKeys)
      }.value
      self.report = report
    }
  }

  func installStim() {
    let title = report?.stim == .missing ? "Install stim" : "Update stim"
    install(title, package: "stim@latest")
  }

  func installServer() {
    let title = report?.server == .missing ? "Install stim-server" : "Update stim-server"
    install(title, package: "@stim-cli/server@latest") { status in
      guard status == 0 else { return }
      ServerController.shared.stop()
      ServerController.shared.start()
    }
  }

  func chooseStim() {
    choose(AppPreferences.Key.stimExecutable)
  }

  func chooseServer() {
    guard choose(AppPreferences.Key.stimServerExecutable) else { return }
    ServerController.shared.stop()
    ServerController.shared.start()
  }

  func useDesktopViewer() {
    let steps = (report?.viewerKeys ?? []).map {
      StimCommand(["settings", "set", $0, DesktopViewerSettings.value, "--scope", "machine"], cwd: NSHomeDirectory())
    }
    guard !steps.isEmpty else { return }
    actions.run("Use Stim Desktop as the device viewer", steps: steps, key: Self.actionKey) { [weak self] _ in
      self?.check()
    }
  }

  func dismissViewerOffer() {
    UserDefaults.standard.set(true, forKey: AppPreferences.Key.viewerOfferDismissed)
    report?.viewerKeys = []
  }

  var canRelaunch: Bool { Bundle.main.bundleURL.pathExtension == "app" }

  /// Starts a new instance with this one's environment, then quits.
  func relaunch() {
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.createsNewApplicationInstance = true
    configuration.environment = ProcessInfo.processInfo.environment
    NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: configuration) { _, error in
      guard error == nil else { return }
      DispatchQueue.main.async { NSApp.terminate(nil) }
    }
  }

  private func install(_ title: String, package: String, then: ((Int32?) -> Void)? = nil) {
    let command = StimCommand(["install", "--global", package], cwd: NSHomeDirectory(), program: "npm")
    actions.run(title, steps: [command], key: Self.actionKey) { [weak self] run in
      then?(run.exitStatus)
      self?.check()
    }
  }

  @discardableResult
  private func choose(_ key: String) -> Bool {
    let panel = NSOpenPanel()
    panel.canChooseFiles = true
    panel.canChooseDirectories = false
    panel.showsHiddenFiles = true
    panel.prompt = "Choose"
    guard panel.runModal() == .OK, let url = panel.url else { return false }
    UserDefaults.standard.set(url.path, forKey: key)
    check()
    return true
  }
}
