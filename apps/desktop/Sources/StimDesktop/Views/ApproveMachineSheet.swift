import StimKit
import SwiftUI

struct ApproveMachineSheet: View {
  @State var model: ApproveMachineModel
  var machineEntry: String?
  var openConnections: () -> Void = {}
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    VStack(spacing: 0) {
      ScrollView {
        VStack(alignment: .leading, spacing: Space.lg) {
          Text("Let Another Machine Build or Run Simulators Here").font(.stim(.title))
          switch model.phase {
          case .paste: pasteContent
          case .running: runningContent
          case .finished(let result): finishedContent(result)
          case .failed(let message):
            Text(message).foregroundStyle(Palette.error).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
          }
          if let error = model.error {
            Text(error).foregroundStyle(Palette.error).textSelection(.enabled)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Space.xxl)
      }
      Divider()
      footer.padding(Space.xl)
    }
    .frame(width: 560, height: 600)
    .font(.stim(.body)).foregroundStyle(Palette.text).tint(Palette.primary)
    .background(Palette.background)
    .onDisappear { model.cancel() }
    .onQuitRequested {
      model.cancel()
      dismiss()
    }
    .interactiveDismissDisabled(model.phase == .running)
  }

  @ViewBuilder private var pasteContent: some View {
    Text(
      "On the other machine, choose Settings > Connections > This machine uses > Add > Build or Run Simulators There and pick this machine. Without Stim Desktop there, run:"
    )
    .foregroundStyle(Palette.secondary).fixedSize(horizontal: false, vertical: true)
    CopyableCommand(command: "stim remote add \(machineEntry ?? "<this machine>")", runsOn: "the other machine")
    Text("Copy the stim setup command it shows and paste it here. Nothing is approved until you choose Allow.")
      .foregroundStyle(Palette.secondary).fixedSize(horizontal: false, vertical: true)
    TextEditor(text: $model.text)
      .font(.stim(.caption, mono: true))
      .frame(height: 110)
      .overlay(RoundedRectangle(cornerRadius: Radius.small).strokeBorder(Palette.border))
      .accessibilityLabel("Setup command")
    switch model.reading {
    case .failure(let problem)?:
      Label(problem.message, systemImage: "exclamationmark.triangle.fill").foregroundStyle(Palette.warning)
        .fixedSize(horizontal: false, vertical: true)
    case .success(let request)?: summary(request)
    case nil: EmptyView()
    }
    Text(
      "Builds run the other machine's project code here. Hosted simulators run its app code in simulators this machine owns. Neither lets it see or control your own work."
    )
    .font(.stim(.footnote)).foregroundStyle(Palette.tertiary).fixedSize(horizontal: false, vertical: true)
  }

  private func summary(_ request: SetupRequest) -> some View {
    VStack(alignment: .leading, spacing: Space.sm) {
      fact("Asks for") {
        AccessPills(access: request.capabilities.map { $0 == .build ? .build : .runDevices })
      }
      fact("Expires") { Text(request.ticket.expiresAt.formatted(date: .omitted, time: .shortened)) }
      fact("Ticket") { Text(verbatim: String(request.ticket.value.prefix(4)) + "\u{2026}").font(.stim(.callout, mono: true)) }
    }
    .padding(Space.lg)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Palette.surface, in: RoundedRectangle(cornerRadius: Radius.card))
    .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Palette.border))
  }

  @ViewBuilder private var runningContent: some View {
    if let request = model.request { summary(request) }
    if let capability = model.asking {
      Banner(tone: .warning, icon: "hammer.fill") {
        Text(
          capability == .build
            ? "Let the machine holding this ticket build here?" : "Let the machine holding this ticket host simulators here?"
        )
        .font(.stim(.body, weight: .semibold))
        Text(
          capability == .build
            ? "It runs its project code on this machine to build." : "It runs its app code in simulators this machine owns."
        )
        .foregroundStyle(Palette.secondary).fixedSize(horizontal: false, vertical: true)
        HStack {
          Spacer()
          Button("Don't Allow") { model.answer(.refuse(capability)) }.buttonStyle(.stim()).disabled(model.answering)
          Button("Allow") { model.answer(.approve(capability)) }.buttonStyle(.stim(.primary)).disabled(model.answering)
        }
      }
    } else if let permission = model.waitingPermission {
      Banner(tone: .warning, icon: "lock.shield") {
        Text("Allow Stim Desktop in System Settings > Privacy & Security").font(.stim(.body, weight: .semibold))
        Text("Hosted simulators need screen recording to be seen and accessibility to be controlled.")
          .foregroundStyle(Palette.secondary).fixedSize(horizontal: false, vertical: true)
        HStack {
          Spacer()
          Button("Skip") { model.answer(.skip(permission: permission)) }.buttonStyle(.stim()).disabled(model.answering)
        }
      }
    } else if model.waitsForMachine {
      HStack(spacing: Space.md) {
        ProgressView().controlSize(.small)
        Text(
          "Waiting for the other machine to connect. Stim Desktop there connects by itself; after stim remote add, run stim remote list there. Keep this open: closing it withdraws the request."
        )
        .foregroundStyle(Palette.secondary).fixedSize(horizontal: false, vertical: true)
      }
    }
    if let journal = model.journal {
      VStack(alignment: .leading, spacing: Space.xs) {
        ForEach(journal.steps.filter { !$0.id.hasPrefix("tools.") && $0.id != "summary" }, id: \.id) { step in
          Label(step.title, systemImage: icon(step.state)).foregroundStyle(color(step.state))
        }
      }
      .font(.stim(.callout))
    }
  }

  @ViewBuilder private func finishedContent(_ result: SetupApprovalResult) -> some View {
    if let confirmation = model.confirmation {
      ConnectionConfirmationView(confirmation: confirmation)
    } else {
      Text("Nothing was approved. The ticket no longer works here.").foregroundStyle(Palette.secondary)
    }
    ForEach(result.warnings, id: \.self) { warning in
      Label(warning, systemImage: "exclamationmark.triangle.fill").font(.stim(.footnote))
        .foregroundStyle(Palette.warning).fixedSize(horizontal: false, vertical: true)
    }
  }

  private var footer: some View {
    HStack(spacing: Space.md) {
      Spacer()
      switch model.phase {
      case .finished, .failed:
        if model.confirmation != nil {
          Button("Open Connections") {
            openConnections()
            dismiss()
          }.buttonStyle(.stim())
        }
        Button("Done") { dismiss() }.buttonStyle(.stim(.primary)).keyboardShortcut(.defaultAction)
      case .paste, .running:
        Button("Cancel") {
          model.cancel()
          dismiss()
        }
        .buttonStyle(.stim()).keyboardShortcut(.cancelAction)
        if model.phase == .paste {
          Button("Continue") { model.start() }
            .buttonStyle(.stim(.primary)).keyboardShortcut(.defaultAction)
            .disabled(!readable)
        }
      }
    }
  }

  private var readable: Bool {
    if case .success? = model.reading { return true }
    return false
  }

  private func fact<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: Space.md) {
      Text(label).font(.stim(.callout)).foregroundStyle(Palette.secondary).frame(width: 84, alignment: .leading)
      content().font(.stim(.callout))
    }
  }

  private func icon(_ state: SetupJournal.Step.State) -> String {
    switch state {
    case .ok: return "checkmark.circle.fill"
    case .failed: return "xmark.octagon.fill"
    case .running: return "circle.dotted"
    case .pending, .skipped: return "circle"
    }
  }

  private func color(_ state: SetupJournal.Step.State) -> Color {
    switch state {
    case .ok: return Palette.success
    case .failed: return Palette.error
    case .running: return Palette.text
    case .pending, .skipped: return Palette.secondary
    }
  }
}
