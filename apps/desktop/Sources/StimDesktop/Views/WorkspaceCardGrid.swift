import StimKit
import StimStores
import SwiftUI

/// The device each workspace card streams when the user picked one, for the life of the app.
@MainActor
final class WorkspaceCardChoices: ObservableObject {
  static let shared = WorkspaceCardChoices()

  @Published private(set) var choices: [String: String] = [:]

  func choose(_ optionID: String, for card: String) {
    choices[card] = optionID
  }
}

/// The grid of live workspace cards that the Overview and the Active workspaces page share: two columns at typical
/// widths, one when narrow, three when very wide.
struct WorkspaceCardGrid: View {
  var cards: [WallCard]
  @ObservedObject var store: StatusStore
  var metrics: MetricsStore
  var open: (WallCard) -> Void
  var openDevice: (String, String) -> Void
  var openLogs: (String) -> Void

  var body: some View {
    LazyVGrid(
      columns: [GridItem(.adaptive(minimum: 420), spacing: Space.xl, alignment: .top)],
      alignment: .leading, spacing: Space.xl
    ) {
      ForEach(cards) { card in
        WorkspaceCardView(
          card: card, store: store, usage: metrics.usage, open: { open(card) }, openDevice: openDevice,
          openLogs: openLogs)
      }
    }
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
    Card(border: Palette.border) {
      VStack(alignment: .leading, spacing: 0) {
        VStack(alignment: .leading, spacing: Space.md) {
          Button {
            pressed = false
            open()
          } label: {
            WorkspaceHeader(
              env: env, project: store.project(of: env), usage: usage[env.path], showsProgress: false,
              openLogs: { openLogs(env.path) })
          }
          .buttonStyle(CardPressStyle())
          .accessibilityLabel(env.names.title)
          if options.count > 1 { switcher(options, selected: selected) }
        }
        .padding(Space.xl)
        media(selected)
          .frame(maxWidth: .infinity)
          .frame(height: CGFloat(tileSize.screenHeight))
          .background(Media.screen)
          .clipped()
          .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { mediaWidth = $0 }
      }
    }
    .contentShape(Rectangle())
    .onTapGesture(perform: open)
    .hoverHighlight(radius: Radius.card)
    .modifier(CardPressAppearance(pressed: pressed))
    .onPreferenceChange(CardPressedKey.self) { pressed = $0 }
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
      case .macos(let macos):
        MacosAppCard(app: macos, workspace: env.path)
          .environment(\.macosViewportHeight, CGFloat(tileSize.screenHeight) - Space.lg * 2)
          .padding(Space.lg)
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
          card.apps.contains { $0.workspace.metro?.running == true } ? "Metro running, no device yet" : "No running devices",
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
