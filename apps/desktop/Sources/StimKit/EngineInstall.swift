import CryptoKit
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
      node, ["-p", "process.execPath + '\\n' + process.versions.node"], cwd: home, environment: environment, timeout: 10)
    guard let result = try? await request.run(), result.succeeded else { return nil }
    let lines = result.stdoutText.split(whereSeparator: \.isNewline).map(String.init).suffix(2)
    guard lines.count == 2, let path = lines.first, let version = lines.last, path.hasPrefix("/"),
      SemanticVersion(version) != nil
    else { return nil }
    return NodeRuntime(path: path, version: version)
  }

  public var isSupported: Bool { SemanticVersion(version).map { $0 >= SetupChecks.nodeMinimum } ?? false }
}

/// The official Node.js release Desktop installs under `<runtime>/` on a Mac without Node 22.12 or later, so it can
/// install the Stim engine. A Desktop update that pins a newer release installs it at the next launch and removes the
/// older ones nothing points at.
public enum ManagedNode {
  public static let version = "v24.21.0"
  /// The SHA-256 of each release archive, which nodejs.org's `SHASUMS256.txt` must also list.
  static let archiveSHA256 = [
    "arm64": "6239d4cf92d864487ec8cd3615038f7b67e7f58b77b21cd2f09ea9fbd68065fe",
    "x64": "0ae5a24c24bb7d015cd816c5036b3f90f2945aa872fcf54e58da054753b3a299",
  ]

  public enum Failure: LocalizedError, Equatable {
    case download(String)
    case checksum(String)
    case extract(String)

    public var errorDescription: String? {
      switch self {
      case .download(let detail): "Could not download Node.js \(ManagedNode.version) from nodejs.org: \(detail)"
      case .checksum(let detail): "The Node.js \(ManagedNode.version) download did not match its checksum: \(detail)"
      case .extract(let detail): "Could not unpack Node.js \(ManagedNode.version): \(detail)"
      }
    }
  }

  public static var architecture: String {
    var info = utsname()
    uname(&info)
    let machine = withUnsafeBytes(of: &info.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
    return machine == "arm64" ? "arm64" : "x64"
  }

  static func archiveName(architecture: String) -> String { "node-\(version)-darwin-\(architecture).tar.xz" }

  public static func directory(_ root: EngineRoot, architecture: String = architecture) -> String {
    "\(root.runtime)/node-\(version)-darwin-\(architecture)"
  }

  /// The installed managed Node of this release, or nil.
  public static func installed(_ root: EngineRoot) -> NodeRuntime? {
    let node = "\(directory(root))/bin/node"
    guard FileManager.default.isExecutableFile(atPath: node) else { return nil }
    return NodeRuntime(path: node, version: String(version.dropFirst()))
  }

  /// Checks `archive` against both the hash this Desktop pins (`pinned`) and the line `sums`, a `SHASUMS256.txt`,
  /// lists for it.
  static func verify(archive: Data, sums: String, architecture: String, pinned: String?) throws {
    let name = archiveName(architecture: architecture)
    var listed: String?
    for line in sums.split(whereSeparator: \.isNewline) {
      let fields = line.split(separator: " ")
      if fields.count == 2, fields[1] == name { listed = String(fields[0]) }
    }
    guard let pinned, listed == pinned else {
      throw Failure.checksum("SHASUMS256.txt lists \(listed ?? "nothing") for \(name), not \(pinned ?? "a pinned hash")")
    }
    let actual = SHA256.hash(data: archive).map { String(format: "%02x", $0) }.joined()
    guard actual == pinned else { throw Failure.checksum("\(name) has SHA-256 \(actual), not \(pinned)") }
  }

  /// Downloads, verifies and unpacks this release into `root.runtime`, then removes other releases there that
  /// `keep` does not name.
  public static func install(_ root: EngineRoot, keep: [String] = []) async throws -> NodeRuntime {
    let architecture = architecture
    let base = URL(string: "https://nodejs.org/dist/\(version)/")!
    let sums = String(decoding: try await download(base.appendingPathComponent("SHASUMS256.txt")), as: UTF8.self)
    let archive = try await download(base.appendingPathComponent(archiveName(architecture: architecture)))
    try verify(archive: archive, sums: sums, architecture: architecture, pinned: archiveSHA256[architecture])
    let files = FileManager.default
    try files.createDirectory(atPath: root.runtime, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o755])
    let staging = "\(root.runtime)/.staging-\(UUID().uuidString)"
    try files.createDirectory(atPath: staging, withIntermediateDirectories: false)
    defer { try? files.removeItem(atPath: staging) }
    let tarball = "\(staging)/\(archiveName(architecture: architecture))"
    try archive.write(to: URL(fileURLWithPath: tarball))
    var request = ProcessRequest("/usr/bin/tar", ["-xJf", tarball, "-C", staging], timeout: 120)
    request.captureStderr = true
    let result = try await request.run()
    guard result.succeeded else { throw Failure.extract(stderrTail(result.stderrText)) }
    let target = directory(root, architecture: architecture)
    try? files.removeItem(atPath: target)
    try files.moveItem(atPath: "\(staging)/node-\(version)-darwin-\(architecture)", toPath: target)
    prune(root, keep: keep)
    guard let node = installed(root) else { throw Failure.extract("bin/node is missing") }
    return node
  }

  /// Removes the managed releases other than this one whose directory `keep` (paths of Nodes in use) does not name.
  public static func prune(_ root: EngineRoot, keep: [String]) {
    let current = directory(root)
    for name in (try? FileManager.default.contentsOfDirectory(atPath: root.runtime)) ?? []
    where name.hasPrefix("node-v") || name.hasPrefix(".staging-") {
      let path = "\(root.runtime)/\(name)"
      guard path != current, !keep.contains(where: { $0.hasPrefix(path + "/") }) else { continue }
      try? FileManager.default.removeItem(atPath: path)
    }
  }

  /// Removes the whole runtime directory when no Node in `keep` lies inside it.
  public static func remove(_ root: EngineRoot, keep: [String]) {
    guard !keep.contains(where: { $0.hasPrefix(root.runtime + "/") }) else { return }
    try? FileManager.default.removeItem(atPath: root.runtime)
  }

  private static func download(_ url: URL) async throws -> Data {
    var request = URLRequest(url: url)
    request.timeoutInterval = 60
    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await URLSession.shared.data(for: request)
    } catch {
      throw Failure.download(error.localizedDescription)
    }
    guard let status = (response as? HTTPURLResponse)?.statusCode, status == 200 else {
      throw Failure.download("\(url.lastPathComponent) answered \((response as? HTTPURLResponse)?.statusCode ?? 0)")
    }
    return data
  }
}

/// What Desktop does before it starts stimd, decided from the engine store and the version this Desktop build names.
public enum EngineNeed: Equatable, Sendable {
  case ready(EnginePointer)
  /// No engine: install `version` with the engine's own `engine install`.
  case install(version: String)
  /// The engine is older than this Desktop: `stim engine update`, at once when Desktop installed it, else on a click.
  case moveForward(EnginePointer, automatic: Bool)
  /// The engine is older and pinned; `text` names the pin and the remedy.
  case pinned(EnginePointer, text: String)
  /// A newer engine wrote a store this Desktop cannot read.
  case unreadable(String)

  /// `wanted` is the engine version this Desktop build names; a development build names none, accepts any engine and
  /// installs `next`.
  public static func decide(
    pointer: EngineRead<EnginePointer>, wanted: SemanticVersion?, installedByDesktop: Bool
  ) -> EngineNeed {
    switch pointer {
    case .unknownFormat(let text): return .unreadable(text)
    case .missing: return .install(version: wanted?.description ?? "next")
    case .unreadable:
      return .unreadable(
        "The Stim engine's current.json cannot be read. Run stim engine status in Terminal, then Try Again.")
    case .found(let engine):
      guard let wanted, let have = SemanticVersion(engine.version), have < wanted else { return .ready(engine) }
      // compat C7 permanent
      guard engine.pinned else { return .moveForward(engine, automatic: installedByDesktop) }
      let reason = engine.pinReason.map { " (\($0))" } ?? ""
      return .pinned(
        engine,
        text:
          "The Stim engine is pinned at \(engine.version)\(reason). This Stim Desktop needs \(wanted): run stim engine update, or Update Engine (clears the pin)."
      )
    // compat end
    }
  }
}

/// Which Node runs the engine install: the user's own when it is 22.12 or later, else the managed one, downloaded
/// first when it is missing.
public enum NodeChoice: Equatable, Sendable {
  case use(NodeRuntime)
  case download

  public static func decide(system: NodeRuntime?, managed: NodeRuntime?) -> NodeChoice {
    if let system, system.isSupported { return .use(system) }
    if let managed { return .use(managed) }
    return .download
  }
}

public enum EngineInstall {
  /// The engine version this Desktop build names in `StimEngineVersion`, or nil in a development build.
  public static var wanted: SemanticVersion? {
    (Bundle.main.object(forInfoDictionaryKey: "StimEngineVersion") as? String).flatMap(SemanticVersion.init)
  }

  /// `npx --yes stim@<version> engine install` with `node`'s directory first on `PATH`, which makes that copy the
  /// engine; `STIM_ENGINE_ROOT` passes through.
  public static func installRequest(version: String, node: NodeRuntime, environment: [String: String], home: String)
    -> ProcessRequest
  {
    var environment = environment
    let bin = (node.path as NSString).deletingLastPathComponent
    environment["PATH"] = "\(bin):\(environment["PATH"] ?? "/usr/bin:/bin")"
    var request = ProcessRequest(
      "\(bin)/npx", ["--yes", "stim@\(version)", "engine", "install"], cwd: home, environment: environment, timeout: 600)
    request.captureStderr = true
    return request
  }

  /// `stim engine update` through the installed engine, which also clears a pin.
  public static func updateRequest(_ root: EngineRoot, environment: [String: String], home: String) -> ProcessRequest {
    var request = ProcessRequest(root.stim, ["engine", "update"], cwd: home, environment: environment, timeout: 600)
    request.captureStderr = true
    return request
  }
}
