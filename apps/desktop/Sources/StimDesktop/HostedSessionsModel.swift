import Foundation
import Observation
import StimKit

@MainActor @Observable
final class HostedSessionsModel {
  private(set) var sessions: [HostedSession]?
  private(set) var stopping: Set<String> = []
  @ObservationIgnored private var latestRefresh = 0
  private let request: @MainActor (String, [String: JSONValue]) async throws -> JSONValue
  private let toasts: ToastCenter

  init(
    toasts: ToastCenter? = nil,
    request: @escaping @MainActor (String, [String: JSONValue]) async throws -> JSONValue = BuildMachinesModel.localRequest
  ) {
    self.toasts = toasts ?? .shared
    self.request = request
  }

  func refresh() async {
    latestRefresh += 1
    let run = latestRefresh
    let rows: [HostedSession]?
    do {
      let result = try await request("device-host.sessions", [:])
      rows = try decodeReporting(HostedSessionsPayload.self, from: result, source: .server).sessions
    } catch let error as ServerError where error.code == "unknown-method" {
      rows = nil
    } catch {
      return
    }
    guard run == latestRefresh, !Task.isCancelled else { return }
    sessions = rows
  }

  func stop(_ session: HostedSession) async {
    guard !session.parked, session.state != .stopped, session.state != .stopping,
      stopping.insert(session.id).inserted
    else { return }
    defer { stopping.remove(session.id) }
    do {
      _ = try await request("device-host.sessions.stop", ["session": .string(session.id)])
      await refresh()
    } catch {
      toasts.show(
        Toast(
          icon: "exclamationmark.triangle", tone: .error, title: "Could not stop \(session.client.name)'s session",
          body: error.localizedDescription))
    }
  }
}
