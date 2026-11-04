#if DEBUG
  import Foundation
  import StimKit
  import SwiftUI

  enum ApproveMachineFixture: String, CaseIterable, Identifiable {
    case empty, pasted, unsupported, askingBuild, permission, waiting, approved, refused
    var id: Self { self }

    @MainActor func make() -> ApproveMachineModel {
      let ticket = SetupTicket.generate(
        now: Date(timeIntervalSince1970: 1_791_284_400), randomBytes: { $0 = Array(0..<32) })
      let command =
        "STIM_SETUP_TICKET=\(ticket.value) npx --yes --package @stim-cli/server@1.21.0 stim-server setup \\\n  --expires \(ticket.isoExpires) \\\n  --build \\\n  --device-host"
      let request = try? SetupRequest.parse(command)
      func step(_ id: String, _ state: SetupJournal.Step.State, _ title: String, _ detail: String? = nil)
        -> SetupJournal.Step
      { SetupJournal.Step(id: id, state: state, title: title, detail: detail) }
      let early = [
        step("server", .ok, "stim-server 1.21.0"), step("host", .ok, "Stim Host"), step("service", .ok, "Service"),
        step("route", .ok, "Tailnet route"),
      ]
      let journal = { (steps: [SetupJournal.Step]) in
        SetupJournal(ticket: ticket, capabilities: [.build, .deviceHost], steps: early + steps)
      }
      let grants = [
        SetupApprovalResult.Grant(capability: .build, id: "b-91aa", client: .init(name: "laptop")),
        SetupApprovalResult.Grant(capability: .deviceHost, id: "h-0f3e", client: .init(name: "laptop")),
      ]
      switch self {
      case .empty: return ApproveMachineModel(client: { nil })
      case .pasted: return .fixture(text: command)
      case .unsupported: return .fixture(text: command + " \\\n  --yes")
      case .askingBuild:
        return .fixture(
          request: request,
          journal: journal([step("approve", .running, "Access approval", "Waiting until \(ticket.isoExpires).")]),
          asking: .build)
      case .permission:
        return .fixture(
          request: request,
          journal: journal([
            step("approve.build", .ok, "Approved laptop for builds"),
            step("approve.device-host", .ok, "Approved laptop for hosted simulators"),
            step("approve", .ok, "Access approval"),
            step("permissions.screenRecording", .running, "Screen & System Audio Recording"),
          ]))
      case .waiting:
        return .fixture(
          request: request,
          journal: journal([
            step(
              "approve", .running, "Access approval",
              "Waiting for the requesting machine to connect. Stim Desktop sends this automatically.")
          ]))
      case .approved:
        return .fixture(request: request, finished: SetupApprovalResult(granted: grants, warnings: [], exitCode: 0))
      case .refused:
        return .fixture(
          request: request,
          finished: SetupApprovalResult(granted: [], warnings: ["Builds have no approval."], exitCode: 1))
      }
    }
  }

  struct ApproveMachinePlayground: View {
    @State private var fixture = ApproveMachineFixture.askingBuild
    @State private var model = ApproveMachineFixture.askingBuild.make()

    var body: some View {
      VStack(spacing: 0) {
        Picker("Approval state", selection: $fixture) {
          ForEach(ApproveMachineFixture.allCases) { Text($0.rawValue).tag($0) }
        }.padding(Space.md)
        ApproveMachineSheet(model: model, machineEntry: "mini").id(fixture)
      }
      .onChange(of: fixture) { model = fixture.make() }
    }
  }
#endif
