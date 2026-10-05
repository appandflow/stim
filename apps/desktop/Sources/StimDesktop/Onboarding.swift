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
    var stimOwner: PackageManager?
    var installers: [PackageManager]
    var defaultInstaller: PackageManager
    /// The executable the launch resolved differs from the one the preferences resolve now.
    var needsRelaunch: Bool
    var server: CLICompatibility?
    var serverPath: String?
    var viewerKeys: [String]
    var node: CLICompatibility
    var nodePath: String?
    var brewPath: String?
    var skillPath: String?
    /// `HOME` in the login shell's environment, where the setup commands run and the skills CLI installs.
    var home: String
    var androidSDK: String?
    var javaHome: String?
    /// The Node, older than Stim supports, that kept `stim` from reporting its version.
    var nodeBlockingStim: NodeRuntime?
    /// The same for `stim-server`.
    var nodeBlockingServer: NodeRuntime?

    var nodeBlocksStim: Bool
    var nodeBlocksServer: Bool
  }

  enum PopupKind {
    case node
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
  @Published var installerChoice: PackageManager?
  /// The newest `stim` the npm registry listed at the last check, from a day-old cache until the next check.
  @Published private(set) var latestStim: SemanticVersion?
  private let releases = StimReleaseCache()
  private var fetchingLatest = false
  private let progress = SetupGuideProgress()
  private var launchDecided = false
  private let environment: Task<[String: String], Never>
  private let cli: Task<StimCLI, Never>
  private let actions: ActionCenter

  init(environment: Task<[String: String], Never>, cli: Task<StimCLI, Never>, actions: ActionCenter) {
    self.environment = environment
    self.cli = cli
    self.actions = actions
    latestStim = releases.latest
    Task { [weak self] in
      while !Task.isCancelled {
        self?.refreshLatestStim()
        try? await Task.sleep(for: .seconds(3600))
      }
    }
  }

  /// The version to offer the installed `stim`, nil when it is current or no package manager owns it.
  var stimUpdate: SemanticVersion? {
    report.flatMap { StimRelease.offer(installed: $0.stim, latest: latestStim, owner: $0.stimOwner) }
  }

  /// Asks the registry when the last answer is a day old; offline leaves the cached answer and tries again later.
  func refreshLatestStim() {
    guard !fetchingLatest, StimRelease.isDue(lastChecked: releases.checkedAt, now: Date()) else { return }
    fetchingLatest = true
    Task {
      defer { fetchingLatest = false }
      guard let latest = await StimRelease.fetch() else { return }
      releases.store(latest, at: Date())
      latestStim = latest
    }
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
      let launched = await cli.value
      let report = await Task.detached {
        let home = environment["HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? NSHomeDirectory()
        let packages = await PackageManagerLayout.probe(environment: environment, home: home)
        let stim = await StimCLI.resolve(environment: environment, override: stimOverride) { packages }
        let compatibility = CLICompatibility.check(
          executable: stim.executable, versionOutput: await stim.versionOutput(), minimum: StimCLI.minimumVersion)
        var server: StimServerCLI?
        if let serverOverride {
          server = await StimServerCLI.resolve(environment: environment, override: serverOverride) { packages }
        }
        let viewerKeys =
          compatibility.isCompatible && offersViewer
          ? (try? await stim.settings(cwd: NSHomeDirectory())).map { DesktopViewerSettings.unset(in: $0.settings) } ?? []
          : []
        var node = stim.launcher?.runtime
        if node == nil { node = await NodeRuntime.probe(environment: stim.environment, home: home) }
        let nodePath = node?.path ?? SetupChecks.tool("node", environment: stim.environment)
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
          stimOwner: (stim.launcher?.source ?? stim.executable).flatMap { packages.owner(ofExecutable: $0) },
          installers: packages.installed,
          defaultInstaller: packages.defaultInstaller(path: environment["PATH"] ?? ""),
          needsRelaunch: compatibility.isCompatible
            && (stim.executable != launched.executable || stim.launcher?.source != launched.launcher?.source),
          server: serverCompatibility,
          serverPath: server?.executable,
          viewerKeys: viewerKeys,
          node: CLICompatibility.check(
            executable: nodePath, versionOutput: node?.version, minimum: SetupChecks.nodeMinimum),
          nodePath: nodePath,
          brewPath: SetupChecks.tool("brew", environment: environment),
          skillPath: skillPath,
          home: home,
          androidSDK: MachineCheck.androidSDK(environment: environment, home: home) {
            FileManager.default.fileExists(atPath: $0)
          },
          javaHome: environment["JAVA_HOME"].flatMap { $0.isEmpty ? nil : $0 },
          nodeBlockingStim: compatibility == .outdated(found: nil)
            ? stim.launcher.flatMap(\.runtime).flatMap { $0.isSupported ? nil : $0 } : nil,
          nodeBlockingServer: serverCompatibility == .outdated(found: nil)
            ? server?.launcher.flatMap(\.runtime).flatMap { $0.isSupported ? nil : $0 } : nil,
          nodeBlocksStim: compatibility == .outdated(found: nil) && stim.launcher != nil
            && stim.launcher?.runtime?.isSupported != true,
          nodeBlocksServer: serverCompatibility == .outdated(found: nil) && server?.launcher != nil
            && server?.launcher?.runtime?.isSupported != true)
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
  var installer: PackageManager { installerChoice ?? report?.defaultInstaller ?? .npm }
  /// Installs `stim`, or updates it with the manager that owns it; nil when `stim` is installed but no package
  /// manager owns it, as a linked checkout, so there is nothing for the app to update.
  var installCLICommand: StimCommand? {
    guard let report else { return nil }
    guard report.stim != .missing else { return installer.installCommand("stim@latest", cwd: home) }
    return report.stimOwner?.installCommand("stim@latest", cwd: home)
  }
  /// The skills CLI asks which agents to install to unless `--yes` is given, and the runner has no terminal. Run
  /// from the home folder, its project scope is the user's own agent folders, such as `~/.agents/skills`, so the
  /// skill applies to every project.
  var installSkillCommand: StimCommand {
    StimCommand(["skills", "add", "appandflow/stim", "--yes"], cwd: home, program: "npx")
  }
  var xcodeCommand: StimCommand { StimCommand(["-version"], cwd: home, program: "xcodebuild") }
  var javaCommand: StimCommand { StimCommand(["-version"], cwd: home, program: "java") }

  static func doctorCommand(in folder: String) -> StimCommand { StimCommand(["doctor", "--json"], cwd: folder) }

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

  func runGuide(_ title: String, _ command: StimCommand, then: (() -> Void)? = nil) {
    guard
      let run = actions.run(
        title, steps: [command], key: Self.actionKey, present: false,
        completion: { [weak self] run in
          self?.recordCheck(command, run)
          self?.check()
          then?()
        })
    else { return }
    guideRuns[command] = run
  }

  private func recordCheck(_ command: StimCommand, _ run: ActionRun) {
    let output = run.lines.map(\.text).joined(separator: "\n")
    let succeeded = run.exitStatus == 0
    func outcome(_ passed: Bool) -> CheckOutcome { passed ? .passed : .failed }
    if command == xcodeCommand {
      setup.xcodeCheck = outcome(succeeded && MachineCheck.xcode(output) != nil)
    } else if command == javaCommand {
      setup.javaCheck = outcome(succeeded && MachineCheck.java(output) != nil)
    } else if command == projectFolder.map(Self.doctorCommand(in:)) {
      setup.projectCheck = outcome(succeeded && DoctorReport.decode(run.stdout)?.costFindings.isEmpty == true)
    }
  }

  func chooseProjectFolder() {
    let panel = NSOpenPanel()
    panel.canChooseFiles = false
    panel.canChooseDirectories = true
    panel.prompt = "Choose"
    panel.message = "Choose a React Native or Expo project"
    guard panel.runModal() == .OK, let url = panel.url else { return }
    if url.path != projectFolder { setup.projectCheck = nil }
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
    guard let command = installCLICommand else { return }
    run(report?.stim == .missing ? "Install stim" : "Update stim", command)
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
    run(title, PackageManager.npm.installCommand(package, cwd: NSHomeDirectory()), then: then)
  }

  private func run(_ title: String, _ command: StimCommand, then: ((Int32?) -> Void)? = nil) {
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
