#if DEBUG
  import StimKit
  import SwiftUI

  struct TipFixtureView: View {
    var topic: TipTopic

    var body: some View {
      ZStack(alignment: .bottom) {
        Palette.sidebar
        TipCard(topic: topic, prompt: TipPrompts.byTopic[topic.rawValue], hasNext: true, perform: {}, next: {}, close: {})
          .padding(Space.md)
      }
      .frame(width: 272, height: 300)
    }
  }

  struct BuildMachineEmptyFixtureView: View {
    var variant: BuildMachineEmptyState

    var body: some View {
      ZStack {
        Palette.background
        BuildMachinesEmptyState(add: {}, needsTailscale: variant == .tailscale)
          .padding(Space.xxl)
      }
      .frame(width: 640, height: 420)
    }
  }
#endif
