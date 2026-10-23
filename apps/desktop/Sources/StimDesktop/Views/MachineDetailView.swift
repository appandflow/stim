import StimKit
import SwiftUI

/// One remote machine's page in Settings > Remote Machines: why this Mac can or cannot use it, every problem and note
/// by platform with the command that fixes it, its capacity, versions and approvals, and the switches that decide
/// which work goes to it.
struct MachineDetailPage<Toggles: View>: View {
  var entry: String
  var detail: MachineDetail
  var status: BuildMachineStatus?
  var capabilities: [String]
  var working: Bool
  var progress: String?
  var canAsk: Bool
  var hosted: [HostedOnMachine]
  var builds: [LedgerBuild]
  var buildsNote: String
  var update: MachineUpdatePhase?
  var install: StimInstall?
  var back: () -> Void
  var ask: () -> Void
  var startUpdate: () -> Void
  var stopHosted: ([HostedOnMachine]) -> Void
  var remove: () -> Void
  var showsToggles: Bool
  var toggles: Toggles

  var body: some View {
    Form {
      Section { header }
      if let situation = detail.situation {
        Section("Status") { MachineSituationView(situation: situation, machine: entry) }
      }
      if update != nil || install != nil {
        Section("Stim version") {
          VStack(alignment: .leading, spacing: Space.sm) {
            MachineUpdateLine(machine: entry, phase: update, install: install, update: startUpdate)
            if case .waiting(_, let sessions)? = update, sessions > 0 {
              WaitingSessions(machine: entry, sessions: sessions, hosted: hosted, stop: stopHosted)
            }
          }
        }
      }
      if detail.situation == nil {
        if detail.groups.isEmpty, detail.androidMessage == nil, status != nil {
          Section("Problems and Notes") {
            Text("Nothing to fix.").foregroundStyle(Palette.secondary)
          }
        }
        ForEach(detail.groups) { group in
          Section(group.platform.title) {
            ForEach(group.issues) { MachineIssueRow(issue: $0, machine: entry) }
            if group.platform == .android, let message = detail.androidMessage { androidMessage(message) }
          }
        }
        if !detail.groups.contains(where: { $0.platform == .android }), let message = detail.androidMessage {
          Section(MachinePlatform.android.title) { androidMessage(message) }
        }
      }
      if !detail.capacity.isEmpty { rows("Capacity", detail.capacity) }
      if !detail.versions.isEmpty { rows("Versions", detail.versions) }
      if !detail.approvals.isEmpty { rows("Approvals", detail.approvals) }
      MachineBuildsSection(builds: builds, note: buildsNote)
      if showsToggles { Section("Use This Machine For") { toggles } }
    }
    .formStyle(.grouped)
    .scrollContentBackground(.hidden)
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: Space.lg) {
      Button(action: back) {
        Label("Remote Machines", systemImage: "chevron.left").font(.stim(.callout))
      }
      .buttonStyle(.plain)
      .foregroundStyle(Palette.accent)
      HStack(alignment: .center, spacing: Space.lg) {
        Image(systemName: "desktopcomputer").font(.system(size: 18)).foregroundStyle(Palette.accent)
          .frame(width: 24).accessibilityHidden(true)
        VStack(alignment: .leading, spacing: Space.xs) {
          HStack(spacing: Space.sm) {
            Text(verbatim: entry).font(.stim(.headline, weight: .semibold)).lineLimit(1).textSelection(.enabled)
            if let pill = detail.pill {
              Pill(pill.title, tone: pill.tone, size: .small).help(status?.readiness.reasons ?? status?.detail ?? "")
            }
          }
          if let identity = status?.identityLine {
            Text(verbatim: identity).font(.stim(.footnote)).foregroundStyle(Palette.tertiary).textSelection(.enabled)
          }
          HStack(spacing: Space.xs) {
            ForEach(capabilities, id: \.self) { name in
              Pill(tone: .neutral, size: .small, outlined: true) { Text(verbatim: name) }
            }
          }
        }
        Spacer(minLength: 0)
        if working {
          if let progress { Text(verbatim: progress).font(.stim(.footnote)).foregroundStyle(Palette.secondary) }
          ProgressView().controlSize(.small)
        }
        if let status, status.state.canAsk(requested: status.requestedAt != nil) {
          Button(status.state == .notAsked ? "Ask" : "Ask Again", action: ask).disabled(working || !canAsk)
        }
        Button("Remove\u{2026}", action: remove)
          .buttonStyle(.stim(.secondary))
          .fixedSize()
          .disabled(working || (status?.state == .keyChanged && !canAsk))
          .accessibilityLabel("Remove \(entry)")
      }
    }
    .padding(.vertical, Space.sm)
  }

  private func androidMessage(_ message: String) -> some View {
    HStack(spacing: Space.md) {
      if message.hasPrefix("Checking") { ProgressView().controlSize(.mini) }
      Text(verbatim: message).font(.stim(.footnote)).foregroundStyle(Palette.secondary).textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private func rows(_ title: String, _ rows: [MachineDetailRow]) -> some View {
    Section(title) {
      ForEach(rows) { row in
        LabeledContent(row.label) {
          Text(verbatim: row.value).foregroundStyle(row.tone == .normal ? Palette.text : Color(row.tone))
            .textSelection(.enabled)
        }
      }
    }
  }
}

/// A diagnosis layer or pairing state that stops this Mac using the machine: what failed, what to do, and each command
/// to run.
struct MachineSituationView: View {
  var situation: MachineSituation
  var machine: String

  var body: some View {
    VStack(alignment: .leading, spacing: Space.sm) {
      Text(verbatim: situation.title).font(.stim(.body, weight: .semibold)).foregroundStyle(Color(situation.tone))
      Text(verbatim: situation.message).font(.stim(.footnote)).foregroundStyle(Palette.secondary)
        .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
      if let remedy = situation.remedy {
        Text(verbatim: remedy).font(.stim(.footnote)).foregroundStyle(Palette.secondary)
          .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
      }
      ForEach(situation.commands, id: \.self) { CopyableCommand(command: $0, runsOn: machine) }
    }
  }
}

/// A problem or note of a machine, with its fix text and a copyable command for each command.
struct MachineIssueRow: View {
  var issue: MachineIssue
  var machine: String

  var body: some View {
    VStack(alignment: .leading, spacing: Space.sm) {
      HStack(spacing: Space.sm) {
        Image(systemName: issue.kind == .note ? "info.circle" : "exclamationmark.triangle.fill")
          .foregroundStyle(issue.kind == .note ? Palette.secondary : Palette.warning)
          .accessibilityHidden(true)
        Text(verbatim: issue.title).font(.stim(.body, weight: .semibold))
        Pill(issue.kind == .note ? "Note" : "Problem", tone: issue.kind == .note ? .neutral : .warning, size: .small)
      }
      Text(verbatim: issue.reason).font(.stim(.footnote)).foregroundStyle(Palette.secondary)
        .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
      if let fix = issue.fix {
        ForEach(Array(fix.text.enumerated()), id: \.offset) { _, line in
          Text(verbatim: line).font(.stim(.footnote)).foregroundStyle(Palette.secondary)
            .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
        }
        ForEach(fix.commands, id: \.self) { CopyableCommand(command: $0, runsOn: machine) }
      }
    }
    .padding(.vertical, Space.xs)
  }
}
