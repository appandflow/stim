import Darwin
import Foundation

/// The machine's Stim engine store, as `stim engine` resolves it: an absolute `STIM_ENGINE_ROOT`, else
/// `~/.stim/engine`. It ignores `STIM_HOME`; one engine serves every Stim home on the Mac.
public struct EngineRoot: Equatable, Sendable {
  public let path: String

  public init(environment: [String: String], home: String = NSHomeDirectory()) {
    let root = environment["STIM_ENGINE_ROOT"] ?? ""
    path = root.hasPrefix("/") ? root : "\(home)/.stim/engine"
  }

  public var stim: String { "\(path)/bin/stim" }
  public var stimd: String { "\(path)/bin/stimd" }
  public var pointer: String { "\(path)/current.json" }
  /// Where Desktop keeps the managed Node runtime, beside the store: `~/.stim/runtime` by default.
  public var runtime: String { "\((path as NSString).deletingLastPathComponent)/runtime" }
}

/// `current.json`: the build every routed copy of stim runs. Only the engine writes it.
public struct EnginePointer: Decodable, Equatable, Sendable {
  public struct Node: Decodable, Equatable, Sendable {
    public var path: String
    public var version: String
  }

  public var version: String
  public var build: String
  public var dir: String
  public var node: [Node]
  public var channel: String
  public var pinned: Bool
  public var pinReason: String?
  public var setBy: String
}

/// `run/stimd.json`: the stimd running for a Stim home and the socket it serves. stimd writes it after binding the
/// socket and removes it on exit.
public struct StimdRecord: Decodable, Equatable, Sendable {
  public var pid: Int32
  public var socket: String
  public var build: String
  public var version: String
}

/// A read of an engine file Desktop parses itself.
public enum EngineRead<Value: Equatable & Sendable>: Equatable, Sendable {
  case missing
  case unreadable
  /// A newer engine wrote a format this Desktop does not know.
  case unknownFormat(String)
  case found(Value)

  public var value: Value? {
    if case .found(let value) = self { return value }
    return nil
  }
}

private struct FormatHeader: Decodable { var format: Int? }

public enum EngineFiles {
  // compat C8 permanent
  static let format = 1

  /// `path` decoded when its `format` is the one this Desktop reads; a file with another `format` is refused with
  /// `unknownFormatText`, never guessed at.
  public static func read<Value: Decodable & Equatable & Sendable>(_: Value.Type, at path: String) -> EngineRead<Value> {
    guard let data = FileManager.default.contents(atPath: path) else { return .missing }
    guard let header = try? JSONDecoder().decode(FormatHeader.self, from: data) else { return .unreadable }
    guard header.format == format else { return .unknownFormat(unknownFormatText(path, format: header.format)) }
    return (try? JSONDecoder().decode(Value.self, from: data)).map(EngineRead.found) ?? .unreadable
  }

  public static func unknownFormatText(_ path: String, format: Int?) -> String {
    "\(abbreviatingHome(path)) has format \(format.map(String.init) ?? "none"), which this Stim Desktop cannot read. "
      + "Partial report: update Stim Desktop (Stim > Check for Updates)."
  }
  // compat end

  public static func runDirectory(stimHome: String) -> String { "\(stimHome)/run" }

  public static func stimd(stimHome: String) -> EngineRead<StimdRecord> {
    read(StimdRecord.self, at: "\(runDirectory(stimHome: stimHome))/stimd.json")
  }

  public static func pointer(_ root: EngineRoot) -> EngineRead<EnginePointer> {
    read(EnginePointer.self, at: root.pointer)
  }

  /// Whether `record` names a process that still runs. stimd removes its record on exit, so a record whose process is
  /// gone was left by a crash.
  public static func isAlive(_ record: StimdRecord) -> Bool {
    record.pid > 0 && (kill(record.pid, 0) == 0 || errno == EPERM)
  }
}

/// How Desktop runs this Mac's Stim: the engine's `bin/stim` and `bin/stimd`, or, for development, a built `stim`
/// package directory named by the `stimEngine` preference, run with the first `node` on `PATH`.
public struct EngineLaunch: Equatable, Sendable {
  public var program: String
  public var prefix: [String]
  public var isDevelopment: Bool

  public static func installed(_ root: EngineRoot) -> EngineLaunch {
    EngineLaunch(program: root.stim, prefix: [], isDevelopment: false)
  }

  /// `package/bin/stim.mjs` under `node`; `stim serve` runs stimd in its own process.
  public static func development(package: String, node: String) -> EngineLaunch {
    EngineLaunch(program: node, prefix: ["\(package)/bin/stim.mjs"], isDevelopment: true)
  }

  public static func resolve(
    environment: [String: String], defaults: UserDefaults = .standard, home: String = NSHomeDirectory()
  ) -> EngineLaunch? {
    if let package = defaults.string(forKey: AppPreferences.Key.stimEngine), package.hasPrefix("/") {
      var environment = environment
      return resolveExecutable("node", override: nil, environment: &environment).map {
        development(package: package, node: $0)
      }
    }
    let root = EngineRoot(environment: environment, home: home)
    guard FileManager.default.isExecutableFile(atPath: root.stim) else { return nil }
    return installed(root)
  }

  public func stim(_ arguments: [String]) -> (program: String, arguments: [String]) {
    (program, prefix + arguments)
  }

  /// stimd: the engine's `bin/stimd`, or `stim serve` of a development package.
  public func stimd(_ root: EngineRoot) -> (program: String, arguments: [String]) {
    isDevelopment ? (program, prefix + ["serve"]) : (root.stimd, [])
  }
}
