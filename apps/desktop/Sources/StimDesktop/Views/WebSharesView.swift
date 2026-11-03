import StimKit
import StimStores
import SwiftUI

/// The live web shares of this Mac's stim-server. A server whose `share.stop` takes a share `id` gets a Stop on each
/// row; an older one ends every share of a workspace, so a workspace's shares share one Stop.
struct WebSharesView: View {
  @ObservedObject var store: StatusStore
  var model: WebSharesModel = .shared

  var body: some View {
    Form {
      if let shares = model.shares {
        if shares.isEmpty {
          Section {
            VStack(spacing: Space.lg) {
              ZStack {
                BrandHalo(size: 130)
                BrandBadge(systemImage: "link", size: 64)
              }
              .accessibilityHidden(true)
              Text("No Web Shares").font(.stim(.headline))
              Text("Choose Share\u{2026} in a running simulator or emulator's menu to give someone a link to it.")
                .foregroundStyle(Palette.secondary)
                .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, Space.xl)
          }
        } else {
          ForEach(groups(shares), id: \.workspace) { group in
            Section {
              ForEach(group.shares) { share in
                ShareRow(
                  share: share, canStop: model.stopsOneShare,
                  isStopping: model.stopping.contains(share.id) || model.stopping.contains(group.workspace)
                ) { Task { await model.stop(share: share) } }
              }
            } header: {
              HStack {
                Text(store.names(ofPath: group.workspace).title)
                Spacer()
                if group.shares.count > 1 || !model.stopsOneShare {
                  Button(group.shares.count > 1 ? "Stop All" : "Stop", role: .destructive) {
                    Task { await model.stop(workspace: group.workspace) }
                  }
                  .buttonStyle(.stim(.destructive))
                  .disabled(model.stopping.contains(group.workspace))
                  .help("Ends the links to all of this workspace's devices")
                }
              }
            }
          }
        }
      } else {
        Section { InlineEmpty("This stim-server does not serve web shares. Update Stim Desktop.") }
      }
    }
    .formStyle(.grouped)
    .scrollContentBackground(.hidden)
    .background(Palette.background)
    .task {
      while !Task.isCancelled {
        await model.refresh()
        try? await Task.sleep(for: .seconds(5))
      }
    }
  }

  private func groups(_ shares: [WebShare]) -> [(workspace: String, shares: [WebShare])] {
    var order: [String] = []
    for share in shares where !order.contains(share.workspace) { order.append(share.workspace) }
    return order.map { path in (path, shares.filter { $0.workspace == path }) }
  }
}

private struct ShareRow: View {
  var share: WebShare
  var canStop: Bool
  var isStopping: Bool
  var stop: () -> Void

  var body: some View {
    HStack(spacing: Space.lg) {
      Image(systemName: share.platform == "ios" ? "iphone" : "smartphone").iconFont(IconSize.large)
        .foregroundStyle(Palette.accent)
      VStack(alignment: .leading, spacing: Space.xxs) {
        Text(share.platformLabel).font(.stim(.body, weight: .semibold))
        Text("\(share.viewersLabel), \(share.timeLeft())").font(.stim(.footnote)).foregroundStyle(Palette.secondary)
      }
      Spacer()
      if share.auth == .none { Pill("No password", tone: .warning, size: .small) }
      Pill(share.accessLabel, tone: share.control ? .success : .neutral, size: .small)
      if canStop {
        Button("Stop", role: .destructive, action: stop)
          .buttonStyle(.stim(.destructive))
          .disabled(isStopping)
          .help("Ends the link to this device")
      }
    }
    .padding(.vertical, Space.xxs)
    .accessibilityElement(children: .contain)
  }
}
