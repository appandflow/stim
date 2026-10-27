import StimKit
import SwiftUI

struct PairMachineSheet: View {
  var servers: PairedServers
  @Environment(\.dismiss) private var dismiss
  @State private var text = ""
  @State private var task: Task<Void, Never>?

  private enum Reading {
    case empty
    case payload(PairingPayload)
    case problem(PairedServerNotice)
  }

  private var reading: Reading {
    if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return .empty }
    do {
      return .payload(try PairingPayload.parse(text))
    } catch {
      return .problem(PairedServerWording.notice(for: (error as? PairingPayload.Problem) ?? .notAPairingCode))
    }
  }

  var body: some View {
    VStack(spacing: 0) {
      ScrollView {
        VStack(alignment: .leading, spacing: Space.lg) {
          Text("Pair with a Machine").font(.stim(.title))
          if case .paired(let pairing) = servers.pairingState {
            paired(pairing)
          } else {
            form
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Space.xxl)
      }
      Divider()
      footer.padding(Space.xl)
    }
    .frame(width: 560, height: 640)
    .font(.stim(.body)).foregroundStyle(Palette.text).tint(Palette.primary)
    .background(Palette.background)
    .onAppear { servers.dismissPairing() }
    .onDisappear {
      task?.cancel()
      servers.dismissPairing()
    }
    .onQuitRequested {
      task?.cancel()
      dismiss()
    }
  }

  @ViewBuilder private var form: some View {
    Text("On the machine, run this and paste everything it prints. The code works once, for 5 minutes.")
      .foregroundStyle(Palette.secondary).fixedSize(horizontal: false, vertical: true)
    CopyableCommand(command: "stim-server pair", runsOn: "the machine")
    TextEditor(text: $text)
      .font(.stim(.caption, mono: true))
      .frame(height: 110)
      .overlay(RoundedRectangle(cornerRadius: Radius.small).strokeBorder(Palette.border))
      .disabled(servers.isPairing)
      .accessibilityLabel("Pairing code")
    switch reading {
    case .empty: EmptyView()
    case .problem(let notice): noticeView(notice)
    case .payload(let payload): summary(payload)
    }
    if case .failed(let notice) = servers.pairingState { noticeView(notice) }
    if !servers.keepsPairings {
      Text("Pairings are not kept in this build: this one ends when Stim Desktop quits.")
        .font(.stim(.footnote)).foregroundStyle(Palette.warning)
    }
    Text(
      "A pairing lets this Mac see what the machine's server shows a phone: workspace paths, status and logs, changed files including .env files, the doctor report and the live screens of its devices. A code from a plain stim-server pair can only read."
    )
    .font(.stim(.footnote)).foregroundStyle(Palette.tertiary).fixedSize(horizontal: false, vertical: true)
  }

  private func summary(_ payload: PairingPayload) -> some View {
    VStack(alignment: .leading, spacing: Space.sm) {
      fact("Name", payload.name.isEmpty ? "Not named" : payload.name)
      fact("Endpoint", payload.endpoint.absoluteString, mono: true)
      fact("Fingerprint", payload.fingerprint, mono: true)
      Text("Desktop pairs only with the machine whose key has this fingerprint.")
        .font(.stim(.footnote)).foregroundStyle(Palette.tertiary)
    }
    .padding(Space.lg)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Palette.surface, in: RoundedRectangle(cornerRadius: Radius.card))
    .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Palette.border))
  }

  private func fact(_ label: String, _ value: String, mono: Bool = false) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: Space.md) {
      Text(label).font(.stim(.callout)).foregroundStyle(Palette.secondary).frame(width: 84, alignment: .leading)
      Text(verbatim: value).font(.stim(.callout, mono: mono)).textSelection(.enabled)
        .lineLimit(2).truncationMode(.middle)
    }
  }

  private func noticeView(_ notice: PairedServerNotice) -> some View {
    Banner(tone: notice.tone, icon: notice.tone == .error ? "xmark.octagon.fill" : "exclamationmark.triangle.fill") {
      Text(notice.title).font(.stim(.body, weight: .semibold))
      Text(notice.detail).foregroundStyle(Palette.secondary).fixedSize(horizontal: false, vertical: true)
      if let command = notice.command { CopyableCommand(command: command, runsOn: "the machine") }
    }
  }

  private func paired(_ pairing: PairedServer) -> some View {
    VStack(alignment: .leading, spacing: Space.lg) {
      Label("Paired with \(pairing.name.isEmpty ? "the machine" : pairing.name)", systemImage: "checkmark.circle.fill")
        .font(.stim(.headline)).foregroundStyle(Palette.success)
      VStack(alignment: .leading, spacing: Space.sm) {
        fact("Access", PairedServerWording.access(pairing.capabilities))
        fact("Endpoint", pairing.endpoint.absoluteString, mono: true)
        fact("Fingerprint", pairing.id, mono: true)
      }
      if !servers.keepsPairings {
        Text("Pairings are not kept in this build: this one ends when Stim Desktop quits.")
          .font(.stim(.footnote)).foregroundStyle(Palette.warning)
      }
    }
  }

  private var footer: some View {
    HStack(spacing: Space.md) {
      if servers.isPairing {
        ProgressView().controlSize(.small)
        Text("Pairing\u{2026}").foregroundStyle(Palette.secondary)
      }
      Spacer()
      if case .paired = servers.pairingState {
        Button("Done") { dismiss() }.buttonStyle(.stim(.primary)).keyboardShortcut(.defaultAction)
      } else {
        Button("Cancel") {
          task?.cancel()
          dismiss()
        }
        .buttonStyle(.stim()).keyboardShortcut(.cancelAction)
        Button("Pair") { task = Task { await servers.pair(text) } }
          .buttonStyle(.stim(.primary)).keyboardShortcut(.defaultAction)
          .disabled(servers.isPairing || !isReadable)
      }
    }
  }

  private var isReadable: Bool {
    if case .payload = reading { return true }
    return false
  }
}
