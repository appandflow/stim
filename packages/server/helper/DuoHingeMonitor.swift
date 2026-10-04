import Darwin
import Foundation

enum DuoHingeMonitor {
  static func run(udid: String) -> Never {
    let parent = getppid()
    guard parent > 1 else { exit(1) }
    let queue = DispatchQueue(label: "stim.frames.hinge-monitor")
    var child: pid_t = 0
    var stopping = false
    let stop = {
      guard !stopping else { return }
      stopping = true
      guard child > 0 else { exit(0) }
      kill(child, SIGINT)
      queue.asyncAfter(deadline: .now() + 1) {
        if child > 0 { kill(child, SIGKILL) }
      }
    }
    let parentExit = DispatchSource.makeProcessSource(identifier: parent, eventMask: .exit, queue: queue)
    parentExit.setEventHandler(handler: stop)
    parentExit.resume()
    let reap = DispatchSource.makeTimerSource(queue: queue)
    reap.schedule(deadline: .now(), repeating: .milliseconds(100))
    reap.setEventHandler {
      guard child > 0 else { return }
      var status: Int32 = 0
      if waitpid(child, &status, WNOHANG) == child {
        child = 0
        exit(0)
      }
    }
    reap.resume()
    var signals: [DispatchSourceSignal] = []
    for value in [SIGTERM, SIGINT] {
      signal(value, SIG_IGN)
      let source = DispatchSource.makeSignalSource(signal: value, queue: queue)
      source.setEventHandler(handler: stop)
      source.resume()
      signals.append(source)
    }
    Thread.detachNewThread {
      _ = FileHandle.standardInput.readDataToEndOfFile()
      queue.async(execute: stop)
    }
    queue.asyncAfter(deadline: .now() + 60, execute: stop)
    queue.async {
      guard !stopping, getppid() == parent else { return stop() }
      let arguments = [
        "/usr/bin/xcrun", "devicectl", "device", "motion", "hinge-angle", "--device", udid,
        "--session-timeout", "55", "--timeout", "60", "--change-threshold", "1", "--update-interval", "0.5",
      ]
      var environment = ProcessInfo.processInfo.environment
      environment["DEVELOPER_DIR"] = CoreSimulator.developerDir
      environment["LC_ALL"] = "en_US.UTF-8"
      let argv = arguments.map { strdup($0) } + [nil]
      let env = environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
      defer {
        for pointer in argv + env { free(pointer) }
      }
      var actions: posix_spawn_file_actions_t?
      guard posix_spawn_file_actions_init(&actions) == 0 else { exit(1) }
      defer { posix_spawn_file_actions_destroy(&actions) }
      guard posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0) == 0,
        posix_spawn_file_actions_addopen(&actions, STDERR_FILENO, "/dev/null", O_WRONLY, 0) == 0
      else { exit(1) }
      var attributes: posix_spawnattr_t?
      guard posix_spawnattr_init(&attributes) == 0 else { exit(1) }
      defer { posix_spawnattr_destroy(&attributes) }
      var defaults = sigset_t()
      sigemptyset(&defaults)
      sigaddset(&defaults, SIGINT)
      sigaddset(&defaults, SIGTERM)
      var mask = sigset_t()
      sigemptyset(&mask)
      guard posix_spawnattr_setsigdefault(&attributes, &defaults) == 0,
        posix_spawnattr_setsigmask(&attributes, &mask) == 0,
        posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK)) == 0
      else { exit(1) }
      let result = argv.withUnsafeBufferPointer { argv in
        env.withUnsafeBufferPointer { env in
          posix_spawn(&child, "/usr/bin/xcrun", &actions, &attributes, argv.baseAddress!, env.baseAddress!)
        }
      }
      guard result == 0 else { exit(1) }
    }
    withExtendedLifetime((parentExit, reap, signals)) { dispatchMain() }
  }
}
