import Foundation
import Observation
import StimKit

@MainActor @Observable
final class ApproveMachineModel {
  enum Phase: Equatable {
    case paste
    case running
    case finished(SetupApprovalResult)
    case failed(String)
  }

  var text = "" {
    didSet { if phase == .paste { error = nil } }
  }
  private(set) var phase: Phase = .paste
  private(set) var request: SetupRequest?
  private(set) var journal: SetupJournal?
  private(set) var asking: SetupCapability?
  private(set) var answering = false
  private(set) var error: String?
  @ObservationIgnored private var task: Task<Void, Never>?
  @ObservationIgnored private let client: @MainActor () -> ServerClient?

  init(client: @escaping @MainActor () -> ServerClient? = { ServerSession.shared.client }) {
    self.client = client
  }

  var reading: Result<SetupRequest, SetupRequest.Problem>? {
    guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
    do {
      return .success(try SetupRequest.parse(text))
    } catch {
      return .failure(error)
    }
  }

  var waitingPermission: String? {
    journal?.steps.first { $0.state == .running && $0.id.hasPrefix("permissions.") }
      .map { String($0.id.dropFirst("permissions.".count)) }
  }

  var waitsForMachine: Bool { journal?.waitsForConnection == true && asking == nil }

  func start() {
    guard case .success(let request)? = reading, task == nil else { return }
    self.request = request
    text = ""
    phase = .running
    task = Task { [weak self] in
      guard let self else { return }
      do {
        let result = try await runSetupApproval(request, client: client()) { [weak self] journal, asking in
          self?.journal = journal
          self?.asking = asking
        }
        phase = .finished(result)
      } catch is CancellationError {
      } catch {
        phase = .failed(error.localizedDescription)
      }
      asking = nil
      task = nil
    }
  }

  func answer(_ answer: SetupAnswer) {
    guard let journal = request?.ticket.journal, !answering else { return }
    answering = true
    Task {
      defer { answering = false }
      do {
        guard let client = client() else { throw ServerError(code: "not-connected", message: "Not connected.") }
        _ = try await client.request("desktop.setup.answer", answer.params(journal: journal))
      } catch {
        self.error = error.localizedDescription
      }
    }
  }

  func cancel() {
    task?.cancel()
    task = nil
  }

  var confirmation: ConnectionConfirmation? {
    guard case .finished(let result) = phase, let name = result.granted.first?.client.name else { return nil }
    return .incoming(
      name: name, access: result.granted.map { $0.capability == .build ? .build : .runDevices },
      ids: result.granted.map(\.id))
  }
}

#if DEBUG
  extension ApproveMachineModel {
    static func fixture(
      text: String = "", request: SetupRequest? = nil, journal: SetupJournal? = nil, asking: SetupCapability? = nil,
      finished: SetupApprovalResult? = nil
    ) -> ApproveMachineModel {
      let model = ApproveMachineModel(client: { nil })
      model.text = text
      if let request {
        model.request = request
        model.phase = finished.map { .finished($0) } ?? .running
      }
      model.journal = journal
      model.asking = asking
      return model
    }
  }
#endif
