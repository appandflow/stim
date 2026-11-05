import StimKit
import StimStores
import SwiftUI

struct PairedMachineSection: View {
  var entry: PairedServers.Entry
  var session: ServerSession?
  var status: PairedStatus?
  var work: [ForeignWork]

  private var name: String { PairedServerWording.displayName(session?.name ?? entry.pairing?.name ?? "") }

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
      list("\(name)'s hosted devices", items: work.filter { $0.kind.isHostedDevice }, empty: "No hosted devices")
      list("\(name)'s offloaded builds", items: work.filter { !$0.kind.isHostedDevice }, empty: "No offloaded builds")
    }
  }

  private var subtitle: String {
    var parts = [
      "Viewing \u{00B7} \(entry.status.title) \u{00B7} \(PairedServerWording.access(entry.pairing?.capabilities ?? ["read"]))"
    ]
    if let since = session?.offlineSince, status?.payload != nil {
      parts.append("offline since \(since.formatted(date: .omitted, time: .shortened))")
    }
    return parts.joined(separator: ", ")
  }

  private func list(_ title: String, items: [ForeignWork], empty: String) -> some View {
    VStack(alignment: .leading, spacing: Space.md) {
      SectionLabel(title: title)
      Card {
        VStack(spacing: 0) {
          if items.isEmpty {
            ListRow { Text(verbatim: empty).foregroundStyle(Palette.tertiary) }
          }
          ForEach(items) { item in
            if item.id != items.first?.id { Divider() }
            row(icon: item.icon, title: item.title, detail: item.place(serverName: name, now: Date()), value: nil)
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

extension ForeignWork {
  fileprivate var icon: String {
    if case .hostedDevice(let device) = kind { return device.ref.platform == "android" ? "smartphone" : "iphone" }
    return "hammer"
  }
}
