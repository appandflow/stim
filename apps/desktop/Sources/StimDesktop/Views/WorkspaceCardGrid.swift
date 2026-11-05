import StimKit
import StimStores
import SwiftUI

@MainActor
final class WorkspaceCardChoices: ObservableObject {
  static let shared = WorkspaceCardChoices()

  @Published private(set) var choices: [String: String] = [:]

  func choose(_ optionID: String, for card: String) {
    choices[card] = optionID
  }

  func adopt(_ optionID: String, for card: String) {
    if choices[card] == nil { choices[card] = optionID }
  }
}

extension WallCard {
  /// Where a card opens: a paired machine's workspace opens on its own screen; nil for this Mac's.
  var pairedDestination: SidebarItem? {
    owner.isLocal ? nil : .pairedWorkspace(WorkspaceKey(owner: owner, path: apps[0].workspace.path))
  }
}

struct WorkspaceCardGrid: View {
  var cards: [WallCard]
  @ObservedObject var store: StatusStore
  var metrics: MetricsStore
  var open: (WallCard) -> Void
  var openDevice: (WorkspaceKey, String) -> Void
  var openLogs: (String) -> Void
  @State private var width: CGFloat = 1000

  var body: some View {
    let columns = Array(
      repeating: GridItem(.flexible(), spacing: Space.xl, alignment: .top), count: WallCard.columns(forWidth: width))
    return LazyVGrid(columns: columns, alignment: .leading, spacing: Space.xl) {
      ForEach(cards) { card in
        WorkspaceCardView(
          card: card, store: store, usage: metrics.usage, open: { open(card) }, openDevice: openDevice,
          openLogs: openLogs)
      }
    }
    .finiteAccessibilityFrame()
    .onGeometryChange(for: CGFloat.self, of: { $0.size.width }, action: { width = $0 })
  }
}

struct WorkspaceCardView: View {
  var card: WallCard
  var store: StatusStore
  var usage: [String: UsageHistory]
  var open: () -> Void
  var openDevice: (WorkspaceKey, String) -> Void
  var openLogs: (String) -> Void
  @ObservedObject private var choices = WorkspaceCardChoices.shared
  @AppStorage(AppPreferences.Key.tileSize) private var tileSize = TileSize.medium
  @State private var pressed = false
  @State private var mediaWidth: CGFloat = 420

  private var choiceKey: String { card.choiceKey }

  var body: some View {
    let showLogs = { (app: Workspace) in openLogs(app.path) }
    if !card.owner.isLocal {
      content.contextMenu { openWorkspace }
    } else if card.isMultiApp {
      WorktreeActions(page: card.page, openLogs: showLogs) { menu in
        content.contextMenu {
          openWorkspace
          Divider()
          menu
        }
      }
    } else {
      WorkspaceActions(env: card.apps[0].workspace, openLogs: openLogs, showsHide: false) { menu in
        content.contextMenu {
          openWorkspace
          Divider()
          menu
        }
      }
    }
  }

  private var openWorkspace: some View {
    Button("Open Workspace", systemImage: "arrow.up.right.square", action: open)
  }

  @ViewBuilder private var content: some View {
    let options = card.options
    let selected = card.selected(choice: choices.choices[choiceKey])
    let env = selected?.app.workspace ?? card.apps[0].workspace
    let tileShowsBuild =
      selected.map { option in
        if case .device(let device) = option.kind { return option.app.workspace.runningBuild(for: device) != nil }
        return false
      } ?? false
    let otherBuilds =
      selected == nil ? [] : card.apps.map(\.workspace).filter { $0.path != env.path && $0.build?.isRunning == true }
    Card(border: Palette.border) {
      VStack(alignment: .leading, spacing: 0) {
        VStack(alignment: .leading, spacing: Space.md) {
          if let machine = card.machine { MachineBadge(machine: machine) }
          Button {
            pressed = false
            open()
          } label: {
            WorkspaceHeader(
              env: env, project: card.owner.isLocal ? store.project(of: env) : env.project ?? Project(fallbackFor: env.path),
              usage: card.owner.isLocal ? usage[env.path] : nil,
              showsProgress: selected != nil && !tileShowsBuild,
              openLogs: { card.owner.isLocal ? openLogs(env.path) : open() })
          }
          .buttonStyle(CardPressStyle())
          .accessibilityLabel(env.names.title)
          ForEach(otherBuilds, id: \.path) { other in
            if let build = other.build { BuildProgressBar(build: build).frame(maxWidth: 520) }
          }
          if options.count > 1 { switcher(options, selected: selected) }
        }
        .padding(CardMetrics.headerPadding)
        Spacer(minLength: 0)
        media(selected)
          .frame(maxWidth: .infinity)
          .frame(height: CGFloat(tileSize.screenHeight))
          .background(Media.screen)
          .clipped()
          .onGeometryChange(for: CGFloat.self, of: { $0.size.width }, action: { mediaWidth = $0 })
      }
      .frame(maxHeight: .infinity, alignment: .top)
    }
    .frame(maxHeight: .infinity, alignment: .top)
    .contentShape(Rectangle())
    .onTapGesture(perform: open)
    .hoverHighlight(radius: Radius.card)
    .modifier(CardPressAppearance(pressed: pressed))
    .onPreferenceChange(CardPressedKey.self) { pressed = $0 }
    .task(id: selected?.isStreamable == true ? selected?.id : nil) {
      if let id = selected?.id, selected?.isStreamable == true { choices.adopt(id, for: choiceKey) }
    }
  }

  private func switcher(_ options: [WallCard.Option], selected: WallCard.Option?) -> some View {
    FlowLayout(spacing: Space.sm, lineSpacing: Space.sm) {
      ForEach(options) { option in
        let isSelected = option.id == selected?.id
        Button {
          choices.choose(option.id, for: choiceKey)
        } label: {
          Pill(tone: isSelected ? .brand : .neutral, size: .small, outlined: !isSelected) { Text(option.label) }
        }
        .buttonStyle(.hoverRow())
        .contextMenu { deviceMenu(option) }
        .help("Stream \(option.label)")
        .accessibilityLabel(option.label)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
      }
    }
  }

  @ViewBuilder private func deviceMenu(_ option: WallCard.Option) -> some View {
    let env = option.app.workspace
    switch option.kind {
    case .device(let device):
      Button("Open Device Viewer", systemImage: "rectangle.expand.vertical") {
        openDevice(WorkspaceKey(owner: card.owner, path: env.path), device.id)
      }
      if DeviceTileMenu.applies(to: device, owner: card.owner) {
        Divider()
        DeviceTileMenuItems(
          device: device, workspace: env.path, building: env.runningBuild(for: device) != nil, choice: nil,
          openBuildLogs: nil)
      }
    }
  }

  @ViewBuilder private func media(_ selected: WallCard.Option?) -> some View {
    if let selected {
      let env = selected.app.workspace
      switch selected.kind {
      case .device(let device):
        Button {
          openDevice(WorkspaceKey(owner: card.owner, path: env.path), device.id)
        } label: {
          DeviceTile(
            device: device, owner: card.owner, screenHeight: CGFloat(tileSize.screenHeight), workspace: env.path,
            build: env.runningBuild(for: device), showsCovers: true, maxWidth: mediaWidth,
            pausesWhenOffscreen: true, embedded: true)
        }
        .buttonStyle(CardPressStyle(highlightsDevice: true))
        .contextMenu { deviceMenu(selected) }
        .id(card.owner.scoped(selected.id))
      }
    } else {
      status
    }
  }

  private var status: some View {
    let building = card.apps.map(\.workspace).first { $0.build?.isRunning == true }
    let settingUp = card.apps.map(\.workspace).first { !$0.live && $0.isSettingUp }
    return VStack(spacing: Space.lg) {
      if let build = building?.build {
        BuildProgressBar(build: build).frame(maxWidth: 360)
      } else if let settingUp {
        SetupBadge(env: settingUp).frame(maxWidth: 360)
      } else {
        Label(
          card.apps.contains { $0.workspace.metro?.running == true } ? "Metro Running, No Device Yet" : "No Running Devices",
          systemImage: "iphone.gen3"
        )
        .font(.stim(.callout))
        .foregroundStyle(.white.opacity(0.7))
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .padding(Space.xl)
  }
}
