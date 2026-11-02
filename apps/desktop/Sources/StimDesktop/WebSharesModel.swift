import Foundation
import Observation
import StimKit

/// The web shares of Desktop's local stim-server, over `share.list`, `share.start` and `share.stop`. A started
/// share's link and password go to the caller and are never kept here.
@MainActor @Observable
final class WebSharesModel {
  static let shared = WebSharesModel()

  private(set) var shares: [WebShare]?
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

  /// A server that does not serve shares leaves `shares` nil.
  func refresh() async {
    latestRefresh += 1
    let run = latestRefresh
    let rows: [WebShare]?
    do {
      rows = try await list()
    } catch let error as ServerError where error.code == "unknown-method" {
      rows = nil
    } catch {
      return
    }
    guard run == latestRefresh, !Task.isCancelled else { return }
    shares = rows
  }

  func start(workspace: String, platform: String, slot: String, options: WebShareOptions) async throws -> StartedWebShare {
    let result = try await request("share.start", options.params(workspace: workspace, platform: platform, slot: slot))
    let started = try decodeReporting(StartedWebShare.self, from: result, source: .server)
    await refresh()
    return started
  }

  /// `share.stop` ends every share of a workspace, so the row it stops names the workspace.
  func stop(workspace: String) async {
    guard stopping.insert(workspace).inserted else { return }
    defer { stopping.remove(workspace) }
    do {
      _ = try await request("share.stop", ["workspace": .string(workspace)])
      await refresh()
    } catch {
      toasts.show(
        Toast(
          icon: "exclamationmark.triangle", tone: .error, title: "Could not stop the web share", body: error.localizedDescription)
      )
    }
  }

  /// The shares live now, or none when the server does not answer within `timeout`: a quit never waits on a dead server.
  func liveShares(within timeout: Duration) async -> [WebShare] {
    await withTaskGroup(of: [WebShare]?.self) { group in
      group.addTask { @MainActor in try? await self.list() }
      group.addTask {
        try? await Task.sleep(for: timeout)
        return nil
      }
      let first = await group.next() ?? nil
      group.cancelAll()
      return first ?? []
    }
  }

  private func list() async throws -> [WebShare] {
    let result = try await request("share.list", [:])
    return try decodeReporting(WebSharesPayload.self, from: result, source: .server).shares
  }
}
