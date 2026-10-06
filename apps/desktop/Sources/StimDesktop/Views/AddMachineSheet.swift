import AppKit
import StimKit
import SwiftUI

struct AddMachineSheet: View {
  @Bindable var model: AddMachineModel
  @Environment(\.dismiss) private var dismiss
  @Environment(\.timeZone) private var timeZone
  @State private var confirmsCancel = false

  private var wizard: SetupWizard { model.wizard }
  private var step: Int {
    switch model.page {
    case .tools: return 3
    case .test: return 4
    case .summary: return 5
    case .setup: return wizard.phase == .pick ? 0 : wizard.phase == .choose ? 1 : 2
    }
  }
  private var name: String { wizard.mac?.hostName ?? "the build Mac" }
  private var allApproved: Bool { wizard.capabilities.allSatisfy { !model.known.needsApproval($0) } }

  var body: some View {
    HStack(spacing: 0) {
      VStack(alignment: .leading, spacing: Space.sm) {
        Text("Add a build machine").font(.stim(.headline)).padding(.bottom, Space.xl)
        ForEach(Array(["Pick a Mac", "What it does", "Set it up", "Tools", "Test build", "Done"].enumerated()), id: \.offset) {
          index, title in
          HStack(spacing: Space.md) {
            Image(systemName: index < step ? "checkmark.circle.fill" : index == step ? "circle.inset.filled" : "circle")
            Text(title).font(.stim(.callout, weight: index == step ? .semibold : .regular))
          }
          .foregroundStyle(index == step ? Palette.accent : index > step ? Palette.tertiary : Palette.secondary)
          .frame(height: 30)
          .accessibilityLabel(
            title
              + (index < step ? ", done" : index == step ? ", current step" : ", waiting"))
        }
        Spacer()
      }
      .padding(Space.xl).frame(width: 205).background(Palette.sidebar)
      Divider()
      VStack(spacing: 0) {
        if model.isFixture {
          content.frame(maxHeight: .infinity, alignment: .topLeading)
        } else {
          ScrollView { content }
        }
        Divider()
        footer.padding(Space.xl)
      }
    }
    .frame(width: 920, height: 740)
    .font(.stim(.body)).foregroundStyle(Palette.text).tint(Palette.brand)
    .background(Palette.background)
    .task { await model.start() }
    .onDisappear { model.stop() }
    .onQuitRequested {
      model.stop()
      dismiss()
    }
    .confirmationDialog("Cancel setup for \(name)?", isPresented: $confirmsCancel) {
      Button("Cancel setup", role: .destructive) { Task { await model.send(.cancel) } }.disabled(model.cancelling)
      Button("Keep setting up", role: .cancel) {}
    } message: {
      Text(
        "Removes entries added to offload.machines and hosting.machines, restores offload.mode only if this wizard changed it, and runs stim doctor --json --platform ios --fix to forget the pairing. That also asks other listed machines with no credential. Grants on the build Mac must be revoked there with the commands shown next."
      )
    }
    .interactiveDismissDisabled(wizard.phase != .pick && wizard.phase != .choose)
  }

  private var content: some View {
    VStack(alignment: .leading, spacing: Space.lg) {
      if step == 0 {
        pickContent
      } else if step == 1 {
        chooseContent
      } else if step == 2 {
        runningContent
      } else {
        AddMachineSteps(model: model)
      }
      if let error = model.error {
        Text(error).foregroundStyle(Palette.error).textSelection(.enabled)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(Space.xxl)
  }

  private var pickContent: some View {
    VStack(alignment: .leading, spacing: Space.lg) {
      Text("Choose a Mac on your tailnet").font(.stim(.title))
      VStack(spacing: Space.sm) {
        ForEach(model.peers) { peer in
          Button {
            model.selectedId = peer.id
          } label: {
            HStack(spacing: Space.md) {
              Image(systemName: model.selectedId == peer.id ? "largecircle.fill.circle" : "circle")
              VStack(alignment: .leading, spacing: Space.xxs) {
                Text(peer.mac.hostName).font(.stim(.body, weight: .semibold))
                Text(peer.mac.dnsName).font(.stim(.caption, mono: true)).foregroundStyle(Palette.secondary)
              }
              Spacer()
              Text(
                peer.online
                  ? (model.health[peer.id].map { "stim-server \($0.version)" }
                    ?? (model.healthChecked.contains(peer.id) ? "no stim-server" : "Checking stim-server\u{2026}")) : "offline"
              )
              .font(.stim(.footnote)).foregroundStyle(Palette.secondary)
            }
            .padding(Space.md).contentShape(Rectangle())
          }
          .buttonStyle(.hoverRow(radius: Radius.control, selected: model.selectedId == peer.id))
          .disabled(!peer.online)
        }
      }
      .padding(Space.sm).background(Palette.surface, in: RoundedRectangle(cornerRadius: Radius.card))
      checkLine(
        "Tailscale runs on this Mac", ready: model.reachability != .tailscaleMissing && model.reachability != .tailscaleStopped)
      if let peer = model.selected {
        checkLine("\(peer.mac.hostName) is reachable over Tailscale", ready: model.reachability == .ready)
      }
      switch model.reachability {
      case .tailscaleMissing:
        Text("Install Tailscale from tailscale.com/download, sign in, then Check again.")
      case .tailscaleStopped:
        CommandText(command: "tailscale up")
      case .peerOffline:
        if let peer = model.selected {
          Text("Open Tailscale on \(peer.mac.hostName) and sign in to the same tailnet.")
        } else {
          Text("Install Tailscale on the build Mac and sign in with the same account.")
        }
      case .ready: EmptyView()
      }
    }
  }

  private var chooseContent: some View {
    VStack(alignment: .leading, spacing: Space.lg) {
      Text("What should \(name) do for this Mac?").font(.stim(.title))
      capability(
        .build, title: "Builds", detail: "iOS simulator, Android emulator and macOS Debug builds run there; failures build here.")
      capability(
        .deviceHost, title: "Hosted simulators",
        detail: "iOS simulators run there; you view and control them from here and your phone.")
      Text("What will happen on \(name)").font(.stim(.headline))
      TerminalCard(
        lines: previewLines(capabilities: wizard.capabilities, known: model.known, version: model.version),
        mode: .scripted(loop: false),
        width: 650, animates: !model.isFixture, height: 208, maxVisibleLines: 10
      )
      .id(TerminalLine.spokenSummary(previewLines(capabilities: wizard.capabilities, known: model.known, version: model.version)))
      if allApproved {
        Text("Every chosen capability is already approved. Next checks the tools and tests a sample build.")
          .foregroundStyle(Palette.success)
      } else {
        commandBox
        Text(
          "Needs Node 22.12+ there. Run it in Terminal while signed in at that Mac: macOS shows permission prompts on its screen."
        )
        .font(.stim(.footnote)).foregroundStyle(Palette.secondary)
      }
    }
  }

  private func capability(_ capability: SetupCapability, title: String, detail: String) -> some View {
    VStack(alignment: .leading, spacing: Space.xs) {
      Toggle(
        title,
        isOn: Binding(get: { wizard.capabilities.contains(capability) }, set: { model.setCapability(capability, enabled: $0) })
      )
      .toggleStyle(.checkbox)
      .disabled(wizard.capabilities == [capability])
      Text(detail).font(.stim(.footnote)).foregroundStyle(Palette.secondary).padding(.leading, Space.xl)
    }
  }

  private var runningContent: some View {
    VStack(alignment: .leading, spacing: Space.lg) {
      Text(wizard.phase == .cancelled ? "Setup cancelled" : "Setting up \(name)").font(.stim(.title))
      if let journal = wizard.journal {
        TerminalCard(
          lines: journalLines(journal), mode: .live, width: 650, animates: !model.isFixture,
          height: 272, maxVisibleLines: 14)
      }
      Text(statusText).foregroundStyle(wizard.phase == .approved ? Palette.success : Palette.secondary)
        .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
      if wizard.phase == .cancelled {
        if !wizard.revokeIds.isEmpty {
          Text("On \(name), revoke these requests:").font(.stim(.headline))
          ForEach(wizard.revokeIds.sorted(), id: \.self) { CommandText(command: "stim-server devices revoke \($0)") }
        }
      } else {
        if wizard.journal == nil || wizard.failure(now: model.now) == .noAnswer || wizard.failure(now: model.now) == .expired {
          commandBox
        }
        if let failure = wizard.failure(now: model.now) {
          failureContent(failure)
        }
        if let ticket = wizard.ticket {
          Text(
            model.now >= ticket.expiresAt
              ? "This command expired."
              : "Command expires in \(max(0, Int(ticket.expiresAt.timeIntervalSince(model.now) / 60))) minutes (expires \(expiryTime(ticket.expiresAt)))."
          )
          .font(.stim(.caption)).foregroundStyle(Palette.tertiary)
        }
      }
    }
  }

  private var statusText: String {
    if wizard.phase == .cancelled {
      return "The wizard's settings have been removed. Approval on the build Mac stays until you revoke it there."
    }
    if wizard.phase == .approved {
      return
        "Every chosen capability is approved for this Mac. Next checks the build Mac's tools."
    }
    if wizard.failure(now: model.now) == .noWorkspace {
      return "Preparing the sample app for setup requests. If preparation fails, retry from the test below."
    }
    if wizard.journal == nil {
      return model.serverNotReady
        ? "stim-server on \(name) is not ready. Waiting for it to start." : "Waiting for \(name) to start stim-server"
    }
    if wizard.journal?.steps.contains(where: { ($0.id == "approve" || $0.id.hasPrefix("approve.")) && $0.state == .running })
      == true
    {
      return
        "Running the command is the approval. Someone at \(name) answers y/N in the terminal for each request, once per capability."
    }
    if wizard.journal?.steps.contains(where: { $0.id.hasPrefix("permissions.") && $0.state == .running }) == true {
      return
        "Someone at \(name) clicks Allow in the macOS prompt on that Mac's screen, or enables Stim Host in System Settings > Privacy & Security."
    }
    return "Waiting on \(name). The terminal on that Mac checks setup and records each result here."
  }

  @ViewBuilder private func failureContent(_ failure: SetupWizard.Failure) -> some View {
    switch failure {
    case .noAnswer:
      Text(
        "No answer yet. Check the terminal on \(name). Run the command there and check the port setup printed (Route: https port 7447)."
      )
      if let older = model.olderThanSetup {
        Text(
          "stim-server \(older) on \(name) predates setup support (1.16.0). If an app there runs it, update that app, then run the command again; setup prints the exact update command."
        )
      }
      HStack {
        Group {
          if model.isFixture {
            Text(model.manualPort.isEmpty ? "HTTPS port" : model.manualPort)
              .foregroundStyle(model.manualPort.isEmpty ? Palette.tertiary : Palette.text)
              .frame(maxWidth: .infinity, alignment: .leading)
          } else {
            TextField("HTTPS port", text: $model.manualPort).textFieldStyle(.plain)
          }
        }
        .padding(Space.sm).frame(width: 120)
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: Radius.small))
        .overlay(RoundedRectangle(cornerRadius: Radius.small).strokeBorder(Palette.tertiary.opacity(0.4)))
        Button("Use port") { Task { await model.useManualPort() } }.disabled(model.busy)
      }
    case .expired: Text("The ticket expired before approval. Generate a New command.")
    case .stepFailed(let step, let detail, let fix):
      Text([step, detail].compactMap { $0 }.joined(separator: ": ")).foregroundStyle(Palette.error)
      if let fix { CommandText(command: fix) }
    case .serverTooOld(let fix):
      Text("This stim-server predates setup support. Run the update command on \(name).")
      if let fix { CommandText(command: fix) }
    case .requestLapsed:
      Text("The request lapsed. Stim asks again with the same ticket, at most once every 30 seconds while it is valid.")
    case .grantedOther(_, let journalId, _):
      Text("Another request from this Mac was approved. Revoke it on \(name), then generate a New command.")
      CommandText(command: "stim-server devices revoke \(journalId)")
    case .funneled(let fix):
      Text("Setup refused because the route is public. On \(name), run:")
      CommandText(command: fix)
    case .permissionSkipped(let feature):
      Text(feature + ". Enable Stim Host in System Settings > Privacy & Security on " + name + ", then Check again.")
      if let fix = wizard.journal?.steps.first(where: { $0.id.hasPrefix("permissions.") && $0.state != .ok })?.fix {
        Text(fix).textSelection(.enabled)
      }
    case .noWorkspace:
      if let sample = model.sample {
        if case .failed(_, let message, _) = sample.test.state {
          Text(message).foregroundStyle(Palette.error)
          Button("Retry sample") { sample.prepare() }
        }
      }
    }
  }

  private var commandBox: some View {
    VStack(alignment: .leading, spacing: Space.sm) {
      HStack {
        Text("Run this in Terminal on \(name)").font(.stim(.footnote, weight: .semibold))
        Spacer()
        if let ticket = wizard.ticket ?? model.draftTicket {
          Text("expires \(expiryTime(ticket.expiresAt))").font(.stim(.caption))
        }
        Button("Copy") {
          if let command = model.command {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(command, forType: .string)
          }
        }.disabled(model.command == nil)
      }
      Text(model.command ?? "Resolving this Mac's stim-server version and tailnet node. Check again.")
        .font(.stim(.caption, mono: true)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
    }
    .padding(Space.md).background(Palette.surface, in: RoundedRectangle(cornerRadius: Radius.control))
  }

  private var footer: some View {
    HStack(spacing: Space.md) {
      if (step < 4 && wizard.phase != .cancelled) || model.error != nil {
        Button("Check again") { Task { await model.checkAgain() } }.disabled(model.busy)
      }
      if model.busy { ProgressView().controlSize(.small) }
      Spacer()
      if wizard.phase == .cancelled {
        Button("Close") {
          model.stop()
          dismiss()
        }.disabled(model.busy || model.error != nil)
      } else {
        Button("Cancel") {
          if wizard.entriesWritten || wizard.journal != nil {
            confirmsCancel = true
          } else {
            model.stop()
            dismiss()
          }
        }.disabled(model.busy || model.cancelling)
        if step == 3 {
          Button("Next") { model.openTest() }.disabled(model.busy || model.toolsBlock)
        } else if step == 4 {
          Button("Next") { Task { await model.openSummary() } }.disabled(
            model.sample?.running == true || (model.sample?.test.passed != true && model.sample?.test.state != .skipped))
        } else if step == 5 {
          Button("Done") {
            Task {
              await model.finish()
              if model.finished { dismiss() }
            }
          }.disabled(model.busy)
        } else if step == 0 {
          Button("Next") { Task { await model.pick() } }.disabled(
            model.reachability != .ready || model.selfNode == nil || model.busy)
        } else if step == 1 {
          Button("Next") { Task { await model.next() } }.disabled(model.command == nil || model.busy)
        } else if wizard.phase == .approved {
          Button("Next") { Task { await model.openTools() } }.disabled(model.busy)
        } else if wizard.failure(now: model.now) == .expired || isGrantedOther {
          Button("New command") { Task { await model.newCommand() } }.disabled(model.busy)
        }
      }
    }
  }

  private func expiryTime(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = timeZone
    formatter.dateFormat = "HH:mm"
    return formatter.string(from: date)
  }

  private var isGrantedOther: Bool {
    if case .grantedOther = wizard.failure(now: model.now) { return true }
    return false
  }

  private func checkLine(_ text: String, ready: Bool) -> some View {
    Label(text, systemImage: ready ? "checkmark.circle.fill" : "xmark.circle.fill")
      .foregroundStyle(ready ? Palette.success : Palette.warning)
  }
}
