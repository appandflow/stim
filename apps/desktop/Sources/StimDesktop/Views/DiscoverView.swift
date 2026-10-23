import StimKit
import SwiftUI

struct DiscoverView: View {
  var replayUnavailableReason: String?
  var perform: (TipTopic) -> Void
  @ObservedObject private var flags = FeatureFlagStore.shared

  private struct Group: Identifiable {
    var title: String
    var topics: [TipTopic]
    var id: String { title }
  }

  private var groups: [Group] {
    [
      Group(title: "Get started", topics: [.tutorial]),
      Group(title: "Understand your app", topics: [.logs, .replay]),
      Group(title: "Organize workspaces", topics: [.hideWorkspaces]),
      Group(title: "Use more devices", topics: [.buildMachine, .hostedSimulators] + (flags.phoneApp ? [.phone] : [])),
      Group(title: "Other workflows", topics: [.easProfile, .macos]),
    ]
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: Space.xxl) {
        VStack(alignment: .leading, spacing: Space.sm) {
          Text("Discover Stim").font(.stim(.title))
          Text("Explore what Stim can do for your workflow.")
            .foregroundStyle(Palette.secondary)
        }
        ForEach(groups) { group in
          VStack(alignment: .leading, spacing: Space.md) {
            Text(group.title).font(.stim(.headline)).accessibilityAddTraits(.isHeader)
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 280), alignment: .top)], spacing: Space.lg) {
              ForEach(group.topics, id: \.rawValue) { topic in
                featureCard(topic)
              }
            }
          }
        }
      }
      .frame(maxWidth: 1100, alignment: .leading)
      .padding(Space.xxl)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .font(.stim(.callout))
    .background(Palette.background)
    .navigationTitle("Discover Stim")
  }

  private func featureCard(_ topic: TipTopic) -> some View {
    let unavailable = topic == .replay ? replayUnavailableReason : nil
    return Card {
      VStack(alignment: .leading, spacing: Space.md) {
        Image(systemName: symbol(topic))
          .font(.system(size: 24))
          .foregroundStyle(Palette.primary)
          .frame(width: 44, height: 44)
          .background(Palette.primary.opacity(Opacity.pressed), in: RoundedRectangle(cornerRadius: Radius.card))
          .accessibilityHidden(true)
        Text(topic.title).font(.stim(.headline))
          .fixedSize(horizontal: false, vertical: true)
        Text(topic.body).foregroundStyle(Palette.secondary)
          .fixedSize(horizontal: false, vertical: true)
        if let unavailable {
          Text(unavailable).font(.stim(.footnote)).foregroundStyle(Palette.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        Spacer(minLength: Space.sm)
        if let prompt = TipPrompts.byTopic[topic.rawValue] {
          TutorialPromptBox(prompt: prompt, onCopy: {})
        } else {
          Button(topic.actionTitle) { perform(topic) }
            .buttonStyle(.stim(.primary))
            .disabled(unavailable != nil)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(Space.xl)
    }
    .accessibilityElement(children: .contain)
  }

  private func symbol(_ topic: TipTopic) -> String {
    switch topic {
    case .tutorial: "graduationcap"
    case .logs: "text.alignleft"
    case .replay: "play.rectangle"
    case .hideWorkspaces, .statusFilter: "line.3.horizontal.decrease.circle"
    case .buildMachine: "desktopcomputer"
    case .hostedSimulators: "iphone.gen3.radiowaves.left.and.right"
    case .phone: "iphone"
    case .easProfile: "shippingbox"
    case .macos: "macwindow"
    }
  }
}
