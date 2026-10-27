import StimKit
import StimStores
import SwiftUI

struct PairedMachineSection: View {
  var entry: PairedServers.Entry
  var session: ServerSession?
  var status: PairedStatus?
  var work: [RemoteWork]

  private var name: String { session?.name ?? entry.pairing?.name ?? "Paired machine" }

  var body: some View {
    VStack(alignment: .leading, spacing: Space.xxl) {
      MachineHeading(icon: "link", title: name, subtitle: subtitle) { EmptyView() }
      if let capacity = status?.payload?.capacity, capacity.load != nil || !capacity.meters.isEmpty {
        VStack(alignment: .leading, spacing: Space.md) {
          SectionLabel(title: "Capacity")
          Card {
            VStack(spacing: 0) {
              if let load = capacity.load {
                row(icon: ResourceKind.load.icon, title: "Load", detail: load.explanation, value: load.text)
              }
              ForEach(capacity.meters, id: \.kind) { meter in
                if capacity.load != nil || meter.kind != capacity.meters.first?.kind { Divider() }
                row(
                  icon: meter.kind.countsDevices ? "iphone" : "hammer", title: meter.label, detail: meter.reason,
                  value: meter.value)
              }
            }
          }
        }
      }
      list("Hosted devices", items: work.filter(\.isHostedDevice), empty: "No hosted devices")
      list("Offloaded builds", items: work.filter { !$0.isHostedDevice }, empty: "No offloaded builds")
    }
  }

  private var subtitle: String {
    let access = entry.pairing?.capabilities.contains("control") == true ? "View and control" : "View only"
    var parts = ["\(entry.status.title) \u{00B7} \(access)"]
    if let since = session?.offlineSince, status?.payload != nil {
      parts.append("offline since \(since.formatted(date: .omitted, time: .shortened))")
    }
    return parts.joined(separator: ", ")
  }

  private func list(_ title: String, items: [RemoteWork], empty: String) -> some View {
    VStack(alignment: .leading, spacing: Space.md) {
      SectionLabel(title: title)
      Card {
        VStack(spacing: 0) {
          if items.isEmpty {
            ListRow { Text(verbatim: empty).foregroundStyle(Palette.tertiary) }
          }
          ForEach(items) { item in
            if item.id != items.first?.id { Divider() }
            row(icon: item.icon, title: item.title, detail: "\(name) \u{00B7} \(item.place)", value: nil)
          }
        }
      }
    }
  }

  private func row(icon: String, title: String, detail: String?, value: String?) -> some View {
    ListRow {
      Image(systemName: icon).foregroundStyle(Palette.secondary).frame(width: 18).accessibilityHidden(true)
      VStack(alignment: .leading, spacing: Space.xxs) {
        Text(verbatim: title).font(.stim(.body, weight: .semibold)).lineLimit(1).truncationMode(.middle)
        if let detail { Text(verbatim: detail).font(.stim(.caption)).foregroundStyle(Palette.secondary).lineLimit(1) }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      if let value { Text(verbatim: value).font(.stim(.callout, mono: true)) }
    }
  }
}

extension RemoteWork {
  fileprivate var isHostedDevice: Bool {
    if case .hostedDevice = kind { return true }
    return false
  }

  fileprivate var icon: String {
    if case .hostedDevice(let device) = kind { return device.ref.platform == "android" ? "smartphone" : "iphone" }
    return "hammer"
  }

  fileprivate var title: String {
    switch kind {
    case .hostedDevice(let device): return "\(device.ref.model) \u{00B7} \(workspaceTitle)"
    case .offloadedBuild(let build): return "\(platformName(build.platform)) build \u{00B7} \(workspaceTitle)"
    }
  }

  fileprivate var place: String {
    switch kind {
    case .hostedDevice: return "running on \(host)"
    case .offloadedBuild(let build):
      return ["building on \(host)", build.remote(at: Date())?.phase].compactMap { $0 }.joined(separator: " \u{00B7} ")
    }
  }
}
