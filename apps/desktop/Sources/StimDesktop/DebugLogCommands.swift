import AppKit
import StimKit
import SwiftUI

@MainActor
enum DebugLogActions {
  static func reveal() {
    DebugLog.warning(.app, "debug log revealed")
    DebugLog.flush()
    NSWorkspace.shared.activateFileViewerSelecting([DebugLog.logURL])
  }

  /// Copies the log path, versions and `stim doctor --json` to the pasteboard, redacted like the log.
  static func copyDiagnostics(cli: Task<StimCLI, Never>) {
    let last = UserDefaults.standard.string(forKey: AppPreferences.Key.lastProjectPath)
    let workspace = OpenRequests.shared.selectedWorkspace ?? (last?.isEmpty == false ? last! : NSHomeDirectory())
    Task {
      let cli = await cli.value
      let stimVersion = await cli.versionOutput()
      let serverVersion = await ServerController.shared.cli().versionOutput()
      let doctor = await cli.doctorJSONText(cwd: workspace)
      let info = Bundle.main.infoDictionary
      let size = (try? FileManager.default.attributesOfItem(atPath: DebugLog.logURL.path)[.size] as? Int) ?? 0
      let text = """
        Stim Desktop \(info?["CFBundleShortVersionString"] as? String ?? "dev") (\(info?["CFBundleVersion"] as? String ?? "0"))
        macOS \(ProcessInfo.processInfo.operatingSystemVersionString)
        stim \(trimmed(stimVersion))
        stim-server \(trimmed(serverVersion))
        Debug level: \(DebugLog.isVerbose ? "verbose" : "normal")
        Desktop log: \(DebugLog.logURL.path) (\(size) bytes)
        Stim home: \(cli.stimHome)
        stim doctor --json in \(workspace):
        \(doctor)
        """
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(DebugLogRedaction.redact(text), forType: .string)
      ToastCenter.shared.show(
        Toast(icon: "doc.on.clipboard", tone: .neutral, title: "Diagnostics copied", key: "copy-diagnostics"))
    }
  }

  private static func trimmed(_ version: String?) -> String {
    version?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "not found"
  }
}
