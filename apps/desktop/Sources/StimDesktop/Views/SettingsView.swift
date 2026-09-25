import AppKit
import StimKit
import SwiftUI

struct SettingsView: View {
  @ObservedObject var store: StatusStore
  @StateObject private var model: SettingsModel
  @ObservedObject private var openRequests = OpenRequests.shared
  @State private var workspace: String?
  @AppStorage("settingsTab") private var tab = "app"
  @AppStorage("settingsWorkspace") private var lastWorkspace = ""

  init(cli: Task<StimCLI, Never>, store: StatusStore) {
    self.store = store
    _model = StateObject(wrappedValue: SettingsModel(cli: cli))
  }

  var body: some View {
    TabView(selection: $tab) {
      AppPreferencesView()
        .tabItem { Label("App", systemImage: "macwindow") }
        .tag("app")
      PhonesView(server: ServerController.shared)
        .tabItem { Label("Phones", systemImage: "iphone.gen3.radiowaves.left.and.right") }
        .tag("phones")
      scopeTab(.machine, title: "Machine", icon: "desktopcomputer")
      scopeTab(.repo, title: "Repository", icon: "folder")
      scopeTab(.workspace, title: "Workspace", icon: "square.stack.3d.up")
      scopeTab(.committed, title: ".stim.json", icon: "doc.text")
    }
    .frame(width: 780, height: 640)
    .font(Theme.body())
    .foregroundStyle(Theme.text)
    .tint(Theme.purple)
    .onAppear {
      workspace = openRequests.selectedWorkspace ?? workspace ?? (lastWorkspace.isEmpty ? nil : lastWorkspace)
      model.load(directory: workspace)
    }
    .onChange(of: workspace) { _, path in
      lastWorkspace = path ?? ""
      model.load(directory: path)
    }
  }

  private func scopeTab(_ scope: SettingScope, title: String, icon: String) -> some View {
    ScopeSettingsView(scope: scope, model: model, workspace: $workspace, workspaces: workspacePaths)
      .tabItem { Label(title, systemImage: icon) }
      .tag(scope.rawValue)
  }

  private var workspacePaths: [String] {
    var paths = (store.payload?.environments ?? []).map(\.path)
    if let workspace, !paths.contains(workspace) { paths.insert(workspace, at: 0) }
    return paths
  }
}

private struct ScopeSettingsView: View {
  var scope: SettingScope
  @ObservedObject var model: SettingsModel
  @Binding var workspace: String?
  var workspaces: [String]

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      header
      Rectangle().fill(Theme.border).frame(height: 1)
      content
    }
    .background(Theme.background)
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 6) {
      if scope != .machine {
        HStack {
          Picker("Workspace", selection: $workspace) {
            Text("None").tag(String?.none)
            ForEach(workspaces, id: \.self) { path in
              Text("\(PathNames(path: path).title) \u{2014} \(abbreviatingHome(path))")
                .tag(String?.some(path))
            }
          }
          Button("Choose\u{2026}", action: chooseWorkspace)
        }
      }
      if let file = model.payload?.file(for: scope) {
        Text(abbreviatingHome(file))
          .font(Theme.mono())
          .foregroundStyle(Theme.secondary)
          .textSelection(.enabled)
      }
      Text(caption).font(Theme.body(11.5)).foregroundStyle(Theme.tertiary)
    }
    .padding(16)
  }

  private var caption: String {
    switch scope {
    case .machine: return "Machine settings in the Stim config, and machine defaults for the optimizations."
    case .repo: return "Settings for every worktree of this repository, kept in the Stim config."
    case .workspace: return "Settings for this workspace only, kept in the Stim config. They win over every other layer."
    case .committed:
      return "The app's committed .stim.json. worktree.* settings are read from the repository root's .stim.json."
    }
  }

  @ViewBuilder private var content: some View {
    if let error = model.schemaError ?? model.loadError {
      EmptyState(title: "Settings unavailable", message: error)
    } else if model.payload == nil || model.fields.isEmpty {
      ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
    } else if scope != .machine && model.payload?.file(for: scope) == nil {
      EmptyState(
        title: "No workspace selected",
        message: "Pick a workspace above, or choose a project directory, to edit its \(scope.rawValue) settings.")
    } else {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 0) {
          ForEach(model.fields(in: scope)) { field in
            SettingRow(field: field, scope: scope, model: model)
            Rectangle().fill(Theme.border).frame(height: 1)
          }
          unknown
        }
        .padding(.horizontal, 16)
      }
    }
  }

  @ViewBuilder private var unknown: some View {
    let entries = model.payload?.unknown.filter { $0.scope == scope } ?? []
    if !entries.isEmpty {
      VStack(alignment: .leading, spacing: 8) {
        SectionLabel(title: "Not read by Stim")
        ForEach(entries, id: \.self) { entry in
          HStack(alignment: .firstTextBaseline) {
            Text(entry.key).font(Theme.mono(12))
            Text(abbreviatingHome(entry.value?.display ?? "")).font(Theme.mono()).foregroundStyle(Theme.secondary).lineLimit(1)
            Spacer()
            Text(abbreviatingHome(entry.file))
              .font(Theme.body(11)).foregroundStyle(Theme.tertiary).lineLimit(1).truncationMode(.head)
          }
        }
      }
      .padding(.vertical, 16)
    }
  }

  private func chooseWorkspace() {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.prompt = "Choose"
    panel.message = "Choose the app directory, the one holding package.json."
    if panel.runModal() == .OK, let url = panel.url { workspace = url.path }
  }
}

private struct SettingRow: View {
  var field: SettingField
  var scope: SettingScope
  @ObservedObject var model: SettingsModel

  private var entry: SettingEntry? { model.payload?.entry(field.key) }
  private var layerValue: JSONValue? { entry?.layer(scope) }
  private var id: String { SettingsModel.id(field.key, scope) }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(field.key).font(Theme.mono(12)).foregroundStyle(Theme.text)
        if field.sensitive { Chip(tint: Theme.warn) { Text("sensitive") } }
        Spacer()
        if model.writing.contains(id) { ProgressView().controlSize(.small) }
        if layerValue != nil {
          Button("Reset") { model.write(field, scope: scope, value: nil) }
            .buttonStyle(.stim())
            .help("stim settings unset \(field.key) --scope \(scope.rawValue)")
        }
      }
      if !field.description.isEmpty {
        Text(field.description).font(Theme.body(12)).foregroundStyle(Theme.secondary)
      }
      SettingEditor(field: field, value: layerValue, effective: entry?.value == .null ? nil : entry?.value) { value in
        model.write(field, scope: scope, value: value)
      }
      .disabled(model.writing.contains(id))
      facts
      if let refusal = model.refusals[id] {
        Text(abbreviatingHome(refusal)).font(Theme.body(11.5)).foregroundStyle(Theme.error).textSelection(.enabled)
      }
    }
    .padding(.vertical, 12)
  }

  @ViewBuilder private var facts: some View {
    HStack(spacing: 12) {
      if let entry {
        if let origin = entry.origin {
          Text(abbreviatingHome("Effective: \(entry.value.display) from \(origin)"))
        } else {
          Text("Not set")
        }
        if let lower = entry.overridden(by: scope, field: field) {
          Text(abbreviatingHome(layerValue == nil ? "Setting it here overrides \(lower.source): \(lower.value.display)"
            : "Overrides \(lower.source): \(lower.value.display)"))
        }
        if let env = entry.env {
          Text(abbreviatingHome("\(env.name)=\(env.value) in the environment wins")).foregroundStyle(Theme.warn)
        }
      }
    }
    .font(Theme.body(11))
    .foregroundStyle(Theme.tertiary)
    .lineLimit(1)
    .truncationMode(.middle)
  }
}

private struct SettingEditor: View {
  var field: SettingField
  var value: JSONValue?
  var effective: JSONValue?
  var commit: (JSONValue) -> Void
  @State private var draft = ""

  var body: some View {
    editor
      .onAppear { draft = text(value) }
      .onChange(of: value) { _, new in draft = text(new) }
  }

  @ViewBuilder private var editor: some View {
    switch field.control {
    case .picker(let choices):
      Picker("", selection: Binding(get: { value?.string ?? "" }, set: { commit(.string($0)) })) {
        if value == nil { Text("Not set").tag("") }
        ForEach(choices, id: \.self) { Text($0).tag($0) }
      }
      .labelsHidden()
      .frame(maxWidth: 260, alignment: .leading)
    case .toggle:
      Toggle(
        "Enabled",
        isOn: Binding(get: { value?.bool ?? effective?.bool ?? false }, set: { commit(.bool($0)) }))
    case .stepper(let minimum, let maximum, let integer):
      HStack {
        TextField(placeholder, text: $draft).frame(width: 100).onSubmit(commitNumber)
        Stepper(
          "",
          onIncrement: { step(1, minimum: minimum, maximum: maximum) },
          onDecrement: { step(-1, minimum: minimum, maximum: maximum) }
        )
        .labelsHidden()
        if let minimum, let maximum {
          Text("\(format(minimum))\u{2013}\(format(maximum))").foregroundStyle(Theme.tertiary)
        } else if integer, let minimum {
          Text("\(format(minimum)) or more").foregroundStyle(Theme.tertiary)
        }
      }
    case .filePicker:
      HStack {
        TextField(placeholder, text: $draft).onSubmit { commitText() }
        Button("Choose\u{2026}", action: choosePath)
      }
    case .tokens:
      TokenField(tokens: value?.strings ?? []) { commit(.array($0.map(JSONValue.string))) }
        .frame(height: 24)
    case .json:
      VStack(alignment: .leading, spacing: 6) {
        TextEditor(text: $draft)
          .font(Theme.mono())
          .frame(height: 64)
          .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(Theme.border))
        Button("Apply") {
          if let data = draft.data(using: .utf8), let parsed = try? JSONDecoder().decode(JSONValue.self, from: data) {
            commit(parsed)
          } else {
            commit(.string(draft))
          }
        }
        .buttonStyle(.stim(.primary))
      }
    case .secure:
      HStack {
        SecureField(value == nil ? "Not set" : "Hidden; type to replace", text: $draft).onSubmit { commitText() }
        Button("Set") { commitText() }
          .buttonStyle(.stim(.primary))
          .disabled(draft.isEmpty)
      }
    case .text:
      TextField(placeholder, text: $draft).onSubmit { commitText() }
    }
  }

  private var placeholder: String {
    effective.map { "Inherits \($0.display)" } ?? "Not set"
  }

  private func text(_ value: JSONValue?) -> String {
    guard let value, !field.sensitive else { return "" }
    if case .object = value {
      let data = (try? JSONEncoder.pretty.encode(value)) ?? Data()
      return String(decoding: data, as: UTF8.self)
    }
    return value.display
  }

  private func commitText() {
    guard !draft.isEmpty else { return }
    commit(.string(draft))
    if field.sensitive { draft = "" }
  }

  private func commitNumber() {
    guard let number = Double(draft) else {
      commit(.string(draft))
      return
    }
    commit(.number(number))
  }

  private func step(_ delta: Double, minimum: Double?, maximum: Double?) {
    let current = Double(draft) ?? value?.number ?? effective?.number ?? minimum ?? 0
    var next = current + delta
    if let minimum { next = max(minimum, next) }
    if let maximum { next = min(maximum, next) }
    commit(.number(next))
  }

  private func format(_ number: Double) -> String { JSONValue.number(number).json }

  private func choosePath() {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = true
    panel.prompt = "Choose"
    guard panel.runModal() == .OK, let url = panel.url else { return }
    commit(.string(url.path))
  }
}

extension JSONEncoder {
  fileprivate static let pretty: JSONEncoder = {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    return encoder
  }()
}

/// An `NSTokenField` whose tokens are committed when editing ends.
private struct TokenField: NSViewRepresentable {
  var tokens: [String]
  var commit: ([String]) -> Void

  final class Coordinator: NSObject, NSTokenFieldDelegate {
    var parent: TokenField
    init(_ parent: TokenField) { self.parent = parent }

    func controlTextDidEndEditing(_ notification: Notification) {
      guard let field = notification.object as? NSTokenField else { return }
      let tokens = (field.objectValue as? [String]) ?? []
      if tokens != parent.tokens { parent.commit(tokens) }
    }
  }

  func makeCoordinator() -> Coordinator { Coordinator(self) }

  func makeNSView(context: Context) -> NSTokenField {
    let field = NSTokenField()
    field.delegate = context.coordinator
    field.placeholderString = "Type a value and press Return"
    field.objectValue = tokens
    return field
  }

  func updateNSView(_ field: NSTokenField, context: Context) {
    context.coordinator.parent = self
    if field.currentEditor() == nil { field.objectValue = tokens }
  }
}
