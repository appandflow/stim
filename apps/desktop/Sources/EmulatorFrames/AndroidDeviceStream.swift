import CryptoKit
import CoreVideo
import Foundation

/// Streams a physical Android device's screen and injects input through the scrcpy server, over adb only:
/// the jar is pushed to `/data/local/tmp` under a per-session name, started with `app_process` as the shell
/// user, and reached through an `adb forward` port. The server's cleanup process deletes the jar once it runs,
/// and `stop` removes the forward and the jar again, so nothing stays on the device. It installs nothing and
/// changes no setting.
final class AndroidDeviceStream {
  struct Failure: Error, CustomStringConvertible {
    let description: String
  }

  private let serial: String
  private let adb: String
  private let serverJar: URL
  private let scid = String(format: "%08x", UInt32.random(in: 0..<0x8000_0000))
  private let lock = NSLock()
  private var stopped = false
  private let cleaned = DispatchGroup()
  private var setupStep: Process?
  private var shell: Process?
  private var pushed = false
  private var shellOutput = ""
  private var videoSocket: Int32 = -1
  private var controlSocket: Int32 = -1
  private let writes = DispatchQueue(label: "stim.android-device.control")
  private lazy var decoder = H264Decoder { [weak self] image in self?.onFrame(image) }

  private var frameSize: (width: Int, height: Int)?
  var onFrame: (CVPixelBuffer) -> Void = { _ in }
  var onEnd: (String) -> Void = { _ in }

  /// The size of the video frames the server sends now; touches are in these pixels.
  var size: (width: Int, height: Int)? { lock.withLock { frameSize } }

  private var remoteJar: String { "/data/local/tmp/stim-scrcpy-\(scid).jar" }

  init(serial: String, adb: String, serverJar: URL) {
    self.serial = serial
    self.adb = adb
    self.serverJar = serverJar
  }

  func start() {
    Thread.detachNewThread { [self] in
      do {
        try open()
      } catch {
        end((error as? Failure)?.description ?? "\(error)")
        return
      }
      Thread.detachNewThread { [self] in drainControl() }
      readVideo()
    }
  }

  func send(_ message: Data) {
    writes.async { [self] in
      let socket = lock.withLock { controlSocket }
      guard socket >= 0 else { return }
      _ = message.withUnsafeBytes { write(socket, $0.baseAddress, $0.count) }
    }
  }

  /// Ends the stream and removes what it left on the device and in adb. Blocks until adb answered, also when
  /// another thread already started it, so it can run right before the process exits.
  func stop() {
    let first = lock.withLock { () -> Bool in
      if stopped { return false }
      stopped = true
      cleaned.enter()
      return true
    }
    guard first else {
      cleaned.wait()
      return
    }
    defer { cleaned.leave() }
    let (step, shell, pushed, sockets) = lock.withLock { () -> (Process?, Process?, Bool, [Int32]) in
      let sockets = [videoSocket, controlSocket]
      videoSocket = -1
      controlSocket = -1
      return (setupStep, self.shell, self.pushed, sockets)
    }
    for socket in sockets where socket >= 0 {
      shutdown(socket, SHUT_RDWR)
      close(socket)
    }
    if let shell, shell.isRunning { shell.terminate() }
    if let step, step.isRunning {
      step.terminate()
      step.waitUntilExit()
    }
    guard pushed else { return }
    let forwards = (try? run(["forward", "--list"], timeout: 2)) ?? ""
    for line in forwards.split(separator: "\n") where line.hasSuffix(" localabstract:scrcpy_\(scid)") {
      let fields = line.split(separator: " ")
      if fields.count == 3 { _ = try? run(["forward", "--remove", String(fields[1])], timeout: 2) }
    }
    _ = try? run(["shell", "rm", "-f", remoteJar], timeout: 2)
  }

  private var isStopped: Bool { lock.withLock { stopped } }
  private let stoppedFailure = Failure(description: "The stream was stopped.")

  private func end(_ message: String) {
    guard !isStopped else { return }
    stop()
    onEnd(message)
  }

  private func open() throws {
    let jar = try Data(contentsOf: serverJar)
    let digest = SHA256.hash(data: jar).map { String(format: "%02x", $0) }.joined()
    guard digest == Scrcpy.serverSha256 else {
      throw Failure(description: "\(serverJar.path) is not scrcpy-server \(Scrcpy.version) (sha256 \(digest)); it was not pushed.")
    }
    let pushing = lock.withLock { () -> Bool in
      if !stopped { pushed = true }
      return pushed
    }
    guard pushing else { throw stoppedFailure }
    try run(["push", serverJar.path, remoteJar], timeout: 30, setup: true)
    let shell = adbProcess(
      ["shell", "CLASSPATH=\(remoteJar)", "app_process", "/", "com.genymobile.scrcpy.Server"]
        + Scrcpy.serverArguments(scid: scid))
    let output = Pipe()
    shell.standardOutput = output
    shell.standardError = output
    shell.standardInput = FileHandle.nullDevice
    output.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let text = String(decoding: handle.availableData, as: UTF8.self)
      if text.isEmpty { handle.readabilityHandler = nil }
      guard let self, !text.isEmpty else { return }
      self.lock.withLock { self.shellOutput = String((self.shellOutput + text).suffix(1000)) }
    }
    try lock.withLock {
      guard !stopped else { throw stoppedFailure }
      try shell.run()
      self.shell = shell
    }
    let forwarded = try run(["forward", "tcp:0", "localabstract:scrcpy_\(scid)"], timeout: 10, setup: true)
    guard let port = Int(forwarded.trimmingCharacters(in: .whitespacesAndNewlines)) else {
      throw Failure(description: "adb forward printed no port: \(forwarded.prefix(200))")
    }
    let video = try connect(port: port, dummyByte: true)
    let control = try connect(port: port, dummyByte: false)
    let connected = lock.withLock { () -> Bool in
      guard !stopped else { return false }
      videoSocket = video
      controlSocket = control
      return true
    }
    if !connected {
      close(video)
      close(control)
      throw stoppedFailure
    }
  }

  /// The forward accepts a connection even before the server listens, then closes it; the server's dummy
  /// byte on the first socket shows it is the server that answered.
  private func connect(port: Int, dummyByte: Bool) throws -> Int32 {
    for _ in 0..<100 {
      guard !isStopped else { break }
      if let shell = lock.withLock({ self.shell }), !shell.isRunning { break }
      let socket = Darwin.socket(AF_INET, SOCK_STREAM, 0)
      var address = sockaddr_in()
      address.sin_family = sa_family_t(AF_INET)
      address.sin_port = in_port_t(UInt16(port).bigEndian)
      address.sin_addr.s_addr = inet_addr("127.0.0.1")
      let connected = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
          Darwin.connect(socket, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
        }
      }
      var byte: UInt8 = 0
      if connected == 0, !dummyByte || read(socket, &byte, 1) == 1 { return socket }
      close(socket)
      usleep(100_000)
    }
    let output = lock.withLock { shellOutput }.trimmingCharacters(in: .whitespacesAndNewlines)
    throw Failure(description: "The scrcpy server on \(serial) did not accept a connection\(output.isEmpty ? "." : ": \(output)")")
  }

  private func readVideo() {
    var demuxer = ScrcpyVideoDemuxer()
    var chunk = [UInt8](repeating: 0, count: 1 << 16)
    while true {
      let socket = lock.withLock { videoSocket }
      guard socket >= 0 else { return }
      let count = read(socket, &chunk, chunk.count)
      guard count > 0 else { break }
      do {
        for event in try demuxer.push(Data(chunk[0..<count])) {
          switch event {
          case .codec(let codec):
            guard codec == ScrcpyVideoDemuxer.h264 else { return end("The scrcpy server did not stream H.264.") }
          case .session(let width, let height):
            lock.withLock { frameSize = (width, height) }
          case .packet(let config, _, let data):
            if config {
              if !decoder.configure(data) { return end("The device's H.264 parameter sets could not be decoded.") }
            } else {
              decoder.decode(data)
            }
          }
        }
      } catch {
        return end("\(error)")
      }
    }
    let output = lock.withLock { shellOutput }.trimmingCharacters(in: .whitespacesAndNewlines)
    end("\(serial) ended its screen stream\(output.isEmpty ? "." : ": \(output)")")
  }

  /// Device messages (clipboard, acknowledgements) are not used, but must be read so the server never blocks.
  private func drainControl() {
    var chunk = [UInt8](repeating: 0, count: 4096)
    while true {
      let socket = lock.withLock { controlSocket }
      guard socket >= 0, read(socket, &chunk, chunk.count) > 0 else { return }
    }
  }

  private func adbProcess(_ arguments: [String]) -> Process {
    let process = Process()
    let lookup = !adb.contains("/")
    process.executableURL = URL(fileURLWithPath: lookup ? "/usr/bin/env" : adb)
    process.arguments = (lookup ? [adb] : []) + ["-s", serial] + arguments
    return process
  }

  /// A `setup` step is one `stop` kills and waits for before it cleans up, so a push or forward it overtakes
  /// cannot land after the cleanup.
  @discardableResult
  private func run(_ arguments: [String], timeout: TimeInterval, setup: Bool = false) throws -> String {
    let process = adbProcess(arguments)
    let output = Pipe()
    process.standardOutput = output
    process.standardError = output
    process.standardInput = FileHandle.nullDevice
    let done = DispatchSemaphore(value: 0)
    process.terminationHandler = { _ in done.signal() }
    do {
      try lock.withLock {
        if setup {
          guard !stopped else { throw stoppedFailure }
          setupStep = process
        }
        try process.run()
      }
    } catch let failure as Failure {
      throw failure
    } catch {
      throw Failure(description: "adb could not start (\(error.localizedDescription)).")
    }
    defer { if setup { lock.withLock { setupStep = nil } } }
    let read = DispatchGroup()
    var data = Data()
    read.enter()
    DispatchQueue.global().async {
      data = output.fileHandleForReading.readDataToEndOfFile()
      read.leave()
    }
    if done.wait(timeout: .now() + timeout) == .timedOut {
      process.terminate()
      throw Failure(description: "adb \(arguments.first ?? "") on \(serial) did not finish within \(Int(timeout)) s.")
    }
    read.wait()
    let text = String(decoding: data, as: UTF8.self)
    guard process.terminationStatus == 0 else {
      throw Failure(description: "adb \(arguments.prefix(2).joined(separator: " ")) on \(serial) failed: \(text.trimmingCharacters(in: .whitespacesAndNewlines))")
    }
    return text
  }
}
