import StimKit
import SwiftUI

/// The host side of this Mac: other Macs approved, or asking, to build or run devices here, and the sessions they
/// run here now. Shown on the Build Machines tab only while there is something to list.
struct ThisMacAccessSections: View {
  var clients: [PairedDevice]
  var sessions: [HostedSession]
  var stopping: Set<String>
  var review: (PairedDevice) -> Void
  var revoke: (PairedDevice) -> Void
  var stop: (HostedSession) -> Void

  static func shows(clients: [PairedDevice], sessions: [HostedSession]) -> Bool {
    !clients.isEmpty || !sessions.isEmpty
  }

  var body: some View {
    if !clients.isEmpty {
      Section("Macs using this Mac") {
        ForEach(clients) { device in
          BuildClientRow(device: device, review: { review(device) }, revoke: { revoke(device) })
        }
      }
    }
    if !sessions.isEmpty {
      Section("Running here") {
        ForEach(sessions) { session in
          HostedSessionRow(session: session, stopping: stopping.contains(session.id)) { stop(session) }
        }
      }
    }
  }
}

struct BuildClientRow: View {
  var device: PairedDevice
  var review: () -> Void
  var revoke: () -> Void

  var body: some View {
    HStack(spacing: Space.lg) {
      Image(systemName: "desktopcomputer").iconFont(IconSize.large).foregroundStyle(Palette.accent)
      VStack(alignment: .leading, spacing: Space.xxs) {
        HStack(spacing: Space.sm) {
          Text(verbatim: device.name).font(.stim(.body, weight: .semibold)).lineLimit(1)
          if device.pendingUntil != nil {
            Pill("Waiting for you", tone: .warning, size: .small)
          } else {
            Pill(device.isDeviceHostClient ? "Approved for devices" : "Can build", tone: .success, size: .small)
          }
        }
        Text(verbatim: device.node).font(.stim(.caption))
          .foregroundStyle(Palette.secondary)
          .lineLimit(1)
          .truncationMode(.middle)
      }
      Spacer()
      Text(detail).font(.stim(.footnote)).foregroundStyle(Palette.secondary)
      if device.pendingUntil != nil {
        Button("Review\u{2026}", action: review)
        Button("Deny", role: .destructive, action: revoke)
      } else {
        Button("Revoke", role: .destructive, action: revoke)
      }
    }
    .padding(.vertical, Space.xxs)
  }

  private var detail: String {
    if let until = device.pendingUntil { return "Lapses \(until.formatted(.relative(presentation: .named)))" }
    guard let at = device.lastSeenAt else { return device.isDeviceHostClient ? "Never connected" : "Never built" }
    return "Seen \(at.formatted(.relative(presentation: .named)))"
  }
}

struct HostedSessionRow: View {
  var session: HostedSession
  var stopping: Bool
  var stop: () -> Void

  var body: some View {
    HStack(spacing: Space.lg) {
      VStack(alignment: .leading, spacing: Space.xxs) {
        HStack(spacing: Space.sm) {
          Text(verbatim: session.client.name).font(.stim(.body, weight: .semibold))
          Pill(stopping ? "Stopping" : session.stateLabel, tone: tone, size: .small)
        }
        Text(verbatim: [session.device, session.app].compactMap { $0 }.joined(separator: " \u{00B7} "))
          .font(.stim(.caption))
          .foregroundStyle(Palette.secondary)
        Text(session.sinceText()).font(.stim(.footnote)).foregroundStyle(Palette.tertiary)
      }
      Spacer()
      if !session.parked, session.state != .stopped {
        Button("Stop", role: .destructive, action: stop)
          .disabled(stopping || session.state == .stopping)
      }
    }
    .padding(.vertical, Space.xxs)
  }

  private var tone: Tone {
    if stopping || session.parked { return .neutral }
    switch session.state {
    case .ready: return .success
    case .unknown: return .warning
    default: return .neutral
    }
  }
}
