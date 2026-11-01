import Foundation
import StimKit

@MainActor final class PairedViewState: ObservableObject {
  static let shared = PairedViewState()

  @Published var hidden: Set<WorkspaceKey> = []
  @Published var expandedProjects: [String: Bool] = [:]
  @Published var collapsedServers: Set<String> = []
}
