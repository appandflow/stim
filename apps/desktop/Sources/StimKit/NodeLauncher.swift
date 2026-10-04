import Foundation

/// The Node that `node` resolves to in the home directory, where no project pins one.
public struct NodeRuntime: Equatable, Sendable {
  /// The real binary, as `process.execPath` reports it, past any version-manager shim.
  public var path: String
  /// `process.versions.node`.
  public var version: String

  public init(path: String, version: String) {
    self.path = path
    self.version = version
  }

  /// Runs the first `node` on `environment`'s PATH in `home`. Nil when it is missing, fails, or prints something
  /// else.
  public static func probe(environment: [String: String], home: String) async -> NodeRuntime? {
    var environment = environment
    guard let node = resolveExecutable("node", override: nil, environment: &environment) else { return nil }
    let request = ProcessRequest(
      node, ["-p", "process.execPath + '\\n' + process.versions.node"], cwd: home, environment: environment,
      timeout: 10)
    guard let result = try? await request.run(), result.succeeded else { return nil }
    let lines = result.stdoutText.split(whereSeparator: \.isNewline).map(String.init)
    guard lines.count == 2, lines[0].hasPrefix("/") else { return nil }
    return NodeRuntime(path: lines[0], version: lines[1])
  }
}

/// Runs a Node CLI's JavaScript file under the home directory's Node. Run through its `#!/usr/bin/env node` line
/// in a project instead, a version manager that follows the working directory (asdf, mise, Volta) would pick the
/// project's pinned Node, which can be older than the CLI supports.
public final class NodeLauncher: @unchecked Sendable {
  /// The executable whose JavaScript file the CLI runs: the CLI's own, or a package manager's global install behind
  /// a version-manager shim. Each command reads it again, so an update that moves the file takes effect at once.
  public let source: String
  private let environment: [String: String]
  private let home: String
  private let lock = NSLock()
  private var current: NodeRuntime
  private var refreshing = false

  init(source: String, runtime: NodeRuntime, environment: [String: String], home: String) {
    self.source = source
    self.current = runtime
    self.environment = environment
    self.home = home
  }

  public var runtime: NodeRuntime { lock.withLock { current } }

  /// The JavaScript file `source` runs now.
  public var script: String? { Self.nodeScript(at: source) }

  /// The launcher for the CLI at `executable`, or nil when the home directory has no `node` or `executable` leads
  /// to no JavaScript file. A version-manager shim leads to the `name` that `layout` places in a package manager's
  /// global bin directory; any other executable, such as a wrapper script, runs as it is.
  public static func resolve(
    executable: String?, name: String, environment: [String: String], home: String,
    layout: () async -> PackageManagerLayout
  ) async -> NodeLauncher? {
    guard let executable, let runtime = await NodeRuntime.probe(environment: environment, home: home) else {
      return nil
    }
    var source: String? = nodeScript(at: executable) == nil ? nil : executable
    if source == nil, isVersionManagerShim(executable) {
      source = await layout().globalExecutables(name).first { nodeScript(at: $0) != nil }
    }
    return source.map { NodeLauncher(source: $0, runtime: runtime, environment: environment, home: home) }
  }

  /// The program and arguments that run the script with `arguments`. Nil while the script is gone, and once the
  /// Node binary is gone, as after a Homebrew upgrade or a version manager's uninstall; the next commands use the
  /// Node resolved again.
  public func command(_ arguments: [String]) -> (program: String, arguments: [String])? {
    guard let script else { return nil }
    let node = runtime.path
    if FileManager.default.isExecutableFile(atPath: node) { return (node, [script] + arguments) }
    let start = lock.withLock {
      defer { refreshing = true }
      return !refreshing
    }
    if start {
      Task.detached { [self] in
        let found = await NodeRuntime.probe(environment: environment, home: home)
        lock.withLock {
          if let found { current = found }
          refreshing = false
        }
      }
    }
    return nil
  }

  /// A file in a `shims` directory, where asdf, mise and nodenv put the shims that pick a version from the working
  /// directory. Volta's shims pin a package to the Node it was installed with, so they run as they are.
  static func isVersionManagerShim(_ executable: String) -> Bool {
    ((executable as NSString).deletingLastPathComponent as NSString).lastPathComponent == "shims"
  }

  /// The JavaScript file `executable` runs, past symbolic links and pnpm shims, or nil when that file is not one.
  static func nodeScript(at executable: String) -> String? {
    guard FileManager.default.isExecutableFile(atPath: executable) else { return nil }
    let target = PackageManagerLayout.target(ofExecutable: executable)
    if ["js", "mjs", "cjs"].contains((target as NSString).pathExtension) { return target }
    guard let handle = FileHandle(forReadingAtPath: target) else { return nil }
    defer { try? handle.close() }
    let head = (try? handle.read(upToCount: 256)).map { String(decoding: $0, as: UTF8.self) } ?? ""
    guard head.hasPrefix("#!"), let line = head.split(whereSeparator: \.isNewline).first else { return nil }
    let interpreter = line.dropFirst(2).split(separator: " ").map { (String($0) as NSString).lastPathComponent }
    return interpreter.contains("node") ? target : nil
  }
}
