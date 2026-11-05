import StimKit
import SwiftUI

/// A running simulator or emulator the person chose to share.
struct ShareRequest: Identifiable, Equatable {
  var workspace: String
  var platform: String
  var slot: String
  var id: String { "\(workspace)|\(platform)|\(slot)" }
}

/// Creates a web share of one device with the options of `stim share`, then shows its link and password once.
struct ShareDeviceSheet: View {
  var request: ShareRequest
  var showShares: () -> Void
  var model: WebSharesModel = .shared
  @Environment(\.dismiss) private var dismiss
  @Environment(\.workspaceTitle) private var workspaceTitle
  @State private var options = WebShareOptions()
  @State private var kind = PasswordKind.generated
  @State private var custom = ""
  @State private var viewKind = ViewKind.off
  @State private var viewCustom = ""
  @State private var starting = false
  @State private var failure: String?
  @State private var started: StartedWebShare?

  private enum PasswordKind: String, CaseIterable {
    case generated = "Generated"
    case custom = "Choose"
    case none = "None"
  }

  private enum ViewKind: String, CaseIterable {
    case off = "Off"
    case generated = "Generated"
    case custom = "Choose"
  }

  private static let expiries: [(minutes: Int, label: String)] = [
    (15, "15 minutes"), (30, "30 minutes"), (60, "1 hour"), (120, "2 hours"), (240, "4 hours"), (480, "8 hours"),
  ]

  private var platformName: String { request.platform == "ios" ? "iOS" : "Android" }

  var body: some View {
    VStack(spacing: 0) {
      if let started { result(started) } else { form }
    }
    .frame(width: 480)
    .font(.stim(.body)).foregroundStyle(Palette.text).tint(Palette.primary)
    .background(Palette.background)
    .onQuitRequested { dismiss() }
  }

  private var form: some View {
    VStack(spacing: 0) {
      Form {
        Section {
          Text("Anyone with the link can open this device in a browser, from the internet, until the share ends.")
            .foregroundStyle(Palette.secondary)
        } header: {
          Text("Share \(platformName) of \(workspaceTitle(request.workspace))").font(.stim(.headline))
        }
        Section {
          Toggle("Let viewers tap, type and press buttons", isOn: $options.control)
          Picker("Expires after", selection: $options.minutes) {
            ForEach(Self.expiries, id: \.minutes) { Text($0.label).tag($0.minutes) }
          }
          Picker("Password", selection: $kind) {
            ForEach(PasswordKind.allCases, id: \.self) { Text($0.rawValue).tag($0) }
          }
          .pickerStyle(.segmented)
          if kind == .custom {
            SecureField("Password", text: $custom, prompt: Text("8 to 128 characters"))
          }
          if offersViewPassword {
            Picker("View-only password", selection: $viewKind) {
              ForEach(ViewKind.allCases, id: \.self) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            if viewKind == .custom {
              SecureField("View-only password", text: $viewCustom, prompt: Text("8 to 128 characters"))
            }
          }
        } footer: {
          Text(passwordNote).foregroundStyle(kind == .none ? Palette.warning : Palette.tertiary)
        }
        if let failure {
          Section { Text(failure).foregroundStyle(Palette.error).textSelection(.enabled) }
        }
      }
      .formStyle(.grouped)
      .scrollContentBackground(.hidden)
      Divider()
      HStack {
        if starting { ProgressView().controlSize(.small) }
        Spacer()
        Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction).buttonStyle(.stim())
        Button("Share", action: start)
          .keyboardShortcut(.defaultAction).buttonStyle(.stim(.primary))
          .disabled(starting || problem != nil)
      }
      .padding(Space.xl)
    }
  }

  /// A separate view-only password makes sense only for a share that has control and a password.
  private var offersViewPassword: Bool { model.offersViewPassword && options.control && kind != .none }

  private var passwordNote: String {
    if offersViewPassword && viewKind != .off {
      return "The first password controls the device; the view-only one only watches. Stim shows generated passwords once."
    }
    return switch kind {
    case .generated: "Stim generates a password and shows it once. Send it to viewers separately from the link."
    case .custom: "Stim never shows this password again and does not keep it."
    case .none:
      "No password: anyone with the link can \(options.control ? "watch and control" : "watch") the device until it expires."
    }
  }

  private var chosen: WebShareOptions {
    var chosen = options
    switch kind {
    case .generated: chosen.password = .generated
    case .custom: chosen.password = .custom(custom)
    case .none: chosen.password = .none
    }
    switch viewKind {
    case .off: chosen.viewPassword = .off
    case .generated: chosen.viewPassword = .generated
    case .custom: chosen.viewPassword = .custom(viewCustom)
    }
    if !offersViewPassword { chosen.viewPassword = .off }
    return chosen
  }

  private var problem: String? {
    if kind == .custom && custom.isEmpty { return "Enter a password." }
    if offersViewPassword && viewKind == .custom && viewCustom.isEmpty { return "Enter a view-only password." }
    return chosen.problem
  }

  private func start() {
    guard problem == nil, !starting else { return }
    starting = true
    failure = nil
    let choices = chosen
    Task {
      defer { starting = false }
      do {
        started = try await model.start(
          workspace: request.workspace, platform: request.platform, slot: request.slot, options: choices)
        custom = ""
        viewCustom = ""
      } catch {
        failure = error.localizedDescription
      }
    }
  }

  private func result(_ started: StartedWebShare) -> some View {
    VStack(spacing: 0) {
      Form {
        Section {
          secretRow("Link", value: started.url)
          let controlTitle = started.share.viewAuth == nil ? "Password" : "Control password"
          switch started.share.auth {
          case .generated:
            secretRow(controlTitle, value: started.password ?? "")
          case .set:
            LabeledContent(controlTitle, value: "The one you chose")
          case .none:
            LabeledContent(controlTitle, value: "None")
          }
          switch started.share.viewAuth {
          case .generated: secretRow("View password", value: started.viewPassword ?? "")
          case .set: LabeledContent("View password", value: "The one you chose")
          case nil: EmptyView()
          }
        } header: {
          Text("Shared \(platformName) of \(workspaceTitle(request.workspace))").font(.stim(.headline))
        } footer: {
          Text(resultNote(started)).foregroundStyle(started.share.auth == .none ? Palette.warning : Palette.tertiary)
        }
        Section {
          LabeledContent("Access", value: started.share.accessLabel)
          LabeledContent("Time left", value: started.share.timeLeft().replacingOccurrences(of: " left", with: ""))
        }
      }
      .formStyle(.grouped)
      .scrollContentBackground(.hidden)
      Divider()
      HStack {
        Button("Show Active Shares") {
          dismiss()
          showShares()
        }
        .buttonStyle(.stim())
        Spacer()
        Button("Done") { dismiss() }.keyboardShortcut(.defaultAction).buttonStyle(.stim(.primary))
      }
      .padding(Space.xl)
    }
  }

  private func resultNote(_ started: StartedWebShare) -> String {
    if started.share.viewAuth != nil {
      return
        "Anyone with the link and a password can open it until it ends. Generated passwords are shown only now: Stim Desktop does not keep them."
    }
    return switch started.share.auth {
    case .generated:
      "Anyone with both can open it until it ends. The password is shown only now: Stim Desktop does not keep it."
    case .set: "Anyone with the link and your password can open it until it ends."
    case .none: "Anyone with the link can open it until it ends."
    }
  }

  private func secretRow(_ title: String, value: String) -> some View {
    LabeledContent(title) {
      HStack(spacing: Space.sm) {
        Text(verbatim: value).font(.stim(.callout, mono: true)).textSelection(.enabled).lineLimit(2)
          .truncationMode(.middle)
        CopyButton(value, accessibilityLabel: "Copy \(title.lowercased())")
      }
    }
  }
}
