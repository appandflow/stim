import Foundation

public struct DevToolsError: Error, CustomStringConvertible {
  public let description: String

  public init(_ description: String) {
    self.description = description
  }
}

/// One JSON message of the DevTools protocol: the reply to a command, or an event.
enum DevToolsMessage {
  case reply(id: Int, Result<[String: Any], DevToolsError>)
  case event(DevToolsClient.Event)

  /// Nil when `data` is not a JSON object with an `id` or a `method`. A message with an `id` is a reply.
  init?(_ data: Data) {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    if let id = object["id"] as? Int {
      if let error = object["error"] as? [String: Any] {
        self = .reply(id: id, .failure(DevToolsError(error["message"] as? String ?? "DevTools command failed.")))
      } else {
        self = .reply(id: id, .success(object["result"] as? [String: Any] ?? [:]))
      }
    } else if let method = object["method"] as? String {
      self = .event((method, object["params"] as? [String: Any] ?? [:], object["sessionId"] as? String))
    } else {
      return nil
    }
  }
}

/// A Chrome DevTools Protocol connection to the browser endpoint of a Chrome Stim owns. `connect` refuses an
/// endpoint whose browser process is not `chromePid`, the pid `stim status` reports, the same rule the CLI's
/// `connectOwnedBrowser` applies: the loopback port alone does not prove which Chrome answers it.
public final class DevToolsClient: @unchecked Sendable {
  public typealias Event = (method: String, params: [String: Any], sessionId: String?)

  private let task: URLSessionWebSocketTask
  private let session: URLSession
  private let queue = DispatchQueue(label: "stim.web.devtools")
  private var pending: [Int: (Result<[String: Any], DevToolsError>) -> Void] = [:]
  private var nextId = 1
  private var closed = false
  private var eventHandler: ((Event) -> Void)?
  private var closeHandlers: [() -> Void] = []

  private init(url: URL) {
    session = URLSession(configuration: .ephemeral)
    task = session.webSocketTask(with: url)
    task.maximumMessageSize = 64 << 20
  }

  /// `endpoint` is `web.cdpEndpoint` from `stim status`, `http://127.0.0.1:<port>`.
  public static func connect(
    endpoint: URL, chromePid: Int32, completion: @escaping (Result<DevToolsClient, DevToolsError>) -> Void
  ) {
    guard endpoint.host == "127.0.0.1", let port = endpoint.port else {
      return completion(.failure(DevToolsError("\(endpoint) is not a loopback DevTools endpoint.")))
    }
    var request = URLRequest(url: endpoint.appendingPathComponent("json/version"))
    request.timeoutInterval = 3
    URLSession.shared.dataTask(with: request) { data, _, error in
      guard let data, let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let socket = object["webSocketDebuggerUrl"] as? String, socket.hasPrefix("ws://127.0.0.1:\(port)/"),
        let url = URL(string: socket)
      else {
        let reason = error?.localizedDescription ?? "it does not serve a browser DevTools endpoint"
        return completion(.failure(DevToolsError("Port \(port): \(reason).")))
      }
      let client = DevToolsClient(url: url)
      client.start()
      client.send("SystemInfo.getProcessInfo") { result in
        switch result {
        case .failure(let failure):
          client.close()
          completion(.failure(failure))
        case .success(let reply):
          let processes = reply["processInfo"] as? [[String: Any]] ?? []
          let browser = processes.first { $0["type"] as? String == "browser" }?["id"] as? Int
          guard browser == Int(chromePid) else {
            client.close()
            let found = browser.map(String.init) ?? "unknown"
            return completion(
              .failure(DevToolsError("Port \(port) is served by browser pid \(found), not the owned Chrome \(chromePid).")))
          }
          completion(.success(client))
        }
      }
    }.resume()
  }

  private func start() {
    task.resume()
    receive()
  }

  /// Events arrive on the client's private queue, in order.
  public func onEvent(_ handler: @escaping (Event) -> Void) {
    queue.async { self.eventHandler = handler }
  }

  public func onClose(_ handler: @escaping () -> Void) {
    queue.async {
      if self.closed { handler() } else { self.closeHandlers.append(handler) }
    }
  }

  public func send(
    _ method: String, _ params: [String: Any] = [:], sessionId: String? = nil,
    reply: ((Result<[String: Any], DevToolsError>) -> Void)? = nil
  ) {
    queue.async {
      guard !self.closed else {
        reply?(.failure(DevToolsError("The DevTools connection is closed.")))
        return
      }
      let id = self.nextId
      self.nextId += 1
      var message: [String: Any] = ["id": id, "method": method, "params": params]
      if let sessionId { message["sessionId"] = sessionId }
      guard let data = try? JSONSerialization.data(withJSONObject: message),
        let text = String(data: data, encoding: .utf8)
      else {
        reply?(.failure(DevToolsError("\(method) has parameters that are not JSON.")))
        return
      }
      if let reply { self.pending[id] = reply }
      self.task.send(.string(text)) { error in
        guard let error else { return }
        self.queue.async { self.pending.removeValue(forKey: id)?(.failure(DevToolsError(error.localizedDescription))) }
      }
    }
  }

  public func close() {
    queue.async { self.finish() }
  }

  private func receive() {
    task.receive { [weak self] result in
      guard let self else { return }
      self.queue.async {
        switch result {
        case .failure:
          self.finish()
        case .success(let message):
          switch message {
          case .string(let text): self.handle(Data(text.utf8))
          case .data(let data): self.handle(data)
          @unknown default: break
          }
          if !self.closed { self.receive() }
        }
      }
    }
  }

  private func handle(_ data: Data) {
    switch DevToolsMessage(data) {
    case .reply(let id, let result): pending.removeValue(forKey: id)?(result)
    case .event(let event): eventHandler?(event)
    case nil: break
    }
  }

  private func finish() {
    guard !closed else { return }
    closed = true
    eventHandler = nil
    task.cancel(with: .normalClosure, reason: nil)
    session.invalidateAndCancel()
    let replies = pending.values
    pending = [:]
    for reply in replies { reply(.failure(DevToolsError("The DevTools connection closed."))) }
    let handlers = closeHandlers
    closeHandlers = []
    for handler in handlers { handler() }
  }
}
