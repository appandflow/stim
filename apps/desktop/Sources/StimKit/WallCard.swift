import Foundation

public struct WallCard: Identifiable, Sendable {
  public struct App: Identifiable, Sendable {
    public var workspace: Workspace
    public var label: String
    public var devices: [DeviceRef]
    public var id: String { workspace.path }
  }

  public var page: WorktreePage
  public var apps: [App]
  public var id: String { page.id }
  public var isMultiApp: Bool { apps.count > 1 }

  /// The grid's column count for a content width in points: one when narrow, two at typical widths, three when
  /// very wide.
  public static func columns(forWidth width: Double) -> Int {
    width < 700 ? 1 : width < 1500 ? 2 : 3
  }

  /// One thing a card can stream: a device of one of the worktree's apps, a macOS app included.
  public struct Option: Identifiable, Sendable {
    public enum Kind: Sendable {
      case device(DeviceRef)
    }

    public var app: App
    public var kind: Kind
    public var label: String

    public var id: String {
      switch kind {
      case .device(let device): "\(app.workspace.path)|\(device.id)"
      }
    }

    /// Whether something is on screen to stream, as opposed to a device that is booting or building.
    public var isStreamable: Bool {
      switch kind {
      case .device(let device): device.isRunning
      }
    }
  }

  /// The card's devices, app by app in `orderedDevices` order (iOS before Android, then macOS, then by slot). A card with several apps prefixes each label with its app.
  public var options: [Option] {
    let all = apps.flatMap(\.devices)
    func prefix(_ app: App) -> String { isMultiApp ? app.label + " \u{00B7} " : "" }
    return apps.flatMap { app in
      app.devices.map { Option(app: app, kind: .device($0), label: prefix(app) + $0.label(among: all)) }
    }
  }

  /// The option to stream: the remembered `choice` while it is still offered, otherwise the first streamable option,
  /// otherwise the first one (a device a build is bringing up). Nil when the card offers nothing.
  public func selected(choice: String?) -> Option? {
    let options = options
    return options.first { $0.id == choice } ?? options.first(where: \.isStreamable) ?? options.first
  }

  /// One card per worktree, ordered by worktree path so a card keeps its place as `stim status` reorders.
  public static func cards(environments: [Workspace]) -> [WallCard] {
    WorktreePage.groups(environments: environments).sorted { $0.identity < $1.identity }.map { page in
      WallCard(
        page: page,
        apps: page.apps.map { env in
          App(
            workspace: env, label: WorktreePage.project(env),
            devices: env.orderedDevices.filter { $0.isRunning || env.runningBuild(for: $0) != nil })
        })
    }
  }
}
