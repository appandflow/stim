import StimKit
import SwiftUI

struct DiscoverView: View {
  var replayUnavailableReason: String?
  var perform: (TipTopic) -> Void
  @State private var contentWidth: CGFloat = 1100
  @ObservedObject private var flags = FeatureFlagStore.shared

  private struct Group: Identifiable {
    var title: String
    var topics: [TipTopic]
    var id: String { title }
  }

  private var groups: [Group] {
    [
      Group(title: "Use more devices", topics: [.buildMachine, .hostedSimulators] + (flags.phoneApp ? [.phone] : [])),
      Group(title: "Other workflows", topics: [.easProfile, .macos]),
    ]
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: Space.xxl * 1.5) {
        VStack(alignment: .leading, spacing: Space.sm) {
          Text("Discover Stim").font(.stim(.title))
          Text("Explore what Stim can do for your workflow.")
            .foregroundStyle(Palette.secondary)
        }
        tutorialBanner
        VStack(alignment: .leading, spacing: Space.md) {
          Text("Everyday workflows").font(.stim(.headline)).accessibilityAddTraits(.isHeader)
          let layout =
            contentWidth >= 640
            ? AnyLayout(HStackLayout(alignment: .top, spacing: Space.lg))
            : AnyLayout(VStackLayout(alignment: .leading, spacing: Space.lg))
          layout {
            featureCard(.logs).frame(maxWidth: .infinity)
            VStack(spacing: Space.lg) {
              featureCard(.replay)
              featureCard(.hideWorkspaces)
            }
            .frame(maxWidth: .infinity)
          }
        }
        ForEach(groups) { group in
          VStack(alignment: .leading, spacing: Space.md) {
            Text(group.title).font(.stim(.headline)).accessibilityAddTraits(.isHeader)
            LazyVGrid(
              columns: Array(repeating: GridItem(.flexible(), alignment: .top), count: contentWidth >= 640 ? 2 : 1),
              spacing: Space.lg
            ) {
              ForEach(group.topics, id: \.rawValue) { topic in
                featureCard(topic)
              }
            }
          }
        }
      }
      .frame(maxWidth: 1100, alignment: .leading)
      .onGeometryChange(for: CGFloat.self) {
        $0.size.width
      } action: {
        contentWidth = $0
      }
      .padding(Space.xxl)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .font(.stim(.callout))
    .background(Palette.background)
    .navigationTitle("Discover Stim")
  }

  private var tutorialBanner: some View {
    Card {
      ViewThatFits(in: .horizontal) {
        HStack(spacing: Space.xl) {
          tutorialIntroduction
          Spacer(minLength: Space.md)
          tutorialButton
        }
        VStack(alignment: .leading, spacing: Space.lg) {
          tutorialIntroduction
          tutorialButton
        }
      }
      .padding(Space.xl)
    }
  }

  private var tutorialIntroduction: some View {
    HStack(alignment: .top, spacing: Space.lg) {
      Image(systemName: "graduationcap")
        .font(.system(size: 24))
        .foregroundStyle(Palette.primary)
        .frame(width: 44, height: 44)
        .background(Palette.primary.opacity(Opacity.pressed), in: RoundedRectangle(cornerRadius: Radius.card))
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: Space.sm) {
        Text(TipTopic.tutorial.title).font(.stim(.headline))
        Text(TipTopic.tutorial.body).foregroundStyle(Palette.text.opacity(0.8))
          .lineSpacing(3)
      }
      .fixedSize(horizontal: false, vertical: true)
    }
  }

  private var tutorialButton: some View {
    Button(TipTopic.tutorial.actionTitle) { perform(.tutorial) }
      .buttonStyle(.stim(.primary))
      .fixedSize()
  }

  private func featureCard(_ topic: TipTopic) -> some View {
    let unavailable = topic == .replay ? replayUnavailableReason : nil
    return Card {
      VStack(alignment: .leading, spacing: Space.md) {
        HStack(spacing: Space.md) {
          Image(systemName: symbol(topic))
            .font(.system(size: 22))
            .foregroundStyle(Palette.primary)
            .frame(width: 28, height: 28)
            .accessibilityHidden(true)
          Text(topic.title).font(.stim(.headline))
            .fixedSize(horizontal: false, vertical: true)
        }
        Text(topic.body).foregroundStyle(Palette.text.opacity(0.8))
          .lineSpacing(3)
          .fixedSize(horizontal: false, vertical: true)
        if let unavailable {
          Text(unavailable).font(.stim(.footnote)).foregroundStyle(Palette.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        if let prompt = TipPrompts.byTopic[topic.rawValue] {
          TutorialPromptBox(
            prompt: prompt, onCopy: {}, fill: .white,
            contentPadding: Space.xl, contentSpacing: Space.lg, textLineSpacing: 3
          )
          .environment(\.colorScheme, .light)
        } else {
          Button(topic.actionTitle) { perform(topic) }
            .buttonStyle(.stim())
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
