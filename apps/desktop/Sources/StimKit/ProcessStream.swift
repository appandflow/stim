import Foundation

public enum OutputChannel: Sendable {
  case stdout
  case stderr
}

public struct OutputLine: Hashable, Sendable {
  public var channel: OutputChannel
  public var text: String

  public init(_ channel: OutputChannel, _ text: String) {
    self.channel = channel
    self.text = text
  }
}

/// Splits a byte stream into lines. A chunk can end inside a line or inside a
/// UTF-8 sequence, so bytes after the last newline wait for the next chunk.
public struct LineBuffer: Sendable {
  private var pending = Data()

  public init() {}

  public mutating func append(_ data: Data) -> [String] {
    pending.append(data)
    guard let last = pending.lastIndex(of: UInt8(ascii: "\n")) else { return [] }
    let complete = pending[pending.startIndex..<last]
    pending = Data(pending[(last + 1)...])
    return complete.split(separator: UInt8(ascii: "\n"), omittingEmptySubsequences: false).map(Self.decode)
  }

  public mutating func finish() -> [String] {
    defer { pending = Data() }
    return pending.isEmpty ? [] : [Self.decode(pending)]
  }

  private static func decode<Bytes: Collection<UInt8>>(_ bytes: Bytes) -> String {
    var text = String(decoding: bytes, as: UTF8.self)
    if text.hasSuffix("\r") { text.removeLast() }
    return text
  }
}

/// Runs an executable with an argument list, never through a shell, and
/// reports its output line by line and then its exit status.
public enum ProcessStream {
  /// A child the command leaves running can hold the pipes open, so the exit
  /// is reported this long after termination even without end of file.
  static let drainGrace: TimeInterval = 2

  @discardableResult
  public static func start(
    executable: String,
    arguments: [String],
    cwd: String,
    environment: [String: String]? = nil,
    onLine: @escaping @Sendable (OutputLine) -> Void,
    onExit: @escaping @Sendable (Int32) -> Void
  ) throws -> Process {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.currentDirectoryURL = URL(fileURLWithPath: cwd)
    if let environment { process.environment = environment }
    process.standardInput = FileHandle.nullDevice
    let out = Pipe()
    let err = Pipe()
    process.standardOutput = out
    process.standardError = err

    let state = StreamState(onLine: onLine, onExit: onExit)
    for (pipe, channel) in [(out, OutputChannel.stdout), (err, .stderr)] {
      pipe.fileHandleForReading.readabilityHandler = { handle in
        let data = handle.availableData
        if data.isEmpty {
          handle.readabilityHandler = nil
          state.close(channel)
        } else {
          state.receive(data, on: channel)
        }
      }
    }
    process.terminationHandler = { process in
      let status = process.terminationStatus
      state.terminated(status)
      DispatchQueue.global().asyncAfter(deadline: .now() + drainGrace) {
        out.fileHandleForReading.readabilityHandler = nil
        err.fileHandleForReading.readabilityHandler = nil
        state.close(.stdout)
        state.close(.stderr)
      }
    }
    do {
      try process.run()
    } catch {
      out.fileHandleForReading.readabilityHandler = nil
      err.fileHandleForReading.readabilityHandler = nil
      throw error
    }
    return process
  }
}

private final class StreamState: @unchecked Sendable {
  private let lock = NSLock()
  private var buffers: [OutputChannel: LineBuffer] = [.stdout: LineBuffer(), .stderr: LineBuffer()]
  private var open: Set<OutputChannel> = [.stdout, .stderr]
  private var status: Int32?
  private var reported = false
  private let onLine: @Sendable (OutputLine) -> Void
  private let onExit: @Sendable (Int32) -> Void

  init(onLine: @escaping @Sendable (OutputLine) -> Void, onExit: @escaping @Sendable (Int32) -> Void) {
    self.onLine = onLine
    self.onExit = onExit
  }

  func receive(_ data: Data, on channel: OutputChannel) {
    lock.lock()
    defer { lock.unlock() }
    guard open.contains(channel) else { return }
    for line in buffers[channel]!.append(data) { onLine(OutputLine(channel, line)) }
  }

  func close(_ channel: OutputChannel) {
    lock.lock()
    defer { lock.unlock() }
    guard open.remove(channel) != nil else { return }
    for line in buffers[channel]!.finish() { onLine(OutputLine(channel, line)) }
    reportIfDone()
  }

  func terminated(_ status: Int32) {
    lock.lock()
    defer { lock.unlock() }
    self.status = status
    reportIfDone()
  }

  private func reportIfDone() {
    guard !reported, open.isEmpty, let status else { return }
    reported = true
    onExit(status)
  }
}
