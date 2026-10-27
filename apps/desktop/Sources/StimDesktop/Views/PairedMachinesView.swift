import StimKit
import SwiftUI

struct PairedMachinesView: View {
  var servers: PairedServers
  @State private var pairing = false
  @State private var forgetting: PairedServers.Entry?

  var body: some View {
    Form {
      if !servers.keepsPairings {
        Section {
          Banner(tone: .warning, icon: "exclamationmark.triangle.fill") {
            Text("Pairings are not kept in this build").font(.stim(.body, weight: .semibold))
            Text(
              "This copy of Stim Desktop is not signed with the entitlement the Keychain needs, so a pairing ends when it quits."
            )
            .foregroundStyle(Palette.secondary)
          }
        }
      }
      if let error = servers.storeError {
        Section { Text(error).foregroundStyle(Palette.error).textSelection(.enabled) }
      }
      if let forgotten = servers.forgotten {
        Section {
          Banner(tone: .info, icon: "key.slash", onDismiss: servers.dismissForgotten) {
            Text("Forgot \(forgotten.name)").font(.stim(.body, weight: .semibold))
            Text(
              "Stim Desktop deleted this Mac's key for it. That does not remove this Mac from the machine's paired devices. Run this there to do that."
            )
            .foregroundStyle(Palette.secondary)
            CopyableCommand(command: forgotten.command, runsOn: forgotten.name)
          }
        }
      }
      machines
    }
    .formStyle(.grouped)
    .scrollContentBackground(.hidden)
    .background(Palette.background)
    .task { servers.start() }
    .onDisappear { servers.stop() }
    .sheet(isPresented: $pairing) { PairMachineSheet(servers: servers) }
    .onQuitRequested { pairing = false }
    .confirmationDialog(
      forgetting.map { "Forget \(name($0))?" } ?? "",
      isPresented: .init(get: { forgetting != nil }, set: { if !$0 { forgetting = nil } }),
      presenting: forgetting
    ) { entry in
      Button("Forget", role: .destructive) { servers.forget(id: entry.id) }
    } message: { entry in
      Text(
        entry.pairing == nil
          ? "Removes this item from the Keychain."
          : "Deletes this Mac's key for it from the Keychain. The machine keeps its record of this Mac until you revoke it there."
      )
    }
  }

  @ViewBuilder private var machines: some View {
    if servers.entries.isEmpty {
      Section {
        VStack(spacing: Space.lg) {
          ZStack {
            BrandHalo(size: 130)
            BrandBadge(systemImage: "server.rack", size: 64)
          }
          .accessibilityHidden(true)
          Text("No Paired Machines").font(.stim(.headline))
          Text("See the workspaces, builds and devices that another machine's stim-server owns.")
            .foregroundStyle(Palette.secondary)
            .multilineTextAlignment(.center)
          Button("Pair with a Machine\u{2026}") { pairing = true }.buttonStyle(.stim(.primary, .regular))
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, Space.xl)
      }
    } else {
      Section {
        ForEach(servers.entries) { entry in
          MachineRow(
            entry: entry, busy: servers.isPairing, reconnect: { servers.reconnect(id: entry.id) },
            forget: { forgetting = entry }
          )
        }
      } header: {
        HStack {
          Text("Paired machines")
          Spacer()
          Button("Pair with a Machine\u{2026}") { pairing = true }.buttonStyle(.stim(.primary))
        }
      }
    }
  }

  private func name(_ entry: PairedServers.Entry) -> String {
    guard let pairing = entry.pairing else { return "this item" }
    return pairing.name.isEmpty ? "the machine" : pairing.name
  }
}

private struct MachineRow: View {
  var entry: PairedServers.Entry
  var busy: Bool
  var reconnect: () -> Void
  var forget: () -> Void

  var body: some View {
    let status = entry.status
    HStack(alignment: .top, spacing: Space.lg) {
      Image(systemName: entry.pairing == nil ? "exclamationmark.triangle.fill" : "server.rack")
        .iconFont(IconSize.large).foregroundStyle(entry.pairing == nil ? Palette.warning : Palette.accent)
      VStack(alignment: .leading, spacing: Space.xs) {
        Text(verbatim: title).font(.stim(.body, weight: .semibold)).lineLimit(1)
        if let pairing = entry.pairing {
          Text(verbatim: pairing.endpoint.absoluteString)
            .font(.stim(.caption, mono: true)).foregroundStyle(Palette.secondary).lineLimit(1).truncationMode(.middle)
            .textSelection(.enabled)
        }
        Text(verbatim: "Fingerprint \(entry.id)")
          .font(.stim(.caption, mono: true)).foregroundStyle(Palette.tertiary).lineLimit(1).truncationMode(.middle)
          .textSelection(.enabled)
        HStack(spacing: Space.sm) {
          StatusDot(color: Color(status.tone), label: status.title)
          Text(status.title).font(.stim(.footnote, weight: .semibold)).foregroundStyle(Color(status.tone))
        }
        if let detail = status.detail, !detail.isEmpty {
          Text(detail).font(.stim(.footnote)).foregroundStyle(Palette.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        if let command = status.command { CopyableCommand(command: command, runsOn: entry.pairing?.name) }
      }
      Spacer()
      if let pairing = entry.pairing {
        Pill(
          PairedServerWording.access(pairing.capabilities), tone: pairing.isConfirmed ? .neutral : .warning,
          size: .small)
      }
      Menu {
        if entry.pairing != nil { Button("Reconnect", action: reconnect) }
        Button("Forget\u{2026}", role: .destructive, action: forget).disabled(busy)
      } label: {
        Image(systemName: "ellipsis.circle")
      }
      .menuStyle(.borderlessButton)
      .menuIndicator(.hidden)
      .fixedSize()
      .accessibilityLabel("More actions for \(title)")
    }
    .padding(.vertical, Space.xxs)
  }

  private var title: String {
    guard let pairing = entry.pairing else { return "Unreadable pairing" }
    return pairing.name.isEmpty ? "Unnamed machine" : pairing.name
  }
}
