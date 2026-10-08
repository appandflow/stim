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

struct WorkspaceCardGrid: View {
  var cards: [WallCard]
  @ObservedObject var store: StatusStore
  var metrics: MetricsStore
  var open: (WallCard) -> Void
  var openDevice: (String, String) -> Void
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
    .onGeometryChange(for: CGFloat.self, of: { $0.size.width }, action: { width = $0 })
  }
}

struct WorkspaceCardView: View {
  var card: WallCard
  var store: StatusStore
  var usage: [String: UsageHistory]
  var open: () -> Void
  var openDevice: (String, String) -> Void
  var openLogs: (String) -> Void
  @ObservedObject private var choices = WorkspaceCardChoices.shared
  @AppStorage(AppPreferences.Key.tileSize) private var tileSize = TileSize.medium
  @State private var pressed = false
  @State private var mediaWidth: CGFloat = 420

  private var choiceKey: String { card.page.identity }

  var body: some View {
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
          Button {
            pressed = false
            open()
          } label: {
            WorkspaceHeader(
              env: env, project: store.project(of: env), usage: usage[env.path],
              showsProgress: selected != nil && !tileShowsBuild,
              openLogs: { openLogs(env.path) })
          }
          .buttonStyle(CardPressStyle())
          .accessibilityLabel(env.names.title)
          ForEach(otherBuilds, id: \.path) { other in
            if let build = other.build { BuildProgressBar(build: build).frame(maxWidth: 520) }
          }
          if options.count > 1 { switcher(options, selected: selected) }
        }
        .padding(Space.xl)
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
        .help("Stream \(option.label)")
        .accessibilityLabel(option.label)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
      }
    }
  }

  @ViewBuilder private func media(_ selected: WallCard.Option?) -> some View {
    if let selected {
      let env = selected.app.workspace
      switch selected.kind {
      case .device(let device):
        Button {
          openDevice(env.path, device.id)
        } label: {
          DeviceTile(
            device: device, screenHeight: CGFloat(tileSize.screenHeight), workspace: env.path,
            build: env.runningBuild(for: device), showsCovers: true, maxWidth: mediaWidth,
            pausesWhenOffscreen: true, embedded: true)
        }
        .buttonStyle(CardPressStyle(highlightsDevice: true))
        .id(selected.id)
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
