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
    case .test, .summary: return 4
    case .setup: return wizard.phase == .pick ? 0 : wizard.phase == .choose ? 1 : 2
    }
  }
  private var name: String { wizard.mac?.hostName ?? "the build Mac" }
  private var allApproved: Bool {
    !wizard.capabilities.isEmpty && wizard.capabilities.allSatisfy { !model.known.needsApproval($0) }
  }
  private var setupComplete: Bool {
    wizard.phase == .approved && wizard.journal?.done == true
      && wizard.journal?.steps.contains { $0.state == .failed } == false
  }
  @State private var showsLog = false

  var body: some View {
    HStack(spacing: 0) {
      VStack(alignment: .leading, spacing: Space.sm) {
        Text("Add a remote Mac").font(.stim(.headline)).padding(.bottom, Space.xl)
        ForEach(Array(["Pick a Mac", "What it does", "Set it up", "Tools", "Done"].enumerated()), id: \.offset) {
          index, title in
          HStack(spacing: Space.md) {
            Image(systemName: index < step ? "checkmark.circle.fill" : index == step ? "circle.inset.filled" : "circle")
            Text(title).font(.stim(.callout, weight: index == step ? .semibold : .regular))
          }
          .foregroundStyle(index == step ? Palette.accent : index > step ? Palette.tertiary : Palette.secondary)
          .frame(height: 30)
          .accessibilityLabel(title + (index < step ? ", done" : index == step ? ", current step" : ", waiting"))
        }
        Spacer()
      }
      .padding(Space.xl).frame(width: 170).background(Palette.sidebar)
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
    .frame(width: 740, height: 640)
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
        "Removes the entry added to remote.machines, restores remote.buildMode only if this wizard changed it, and runs stim doctor --json --platform ios --fix to forget the pairing. That also asks other listed machines with no credential. Grants on the build Mac must be revoked there with the commands shown next."
      )
    }
    .interactiveDismissDisabled(wizard.phase != .pick && wizard.phase != .choose)
  }

  private var content: some View {
    VStack(alignment: .leading, spacing: Space.lg) {
      AddMachineIllustration(scene: scene)
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

  private var scene: AddMachineIllustration.Scene {
    switch model.page {
    case .tools: return .tools
    case .test, .summary: return .ready
    case .setup: break
    }
    switch wizard.phase {
    case .pick:
      if model.checkingTailscale { return .tailnet(connected: false) }
      switch model.reachability {
      case .tailscaleMissing: return .tailnet(connected: false)
      case .tailscaleStopped: return model.tailscaleInstall == .cli ? .tailscaleUp : .tailscaleSwitch
      case .peerOffline, .ready: return model.macList == .empty ? .noMac : .tailnet(connected: true)
      }
    case .choose: return .capabilities(wizard.capabilities)
    default: return setupComplete ? .ready : .command
    }
  }

  private var pickContent: some View {
    VStack(alignment: .leading, spacing: Space.lg) {
      Text("Choose a Mac on your tailnet").font(.stim(.title))
      if model.checkingTailscale {
        HStack(spacing: Space.sm) {
          ProgressView().controlSize(.small)
          Text("Checking Tailscale\u{2026}").foregroundStyle(Palette.secondary)
        }
        .accessibilityElement(children: .combine)
      } else {
        pickState
      }
    }
  }

  @ViewBuilder private var pickState: some View {
    VStack(alignment: .leading, spacing: Space.lg) {
      switch model.reachability {
      case .tailscaleMissing:
        checkLine("Tailscale is not installed on this Mac", ready: false)
        Text("Stim reaches your build Mac over Tailscale. Install it, sign in, and this step continues by itself.")
          .foregroundStyle(Palette.secondary).fixedSize(horizontal: false, vertical: true)
        Button("Download Tailscale", systemImage: "arrow.down.circle") {
          NSWorkspace.shared.open(URL(string: "https://tailscale.com/download/mac")!)
        }
        .buttonStyle(.stim(.primary, .regular))
      case .tailscaleStopped:
        checkLine("Tailscale is off on this Mac", ready: false)
        if model.tailscaleInstall == .cli {
          Text("Start Tailscale in Terminal. This step continues by itself once it is up.")
            .foregroundStyle(Palette.secondary)
          CopyableCommand(command: "tailscale up")
        } else {
          Text("Turn on Tailscale in its menu bar app. This step continues by itself once it is connected.")
            .foregroundStyle(Palette.secondary).fixedSize(horizontal: false, vertical: true)
        }
      case .peerOffline, .ready:
        checkLine("Tailscale runs on this Mac", ready: true)
        machineList
        if model.reachability == .peerOffline, let peer = model.selected {
          Text("Open Tailscale on \(peer.mac.hostName) and sign in to the same tailnet.")
            .font(.stim(.footnote)).foregroundStyle(Palette.secondary).fixedSize(horizontal: false, vertical: true)
        } else if model.macList == .offlineOnly {
          Text("Turn on Tailscale on that Mac to continue.")
            .font(.stim(.footnote)).foregroundStyle(Palette.secondary).fixedSize(horizontal: false, vertical: true)
        }
      }
    }
  }

  @ViewBuilder private var machineList: some View {
    if model.peers.isEmpty {
      Text("No other Mac on your tailnet yet").font(.stim(.headline))
      Text("Install Tailscale on the Mac you want to use and sign in with the same account.")
        .foregroundStyle(Palette.secondary).fixedSize(horizontal: false, vertical: true)
      Button("Download Tailscale", systemImage: "arrow.down.circle") {
        NSWorkspace.shared.open(URL(string: "https://tailscale.com/download/mac")!)
      }
      .buttonStyle(.stim(.primary, .regular))
    } else {
      VStack(spacing: Space.xs) {
        ForEach(model.peers) { peer in
          Button {
            model.selectedId = peer.id
          } label: {
            HStack(spacing: Space.md) {
              Image(systemName: model.selectedId == peer.id ? "largecircle.fill.circle" : "circle")
                .foregroundStyle(model.selectedId == peer.id ? Palette.accent : Palette.tertiary)
              VStack(alignment: .leading, spacing: Space.xxs) {
                Text(peer.mac.hostName).font(.stim(.body, weight: .semibold))
                Text(peer.mac.dnsName).font(.stim(.caption, mono: true)).foregroundStyle(Palette.secondary)
              }
              Spacer()
              HStack(spacing: Space.xs) {
                Circle().fill(peer.online ? Palette.success : Palette.tertiary).frame(width: 7, height: 7)
                Text(peer.online ? "Reachable" : "Offline")
              }
              .font(.stim(.footnote)).foregroundStyle(Palette.secondary)
            }
            .padding(Space.md).contentShape(Rectangle())
          }
          .buttonStyle(.hoverRow(radius: Radius.control, selected: model.selectedId == peer.id))
          .disabled(!peer.online)
          .accessibilityLabel("\(peer.mac.hostName), \(peer.online ? "reachable over Tailscale" : "offline")")
        }
      }
      .padding(Space.sm).background(Palette.surface, in: RoundedRectangle(cornerRadius: Radius.card))
      .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Palette.border))
    }
  }

  private var chooseContent: some View {
    VStack(alignment: .leading, spacing: Space.lg) {
      Text("What should \(name) do for this Mac?").font(.stim(.title))
      Text("Choose what \(name) takes on: building your apps, running simulators, or both.")
        .foregroundStyle(Palette.secondary).fixedSize(horizontal: false, vertical: true)
      VStack(alignment: .leading, spacing: Space.md) {
        capability(.build, title: "Builds", detail: "iOS, Android and macOS Debug builds run on \(name).")
        capability(.deviceHost, title: "Hosted simulators", detail: "iOS simulators run on \(name); you use them from this Mac.")
      }
      let lines = previewLines(capabilities: wizard.capabilities, known: model.known, version: model.version)
      TerminalCard(
        lines: lines, mode: wizard.capabilities.isEmpty ? .live : .scripted(loop: false),
        width: nil, animates: !model.isFixture, height: 188, maxVisibleLines: 9
      )
      .id(TerminalLine.spokenSummary(lines))
      if wizard.capabilities.isEmpty {
        Text("Choose at least one.").font(.stim(.footnote)).foregroundStyle(Palette.secondary)
      } else if allApproved {
        Label("Already approved. Next checks the tools.", systemImage: "checkmark.circle.fill")
          .font(.stim(.footnote)).foregroundStyle(Palette.success)
      }
      if model.preparingSample {
        Label("Preparing the sample app to check existing approvals", systemImage: "hourglass").foregroundStyle(Palette.secondary)
      }
      if wizard.failure(now: model.now) == .noWorkspace {
        failureContent(.noWorkspace)
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
      .font(.stim(.body, weight: .semibold))
      Text(detail).font(.stim(.footnote)).foregroundStyle(Palette.secondary).padding(.leading, Space.xl)
    }
  }

  @ViewBuilder private var runningContent: some View {
    if setupComplete {
      successContent
    } else {
      VStack(alignment: .leading, spacing: Space.lg) {
        Text(wizard.phase == .cancelled ? "Setup cancelled" : "Set up \(name)").font(.stim(.title))
        if wizard.phase == .cancelled {
          Text(statusText).foregroundStyle(Palette.secondary).fixedSize(horizontal: false, vertical: true)
          if !wizard.revokeIds.isEmpty {
            Text("On \(name), revoke these requests:").font(.stim(.headline))
            ForEach(wizard.revokeIds.sorted(), id: \.self) { CopyableCommand(command: "stim-server devices revoke \($0)") }
          }
        } else {
          if wizard.journal == nil || wizard.failure(now: model.now) == .noAnswer || wizard.failure(now: model.now) == .expired {
            commandBox
          }
          if let journal = wizard.journal {
            setupLog(journal)
          }
          Text(statusText).foregroundStyle(wizard.phase == .approved ? Palette.success : Palette.secondary)
            .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
          if let failure = wizard.failure(now: model.now) {
            failureContent(failure)
          }
          if let ticket = wizard.ticket, wizard.phase != .approved {
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
  }

  private func setupLog(_ journal: SetupJournal) -> some View {
    TerminalCard(
      lines: journalLines(journal, clientName: model.known.clientName), mode: .live, width: nil,
      animates: !model.isFixture, height: 232, maxVisibleLines: 12)
  }

  private var successContent: some View {
    VStack(alignment: .leading, spacing: Space.lg) {
      Text("\(name) is ready").font(.stim(.title))
      VStack(alignment: .leading, spacing: Space.sm) {
        ForEach(SetupCapability.allCases.filter { wizard.capabilities.contains($0) }, id: \.self) { capability in
          Label(
            capability == .build ? "Builds approved for this Mac" : "Hosted simulators approved for this Mac",
            systemImage: "checkmark.circle.fill"
          )
          .foregroundStyle(Palette.success)
        }
        if wizard.capabilities.contains(.deviceHost) {
          permissionLine("Screen recording", id: "permissions.screenRecording", granted: wizard.host?.host?.screenRecording)
          permissionLine("Device control", id: "permissions.deviceControl", granted: wizard.host?.host?.accessibility)
        }
      }
      if let failure = wizard.failure(now: model.now), case .permissionSkipped = failure {
        failureContent(failure)
      }
      Text("Next checks the tools on \(name).").foregroundStyle(Palette.secondary)
      AnimatedDisclosure(isExpanded: showsLog) {
        Button {
          showsLog.toggle()
        } label: {
          Label(showsLog ? "Hide setup log" : "Show setup log", systemImage: showsLog ? "chevron.down" : "chevron.right")
            .font(.stim(.footnote, weight: .semibold))
        }
        .buttonStyle(.plain).foregroundStyle(Palette.accent)
      } content: {
        if let journal = wizard.journal { setupLog(journal) }
      }
    }
  }

  @ViewBuilder private func permissionLine(_ title: String, id: String, granted: Bool?) -> some View {
    let step = wizard.journal?.steps.first { $0.id == id }
    let ok = granted ?? (step?.state == .ok)
    Label(
      ok ? "\(title) permission granted" : "\(title) permission \(step?.state == .skipped ? "skipped" : "not granted")",
      systemImage: ok ? "checkmark.circle.fill" : "exclamationmark.triangle.fill"
    )
    .foregroundStyle(ok ? Palette.success : Palette.warning)
  }

  private var statusText: String {
    if wizard.phase == .cancelled {
      return "The wizard's settings have been removed. Approval on the build Mac stays until you revoke it there."
    }
    if wizard.phase == .approved {
      return "Approved. \(name) is finishing its checks; Next checks its tools."
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
      if let fix { CopyableCommand(command: fix) }
    case .serverTooOld(let fix):
      Text("This stim-server predates setup support. Run the update command on \(name).")
      if let fix { CopyableCommand(command: fix) }
    case .requestLapsed:
      Text("The request lapsed. Stim asks again with the same ticket, at most once every 30 seconds while it is valid.")
    case .grantedOther(_, let journalId, _):
      Text("Another request from this Mac was approved. Revoke it on \(name), then generate a New command.")
      CopyableCommand(command: "stim-server devices revoke \(journalId)")
    case .funneled(let fix):
      Text("Setup refused because the route is public. On \(name), run:")
      CopyableCommand(command: fix)
    case .permissionSkipped(let feature):
      Text(feature + ". Enable Stim Host in System Settings > Privacy & Security on " + name + ". This updates by itself.")
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
      }
      if let command = model.command {
        CopyableCommand(command: command)
      } else {
        Text("Resolving this Mac's stim-server version and tailnet node\u{2026}")
          .font(.stim(.caption, mono: true)).fixedSize(horizontal: false, vertical: true)
      }
      Text(
        "Needs Node 22.12+ there. Run it while signed in at that Mac: macOS shows permission prompts on its screen."
      )
      .font(.stim(.footnote)).foregroundStyle(Palette.secondary).fixedSize(horizontal: false, vertical: true)
    }
    .padding(Space.md).background(Palette.surface, in: RoundedRectangle(cornerRadius: Radius.control))
  }

  private var footer: some View {
    HStack(spacing: Space.md) {
      if model.busy { ProgressView().controlSize(.small) }
      Spacer()
      if wizard.phase == .cancelled {
        if model.error != nil {
          Button("Retry undo") { Task { await model.send(.cancel) } }.disabled(model.busy || model.cancelling)
        }
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
        }.disabled((model.busy && !model.preparingSample) || model.cancelling)
        if step == 3 {
          Button("Next") { Task { await model.openSummary() } }.disabled(model.busy || model.toolsBlock)
        } else if model.page == .test {
          Button("Back to summary") { Task { await model.closeTest() } }.disabled(model.sample?.running == true)
        } else if step == 4 {
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
          Button("Next") { Task { await model.next() } }.disabled(
            wizard.capabilities.isEmpty || model.version == nil || model.selfNode == nil || model.busy)
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
