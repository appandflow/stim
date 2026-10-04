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
    guard let request = probeRequest(environment: environment, home: home) else { return nil }
    return (try? await request.run()).flatMap(parse)
  }

  /// `probe(environment:home:)` on the calling thread, given 2 seconds.
  static func probeNow(environment: [String: String], home: String) -> NodeRuntime? {
    guard let request = probeRequest(environment: environment, home: home, timeout: 2) else { return nil }
    return (try? request.runBlocking()).flatMap(parse)
  }

  public var isSupported: Bool { SemanticVersion(version).map { $0 >= SetupChecks.nodeMinimum } ?? false }

  private static func probeRequest(
    environment: [String: String], home: String, timeout: TimeInterval = 10
  ) -> ProcessRequest? {
    var environment = environment
    guard let node = resolveExecutable("node", override: nil, environment: &environment) else { return nil }
    return ProcessRequest(
      node, ["-p", "process.execPath + '\\n' + process.versions.node"], cwd: home, environment: environment,
      timeout: timeout)
  }

  private static func parse(_ result: ProcessResult) -> NodeRuntime? {
    guard result.succeeded else { return nil }
    let lines = result.stdoutText.split(whereSeparator: \.isNewline).map(String.init).suffix(2)
    guard lines.count == 2, let path = lines.first, let version = lines.last, path.hasPrefix("/"),
      SemanticVersion(version) != nil
    else { return nil }
    return NodeRuntime(path: path, version: version)
  }
}

/// Runs a Node CLI's JavaScript file under the home directory's Node. Run through its `#!/usr/bin/env node` line
/// in a project instead, a version manager that follows the working directory (asdf, mise, Volta) would pick the
/// project's pinned Node, which can be older than the CLI supports.
public final class NodeLauncher: @unchecked Sendable {
  /// The home directory's Node is older than `SetupChecks.nodeMinimum`.
  public struct Unsupported: LocalizedError, Equatable {
    public let runtime: NodeRuntime

    public var errorDescription: String? {
      "Stim needs Node.js \(SetupChecks.nodeMinimum) or later, but node in the home folder is \(runtime.version) at "
        + "\(runtime.path). Make a newer Node your version manager's default, then try again."
    }
  }

  /// The executable whose JavaScript file the CLI runs: the CLI's own, or a package manager's global install behind
  /// a version-manager shim. Each command reads it again, so an update that moves the file takes effect at once.
  public let source: String
  private let environment: [String: String]
  private let home: String
  private let reprobeInterval: TimeInterval
  private let lock = NSLock()
  private var current: NodeRuntime
  private var probed = Date.distantPast

  init(
    source: String, runtime: NodeRuntime, environment: [String: String], home: String,
    reprobeInterval: TimeInterval = 10
  ) {
    self.source = source
    self.current = runtime
    self.environment = environment
    self.home = home
    self.reprobeInterval = reprobeInterval
  }

  public var runtime: NodeRuntime { lock.withLock { current } }

  /// The JavaScript file `source` runs now.
  public var script: String? { Self.nodeScript(at: source) }

  /// The launcher for the CLI at `executable`, or nil when the home directory has no `node` or `executable` leads
  /// to no JavaScript file. A version-manager shim leads to the `name` that `layout`, probed when nil, places in a
  /// package manager's global bin directory; any other executable, such as a wrapper script, runs as it is.
  public static func resolve(
    executable: String?, name: String, environment: [String: String],
    layout: (() async -> PackageManagerLayout)? = nil, reprobeInterval: TimeInterval = 10
  ) async -> NodeLauncher? {
    let home = environment["HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? NSHomeDirectory()
    guard let executable, let runtime = await NodeRuntime.probe(environment: environment, home: home) else {
      return nil
    }
    var source: String? = nodeScript(at: executable) == nil ? nil : executable
    if source == nil, isVersionManagerShim(executable) {
      var managers: PackageManagerLayout
      if let layout {
        managers = await layout()
      } else {
        managers = await PackageManagerLayout.probe(environment: environment, home: home)
      }
      source = managers.globalExecutables(name).first { nodeScript(at: $0) != nil }
    }
    return source.map {
      NodeLauncher(
        source: $0, runtime: runtime, environment: environment, home: home, reprobeInterval: reprobeInterval)
    }
  }

  /// The program and arguments that run the script with `arguments`. When the Node binary is gone, as after a
  /// Homebrew upgrade or a version manager's uninstall, or older than `SetupChecks.nodeMinimum`, it finds the home
  /// directory's Node again first, at most once per `reprobeInterval`. Nil while the script or every `node` is
  /// gone; throws `Unsupported` while the Node is older than `SetupChecks.nodeMinimum`.
  public func command(_ arguments: [String]) throws -> (program: String, arguments: [String])? {
    guard let script else { return nil }
    let found: NodeRuntime? = lock.withLock {
      let exists = FileManager.default.isExecutableFile(atPath: current.path)
      if (exists && current.isSupported) || Date().timeIntervalSince(probed) < reprobeInterval {
        return exists ? current : nil
      }
      probed = Date()
      if let found = NodeRuntime.probeNow(environment: environment, home: home) { current = found }
      return FileManager.default.isExecutableFile(atPath: current.path) ? current : nil
    }
    guard let found else { return nil }
    guard found.isSupported else { throw Unsupported(runtime: found) }
    return (found.path, [script] + arguments)
  }

  /// A file in a `shims` directory, where asdf, mise and nodenv put the shims that pick a version from the working
  /// directory. Volta's shims pin a package to the Node it was installed with, so they run as they are.
  static func isVersionManagerShim(_ executable: String) -> Bool {
    ((executable as NSString).deletingLastPathComponent as NSString).lastPathComponent == "shims"
  }

  /// The JavaScript file `executable` runs, past symbolic links and pnpm shims, or nil when that file is not one:
  /// its `#!` line names `node`, or it has none and a JavaScript extension.
  static func nodeScript(at executable: String) -> String? {
    guard FileManager.default.isExecutableFile(atPath: executable) else { return nil }
    let target = PackageManagerLayout.target(ofExecutable: executable)
    guard let handle = FileHandle(forReadingAtPath: target) else { return nil }
    defer { try? handle.close() }
    let head = (try? handle.read(upToCount: 256)).map { String(decoding: $0, as: UTF8.self) } ?? ""
    guard head.hasPrefix("#!"), let line = head.split(whereSeparator: \.isNewline).first else {
      return ["js", "mjs", "cjs"].contains((target as NSString).pathExtension) ? target : nil
    }
    let interpreter = line.dropFirst(2).split(separator: " ").map { (String($0) as NSString).lastPathComponent }
    return interpreter.contains("node") ? target : nil
  }
}
