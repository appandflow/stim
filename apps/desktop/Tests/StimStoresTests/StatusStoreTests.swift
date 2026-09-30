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
  /// Catches a slow `stim status` run finishing after the live watch delivered a newer payload, and putting the
  /// older one back on screen.
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

  /// Catches an error from an old run replacing a payload that is already newer.
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

  /// Catches the view staying stale after a request made while a refresh ran, such as one after an action ended.
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

  /// Catches a failed run discarding the last payload or leaving its error on screen after a success.
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
}
