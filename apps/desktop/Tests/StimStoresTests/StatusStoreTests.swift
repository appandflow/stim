import Foundation
import StimKit
import Testing

@testable import StimStores

private func payload(live: Int) -> StatusPayload {
  let json = #"{"environments":[],"capacity":{"liveCount":\#(live),"committedMb":0,"totalMemoryMb":0,"overCapacity":false}}"#
  return try! JSONDecoder().decode(StatusPayload.self, from: Data(json.utf8))
}

@MainActor
private func makeStore(_ fetches: Scripted<StatusPayload>) -> StatusStore {
  let cli = Task { StimCLI(environment: ["PATH": "/nonexistent"]) }
  return StatusStore(cli: cli, fetch: { try await fetches.call() })
}

@MainActor
struct StatusStoreTests {
  @Test func aRefreshThatFinishesAfterANewerWatchPayloadDoesNotReplaceIt() async {
    let fetches = Scripted<StatusPayload>()
    let store = makeStore(fetches)
    store.refresh()
    #expect(await until { fetches.calls == 1 })

    store.accept(.success(payload(live: 2)))
    #expect(await until { store.payload?.capacity?.liveCount == 2 })

    fetches.finish(0, .success(payload(live: 1)))
    await settle()
    #expect(store.payload?.capacity?.liveCount == 2)
  }

  @Test func aFailureOlderThanTheShownPayloadIsNotReported() async {
    let fetches = Scripted<StatusPayload>()
    let store = makeStore(fetches)
    store.refresh()
    #expect(await until { fetches.calls == 1 })
    store.accept(.success(payload(live: 2)))
    #expect(await until { store.payload != nil })

    fetches.finish(0, .failure(Failed()))
    await settle()
    #expect(store.error == nil)
    #expect(store.payload?.capacity?.liveCount == 2)
  }

  @Test func requestsDuringARefreshRunOneMoreAfterItAndNoMore() async {
    let fetches = Scripted<StatusPayload>()
    let store = makeStore(fetches)
    store.refresh()
    #expect(await until { fetches.calls == 1 })
    store.refresh()
    store.refresh()
    await settle()
    #expect(fetches.calls == 1)

    fetches.finish(0, .success(payload(live: 1)))
    #expect(await until { fetches.calls == 2 })
    fetches.finish(1, .success(payload(live: 5)))
    #expect(await until { store.payload?.capacity?.liveCount == 5 })
    await settle()
    #expect(fetches.calls == 2)

    store.refresh()
    #expect(await until { fetches.calls == 3 })
  }

  @Test func aFailedRefreshKeepsThePayloadAndReportsTheErrorUntilTheNextSuccess() async {
    let fetches = Scripted<StatusPayload>()
    let store = makeStore(fetches)
    store.refresh()
    #expect(await until { fetches.calls == 1 })
    fetches.finish(0, .success(payload(live: 1)))
    #expect(await until { store.payload != nil })

    store.refresh()
    #expect(await until { fetches.calls == 2 })
    fetches.finish(1, .failure(Failed()))
    #expect(await until { store.error == "scripted failure" })
    #expect(store.payload?.capacity?.liveCount == 1)

    store.refresh()
    #expect(await until { fetches.calls == 3 })
    fetches.finish(2, .success(payload(live: 2)))
    #expect(await until { store.payload?.capacity?.liveCount == 2 })
    #expect(store.error == nil)
  }

  private func watchingCLI(in directory: URL) throws -> StimCLI {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let executable = directory.appendingPathComponent("stim")
    let script = """
      #!/bin/sh
      [ "$1" = status ] || exit 0
      echo $$ >> "$STIM_HOME/watchers"
      echo '{"environments":[]}'
      exec sleep 60
      """
    try Data(script.utf8).write(to: executable)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
    return StimCLI(environment: ["PATH": "/usr/bin:/bin", "STIM_HOME": directory.path], override: executable.path)
  }

  private func watcherPIDs(in directory: URL) -> [Int32] {
    let text = (try? String(contentsOf: directory.appendingPathComponent("watchers"), encoding: .utf8)) ?? ""
    return text.split(separator: "\n").compactMap { Int32($0) }
  }

  @Test func theStoreRunsNoWatcherOfItsOwnWhileTheServerDeliversStatusAndRunsOneAgainWhenItStops() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("watch-\(UUID().uuidString)")
    let cli = try watchingCLI(in: directory)
    let store = StatusStore(cli: Task { cli }, fetch: { throw Failed() })
    defer {
      store.serverDelivering(true)
      for pid in watcherPIDs(in: directory) { kill(pid, SIGKILL) }
      try? FileManager.default.removeItem(at: directory)
    }
    store.start()
    #expect(await until { watcherPIDs(in: directory).count == 1 && store.watching })
    let first = try #require(watcherPIDs(in: directory).first)

    store.serverDelivering(true)
    #expect(store.watching)
    #expect(await until { kill(first, 0) != 0 })
    try await Task.sleep(nanoseconds: 1_500_000_000)
    #expect(watcherPIDs(in: directory).count == 1)
    #expect(store.watching && store.error == nil)

    store.serverDelivering(false)
    #expect(await until { watcherPIDs(in: directory).count == 2 && store.watching })
  }
}
