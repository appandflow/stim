import AppKit
import Foundation
import StimKit
import StimStores
@preconcurrency import UserNotifications

/// Checks at launch that the `stim` and, while phones are served, `stim-server` Stim Desktop runs are
/// recent enough, and whether Stim already opens its devices here. It also drives the setup guide, which opens at
/// the first launch and from the Help menu.
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
    var node: CLICompatibility
    var brewPath: String?
    var skillPath: String?
    /// `HOME` in the login shell's environment, where the setup commands run and the skills CLI installs.
    var home: String
    var androidSDK: String?
    var javaHome: String?
  }

  enum PopupKind {
    case stim
    case relaunch
    case server
    case viewer
  }

  static let actionKey = "onboarding"

  @Published private(set) var report: Report?
  /// Dismissed for this launch only; a relaunch clears it, so a persisting problem returns.
  @Published private(set) var dismissedPopups: Set<PopupKind> = []
  @Published private(set) var setup = SetupChecks()
  @Published var showsGuide = false
  @Published var guideStep = SetupStep.welcome
  @Published private(set) var guideRuns: [StimCommand: ActionRun] = [:]
  @Published var projectFolder: String?
  private let progress = SetupGuideProgress()
  private var launchDecided = false
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
          executable: stim.executable, versionOutput: await stim.versionOutput(), minimum: StimCLI.minimumVersion)
        let server = serverOverride.map { StimServerCLI(environment: environment, override: $0) }
        let viewerKeys =
          compatibility.isCompatible && offersViewer
          ? (try? await stim.settings(cwd: NSHomeDirectory())).map { DesktopViewerSettings.unset(in: $0.settings) } ?? []
          : []
        let node = await SetupChecks.version(of: "node", environment: environment)
        let home = environment["HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? NSHomeDirectory()
        let skillPath = SetupChecks.installedSkill(home: home) {
          FileManager.default.fileExists(atPath: $0)
        }
        var serverCompatibility: CLICompatibility?
        if let server {
          serverCompatibility = CLICompatibility.check(
            executable: server.executable, versionOutput: await server.versionOutput(),
            minimum: StimServerCLI.minimumVersion)
        }
        return Report(
          stim: compatibility,
          stimPath: stim.executable,
          needsRelaunch: compatibility.isCompatible && stim.executable != launched,
          server: serverCompatibility,
          serverPath: server?.executable,
          viewerKeys: viewerKeys,
          node: CLICompatibility.check(
            executable: node.path, versionOutput: node.output, minimum: SetupChecks.nodeMinimum),
          brewPath: SetupChecks.tool("brew", environment: environment),
          skillPath: skillPath,
          home: home,
          androidSDK: MachineCheck.androidSDK(environment: environment, home: home) {
            FileManager.default.fileExists(atPath: $0)
          },
          javaHome: environment["JAVA_HOME"].flatMap { $0.isEmpty ? nil : $0 })
      }.value
      self.report = report
      setup.stim = report.stim
      setup.node = report.node
      setup.brewPath = report.brewPath
      setup.skillPath = report.skillPath
      setup.skillChecked = true
      setup.notifications = await Self.notificationAccess()
      if !launchDecided {
        launchDecided = true
        if let step = progress.stepAtLaunch(setup) { presentGuide(at: step) }
      }
    }
  }

  private var home: String { report?.home ?? NSHomeDirectory() }

  var installNodeCommand: StimCommand { StimCommand(["install", "node"], cwd: home, program: "brew") }
  var installCLICommand: StimCommand { StimCommand(["install", "--global", "stim"], cwd: home, program: "npm") }
  /// The skills CLI asks which agents to install to unless `--yes` is given, and the runner has no terminal. Run
  /// from the home folder, its project scope is the user's own agent folders, such as `~/.agents/skills`, so the
  /// skill applies to every project.
  var installSkillCommand: StimCommand {
    StimCommand(["skills", "add", "appandflow/stim", "--yes"], cwd: home, program: "npx")
  }
  var xcodeCommand: StimCommand { StimCommand(["-version"], cwd: home, program: "xcodebuild") }
  var javaCommand: StimCommand { StimCommand(["-version"], cwd: home, program: "java") }

  static func doctorCommand(in folder: String) -> StimCommand { StimCommand(["doctor"], cwd: folder) }

  /// Whether the `stim` this launch resolved is the one installed now, so the app can run it.
  var runsStim: Bool { report.map { $0.stim.isCompatible && !$0.needsRelaunch } ?? false }

  func openGuide() {
    guard !showsGuide else { return }
    presentGuide(at: nil)
    check()
  }

  private func presentGuide(at step: SetupStep?) {
    guideStep = setup.startStep(resuming: step)
    progress.resumed()
    showsGuide = true
  }

  /// Closes the guide for good; the Help menu and Settings reopen it.
  func finishGuide() {
    progress.finish()
    showsGuide = false
  }

  func runGuide(_ title: String, _ command: StimCommand) {
    guard
      let run = actions.run(
        title, steps: [command], key: Self.actionKey, present: false,
        completion: { [weak self] _ in
          self?.check()
        })
    else { return }
    guideRuns[command] = run
  }

  func chooseProjectFolder() {
    let panel = NSOpenPanel()
    panel.canChooseFiles = false
    panel.canChooseDirectories = true
    panel.prompt = "Choose"
    panel.message = "Choose a React Native or Expo project"
    guard panel.runModal() == .OK, let url = panel.url else { return }
    projectFolder = url.path
  }

  func finishAndRestart() {
    progress.finish()
    relaunch()
  }

  func restartForSetup() {
    progress.saveForRestart(at: guideStep)
    relaunch()
  }

  private static func notificationAccess() async -> NotificationAccess {
    guard Notifier.isAvailable else { return .unavailable }
    switch await UNUserNotificationCenter.current().notificationSettings().authorizationStatus {
    case .notDetermined: return .notDetermined
    case .denied: return .denied
    default: return .allowed
    }
  }

  func requestNotifications() {
    guard Notifier.isAvailable else { return }
    Task {
      _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
      setup.notifications = await Self.notificationAccess()
    }
  }

  func refreshNotifications() {
    Task { setup.notifications = await Self.notificationAccess() }
  }

  func openNotificationSettings() {
    let id = Bundle.main.bundleIdentifier ?? ""
    guard let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=\(id)") else {
      return
    }
    NSWorkspace.shared.open(url)
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

  func dismissPopup(_ kind: PopupKind) {
    if kind == .viewer {
      dismissViewerOffer()
    } else {
      dismissedPopups.insert(kind)
    }
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
