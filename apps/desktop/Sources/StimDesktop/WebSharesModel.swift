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
  /// Whether the server's `share.stop` takes a share `id`. A server that predates it ignores `id` and ends every share of the workspace.
  private(set) var stopsOneShare = false
  @ObservationIgnored private var latestRefresh = 0
  private let request: @MainActor (String, [String: JSONValue]) async throws -> JSONValue
  private let serverStopsOneShare: @MainActor () -> Bool
  private let serverOffersViewPassword: @MainActor () -> Bool
  private let toasts: ToastCenter

  init(
    toasts: ToastCenter? = nil,
    request: @escaping @MainActor (String, [String: JSONValue]) async throws -> JSONValue = BuildMachinesModel.localRequest,
    serverStopsOneShare: @escaping @MainActor () -> Bool = WebSharesModel.localServerStopsOneShare,
    serverOffersViewPassword: @escaping @MainActor () -> Bool = WebSharesModel.localServerOffersViewPassword
  ) {
    self.toasts = toasts ?? .shared
    self.request = request
    self.serverStopsOneShare = serverStopsOneShare
    self.serverOffersViewPassword = serverOffersViewPassword
  }

  /// Whether the local server's `share.start` takes `view`; an older one refuses the parameter, so the sheet does not offer it.
  var offersViewPassword: Bool { serverOffersViewPassword() }

  static func localServerOffersViewPassword() -> Bool {
    guard let client = ServerSession.shared.client, case .open(let hello) = client.state else { return false }
    return hello.desktopApi == ServerProtocol.desktopApi
  }

  static func localServerStopsOneShare() -> Bool {
    guard let client = ServerSession.shared.client, case .open(let hello) = client.state else { return false }
    return hello.desktopApi == ServerProtocol.desktopApi
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
    stopsOneShare = serverStopsOneShare()
  }

  func start(workspace: String, platform: String, slot: String, options: WebShareOptions) async throws -> StartedWebShare {
    let result = try await request("share.start", options.params(workspace: workspace, platform: platform, slot: slot))
    let started = try decodeReporting(StartedWebShare.self, from: result, source: .server)
    await refresh()
    return started
  }

  /// Ends one share, or every share of its workspace on a server whose `share.stop` ignores `id`.
  func stop(share: WebShare) async {
    guard serverStopsOneShare() else { return await stop(workspace: share.workspace) }
    await stop(key: share.id, params: ["workspace": .string(share.workspace), "id": .string(share.id)])
  }

  /// `share.stop` without an `id` ends every share of a workspace.
  func stop(workspace: String) async {
    await stop(key: workspace, params: ["workspace": .string(workspace)])
  }

  private func stop(key: String, params: [String: JSONValue]) async {
    guard stopping.insert(key).inserted else { return }
    defer { stopping.remove(key) }
    do {
      _ = try await request("share.stop", params)
      await refresh()
    } catch {
      toasts.show(
        Toast(
          icon: "exclamationmark.triangle", tone: .error, title: "Could not stop the web share", body: error.localizedDescription)
      )
    }
  }

  private func list() async throws -> [WebShare] {
    let result = try await request("share.list", [:])
    return try decodeReporting(WebSharesPayload.self, from: result, source: .server).shares
  }
}
