import AppKit
import StimKit
import StimStores
import SwiftUI

struct SetupDoctorFindings: View {
  @ObservedObject var onboarding: Onboarding
  var folder: String
  var busy: Bool
  @State private var fixing: StimCommand?
  @State private var lastFix: StimCommand?

  private var checkCommand: StimCommand { Onboarding.doctorCommand(in: folder) }
  private var folderName: String { (folder as NSString).lastPathComponent }

  var body: some View {
    let run = onboarding.guideRuns[checkCommand]
    let fix = lastFix.flatMap { $0.cwd == folder ? onboarding.guideRuns[$0] : nil }
    VStack(alignment: .leading, spacing: Space.md) {
      if let fix, fix.isRunning {
        HStack(spacing: Space.sm) {
          ProgressView().controlSize(.small)
          Text("Fixing\u{2026}")
        }
      } else if let run {
        if run.isRunning {
          HStack(spacing: Space.sm) {
            ProgressView().controlSize(.small)
            Text("Checking\u{2026}")
          }
        } else if let fix, fix.needsAttention {
          label("The fix did not finish. See the output below.", icon: "exclamationmark.triangle.fill", color: Palette.warning)
        }
        if !run.isRunning { result(run) }
        details(run: run, fix: fix)
      }
    }
    .confirmationDialog(
      "Run stim doctor --fix?", isPresented: Binding(get: { fixing != nil }, set: { if !$0 { fixing = nil } }),
      titleVisibility: .visible, presenting: fixing
    ) { command in
      Button("Run the fix") {
        lastFix = command
        onboarding.runGuide("Fix \(folderName)", command) {
          onboarding.runGuide("Check \(folderName)", checkCommand)
        }
      }
    } message: { command in
      Text("\(command.displayLine())\n\nStop native builds in this checkout first. Doctor repairs only what its report names.")
    }
  }

  @ViewBuilder private func result(_ run: ActionRun) -> some View {
    if let report = DoctorReport.decode(run.stdout), run.exitStatus == 0 {
      if report.costFindings.isEmpty {
        label(
          report.findings.isEmpty ? "All set. Doctor found nothing to change." : "All set. Doctor left some notes.",
          icon: "checkmark.circle.fill", color: Palette.success)
      } else {
        let count = report.costFindings.count
        label(
          "\(count) \(count == 1 ? "finding costs" : "findings cost") time in worktrees and builds.",
          icon: "exclamationmark.triangle.fill", color: Palette.warning)
      }
      if !report.findings.isEmpty {
        VStack(spacing: 0) {
          let ordered = report.costFindings + report.findings.filter { $0.level != "cost" }
          ForEach(Array(ordered.enumerated()), id: \.offset) { index, finding in
            if index > 0 { Rectangle().fill(Palette.border).frame(height: 1) }
            row(finding)
          }
        }
        .background(RoundedRectangle(cornerRadius: Radius.control).fill(Palette.surface))
        .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Palette.border))
      }
    } else if let error = run.launchError {
      label(error, icon: "xmark.octagon.fill", color: Palette.error)
    } else {
      label("Doctor did not finish. See the output below.", icon: "xmark.octagon.fill", color: Palette.error)
    }
  }

  private func row(_ finding: DoctorReport.Finding) -> some View {
    let costs = finding.level == "cost"
    let repair = finding.repairCommand(cwd: folder)
    let copied = doctorRemedy(finding.fix).map {
      StimCommand(Array($0.split(separator: " ").dropFirst().map(String.init)), cwd: folder).shellLine
    }
    return HStack(alignment: .top, spacing: Space.lg) {
      Image(systemName: costs ? "exclamationmark.triangle.fill" : "info.circle")
        .foregroundStyle(costs ? Palette.warning : Palette.tertiary)
        .frame(width: 18)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: Space.xs) {
        Text(finding.title).font(.stim(.callout, weight: .semibold))
        Text(costs ? "Costs time" : "Note").font(.stim(.footnote)).foregroundStyle(Palette.tertiary)
        Text(finding.detail).font(.stim(.footnote)).foregroundStyle(Palette.secondary)
        if let fix = finding.fix, !fix.isEmpty {
          Text(fix).font(.stim(.footnote)).textSelection(.enabled)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      VStack(alignment: .trailing, spacing: Space.sm) {
        if let repair {
          Button("Fix\u{2026}") { fixing = repair }
            .buttonStyle(.stim(.primary))
            .disabled(busy)
            .accessibilityLabel("Fix, \(finding.title)")
            .help(repair.displayLine())
        }
        if let text = copied ?? finding.fix, !text.isEmpty {
          Button {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
          } label: {
            Label("Copy", systemImage: "doc.on.doc")
          }
          .buttonStyle(.stim(.plain))
          .help(copied == nil ? "Copy the fix" : "Copy the command")
          .accessibilityLabel(copied == nil ? "Copy the fix, \(finding.title)" : "Copy the command, \(finding.title)")
        }
      }
    }
    .padding(Space.lg)
    .accessibilityElement(children: .contain)
  }

  private func details(run: ActionRun, fix: ActionRun?) -> some View {
    DisclosureGroup("Raw output") {
      VStack(alignment: .leading, spacing: Space.md) {
        if let fix { RunOutput(run: fix) }
        RunOutput(run: run)
        ScrollView {
          Text(String(decoding: run.stdout, as: UTF8.self))
            .font(.stim(.caption, mono: true))
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Space.md)
        }
        .frame(height: 100)
        .background(RoundedRectangle(cornerRadius: Radius.control).fill(Media.screen))
        .accessibilityLabel("Doctor JSON")
      }
      .padding(.top, Space.sm)
    }
    .font(.stim(.footnote))
    .foregroundStyle(Palette.secondary)
  }

  private func label(_ text: String, icon: String, color: Color) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
      Image(systemName: icon).foregroundStyle(color)
      Text(text)
    }
    .font(.stim(.callout))
    .accessibilityElement(children: .combine)
  }
}
