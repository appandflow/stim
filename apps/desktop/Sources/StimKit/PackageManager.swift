import Foundation

/// A package manager that installs `stim` globally. Yarn is left out: Yarn 2 and later have no global install.
public enum PackageManager: String, CaseIterable, Sendable {
  case npm, pnpm, bun

  /// Installs or updates `package` for the user.
  public func installCommand(_ package: String, cwd: String) -> StimCommand {
    StimCommand([self == .npm ? "install" : "add", "--global", package], cwd: cwd, program: rawValue)
  }
}

/// Where each package manager keeps its global packages, from the managers' own queries. A manager whose query
/// failed or that is not installed has nil fields. Every path is canonical (symbolic links resolved).
public struct PackageManagerLayout: Equatable, Sendable {
  /// `npm prefix -g`: packages live in `lib/node_modules` and binaries in `bin`.
  public var npmPrefix: String?
  /// `pnpm root -g`.
  public var pnpmRoot: String?
  /// `pnpm bin -g`.
  public var pnpmBin: String?
  /// `bun pm bin -g`: packages live in `../install/global/node_modules`.
  public var bunBin: String?
  /// The managers found on the login shell's PATH.
  public var installed: [PackageManager]

  public init(
    npmPrefix: String? = nil, pnpmRoot: String? = nil, pnpmBin: String? = nil, bunBin: String? = nil,
    installed: [PackageManager] = []
  ) {
    self.npmPrefix = npmPrefix
    self.pnpmRoot = pnpmRoot
    self.pnpmBin = pnpmBin
    self.bunBin = bunBin
    self.installed = installed
  }

  /// The manager that installed the `stim` whose real file is `target`, or nil when `target` is in no manager's
  /// global directory: a linked checkout, a project-local `node_modules`, a copied script.
  public func owner(ofTarget target: String) -> PackageManager? {
    func inside(_ directory: String?) -> Bool {
      guard let directory, !directory.isEmpty else { return false }
      return target.hasPrefix(directory.hasSuffix("/") ? directory : directory + "/")
    }
    if inside(npmPrefix.map { "\($0)/lib/node_modules/stim" }) { return .npm }
    if inside(pnpmRoot) { return .pnpm }
    if inside(bunBin.map { "\(($0 as NSString).deletingLastPathComponent)/install/global/node_modules/stim" }) {
      return .bun
    }
    return nil
  }

  /// The manager a fresh install defaults to: pnpm or bun when its global bin directory is on `path`, else npm.
  public func defaultInstaller(path: String) -> PackageManager {
    let entries = Set(path.split(separator: ":").map { (String($0) as NSString).resolvingSymlinksInPath })
    if installed.contains(.pnpm), let bin = pnpmBin, entries.contains(bin) { return .pnpm }
    if installed.contains(.bun), let bin = bunBin, entries.contains(bin) { return .bun }
    return installed.contains(.npm) ? .npm : installed.first ?? .npm
  }

  /// The file `stim` really runs: `executable` with symbolic links resolved, or, for a pnpm shim script, the file
  /// named by its `# cmd-shim-target=` line.
  public static func target(ofExecutable executable: String, contents: String?) -> String {
    let resolved = (executable as NSString).resolvingSymlinksInPath
    guard let contents else { return resolved }
    let marker = "# cmd-shim-target="
    guard let line = contents.split(whereSeparator: \.isNewline).last(where: { $0.hasPrefix(marker) }) else {
      return resolved
    }
    return (String(line.dropFirst(marker.count)) as NSString).resolvingSymlinksInPath
  }

  /// `target(ofExecutable:contents:)` with the head of the file at `executable`.
  public static func target(ofExecutable executable: String) -> String {
    let handle = FileHandle(forReadingAtPath: executable)
    let head = handle.flatMap { try? $0.read(upToCount: 65536) }.flatMap { String(data: $0, encoding: .utf8) }
    try? handle?.close()
    return target(ofExecutable: executable, contents: head?.hasPrefix("#!") == true ? head : nil)
  }

  /// Where each manager's global install puts the executable `name`.
  public func globalExecutables(_ name: String) -> [String] {
    [npmPrefix.map { "\($0)/bin/\(name)" }, pnpmBin.map { "\($0)/\(name)" }, bunBin.map { "\($0)/\(name)" }]
      .compactMap { $0 }
  }
}

extension PackageManagerLayout {
  /// Asks each installed manager, in `home` where no project pins a Node, where it keeps global packages. A query
  /// that fails leaves its fields nil.
  public static func probe(environment: [String: String], home: String) async -> PackageManagerLayout {
    var layout = PackageManagerLayout()
    func query(_ manager: PackageManager, _ arguments: [String]) async -> String? {
      var environment = environment
      guard let path = resolveExecutable(manager.rawValue, override: nil, environment: &environment) else { return nil }
      guard
        let result = try? await ProcessRequest(path, arguments, cwd: home, environment: environment, timeout: 10).run(),
        result.succeeded
      else { return nil }
      let line = result.stdoutText.split(whereSeparator: \.isNewline).last.map { String($0) }
      return line.map { ($0 as NSString).resolvingSymlinksInPath }
    }
    for manager in PackageManager.allCases where SetupChecks.tool(manager.rawValue, environment: environment) != nil {
      layout.installed.append(manager)
    }
    if layout.installed.contains(.npm) { layout.npmPrefix = await query(.npm, ["prefix", "-g"]) }
    if layout.installed.contains(.pnpm) {
      layout.pnpmRoot = await query(.pnpm, ["root", "-g"])
      layout.pnpmBin = await query(.pnpm, ["bin", "-g"])
      // Without its global bin directory on PATH, pnpm refuses `root -g`, `bin -g` and `add --global` alike
      // (ERR_PNPM_GLOBAL_BIN_DIR_NOT_IN_PATH), so it cannot install `stim` for the user.
      if layout.pnpmRoot == nil || layout.pnpmBin == nil { layout.installed.removeAll { $0 == .pnpm } }
    }
    if layout.installed.contains(.bun) { layout.bunBin = await query(.bun, ["pm", "bin", "-g"]) }
    return layout
  }

  /// The manager that owns the `stim` at `executable`, nil when none does.
  public func owner(ofExecutable executable: String) -> PackageManager? {
    owner(ofTarget: Self.target(ofExecutable: executable))
  }
}
