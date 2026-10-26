import StimKit
import StimStores
import SwiftUI

/// This Mac's load and its device and build slots, from the status payload's `capacity`.
struct CapacitySection: View {
  @ObservedObject var status: StatusStore
  @EnvironmentObject private var actions: ActionCenter

  private static let actionWidth: CGFloat = 88

  var body: some View {
    if let capacity = status.payload?.capacity, capacity.load != nil || !capacity.meters.isEmpty {
      VStack(alignment: .leading, spacing: Space.lg) {
        Label {
          Text("Capacity").font(.stim(.headline))
        } icon: {
          Image(systemName: ResourceKind.load.icon).iconFont(IconSize.small).accessibilityHidden(true)
        }
        Card {
          VStack(spacing: 0) {
            if let load = capacity.load { loadRow(load) }
            ForEach(capacity.meters, id: \.kind) { meter in
              if capacity.load != nil || meter.kind != capacity.meters.first?.kind { Divider() }
              meterRow(meter)
            }
          }
        }
        if let devices = capacity.devices, capacity.meters.contains(where: { $0.kind == .devices && $0.isFull }) {
          let rows = devices.rows(in: status.payload?.environments ?? [])
          if !rows.isEmpty {
            Text("Devices holding the slots").font(.stim(.callout, weight: .semibold))
            Card {
              VStack(spacing: 0) {
                ForEach(rows) { row in
                  if row.id != rows.first?.id { Divider() }
                  deviceRow(row)
                }
              }
            }
          }
        }
        if let builds = capacity.builds, !builds.holders.isEmpty {
          Text("Builds holding the slots").font(.stim(.callout, weight: .semibold))
          Card {
            VStack(spacing: 0) {
              ForEach(builds.holders, id: \.slot) { holder in
                if holder.slot != builds.holders.first?.slot { Divider() }
                buildRow(holder)
              }
            }
          }
        }
      }
    }
  }

  private func loadRow(_ load: CapacityLoad) -> some View {
    ListRow {
      Image(systemName: ResourceKind.load.icon).foregroundStyle(Palette.secondary).frame(width: 18)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: Space.xxs) {
        Text("Load").font(.stim(.body, weight: .semibold))
        Text(load.explanation).font(.stim(.caption)).foregroundStyle(Palette.secondary)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      Text(load.text).font(.stim(.callout, mono: true)).foregroundStyle(Color(load.tone))
        .accessibilityLabel("Load, \(load.text)")
    }
  }

  private func meterRow(_ meter: CapacityMeter) -> some View {
    ListRow {
      Image(systemName: meter.kind == .devices ? "iphone" : "hammer").foregroundStyle(Palette.secondary).frame(width: 18)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: Space.xxs) {
        Text(meter.label).font(.stim(.body, weight: .semibold))
        if let reason = meter.reason {
          Text(reason).font(.stim(.caption)).foregroundStyle(Palette.secondary)
        } else if meter.isFull {
          Text(meter.kind == .devices ? "New devices wait for a slot." : "New builds wait for a slot.")
            .font(.stim(.caption)).foregroundStyle(Palette.secondary)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      Text(meter.value).font(.stim(.callout, mono: true)).foregroundStyle(Color(meter.isFull ? Tone.caution : Tone.normal))
        .accessibilityLabel("\(meter.label), \(meter.value) in use")
    }
  }

  private func deviceRow(_ row: DeviceHolderRow) -> some View {
    ListRow {
      PlatformGlyph(platform: row.platform, size: 13, color: Palette.secondary).frame(width: 18)
      VStack(alignment: .leading, spacing: Space.xxs) {
        Text(row.label).font(.stim(.body, weight: .semibold)).lineLimit(1)
        Text(deviceLine(row)).font(.stim(.caption)).foregroundStyle(Palette.secondary).lineLimit(1)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      if let stop = row.stop, let slot = row.slot {
        Button("Stop") {
          actions.run("Stop \(row.label)", steps: [stop], present: false)
        }
        .buttonStyle(.stim(.destructive))
        .fixedSize()
        .frame(width: Self.actionWidth, alignment: .trailing)
        .disabled(actions.active(for: stop.cwd) != nil)
        .accessibilityLabel("Stop \(row.label), \(platformName(row.platform))")
        .help("stim stop --slot \(slot): stops every device in this slot, keeping the shared server and other slots running")
      } else {
        Text("Not recorded by a workspace").font(.stim(.caption)).foregroundStyle(Palette.tertiary)
      }
    }
  }

  private func deviceLine(_ row: DeviceHolderRow) -> String {
    var parts = [platformName(row.platform)]
    if let slot = row.slot, slot != DeviceRef.defaultSlot { parts.append(slot) }
    if let detail = row.detail { parts.append(detail) }
    return parts.joined(separator: " \u{00B7} ")
  }

  private func buildRow(_ holder: BuildSlotHolder) -> some View {
    ListRow {
      Image(systemName: "hammer").foregroundStyle(Palette.secondary).frame(width: 18).accessibilityHidden(true)
      VStack(alignment: .leading, spacing: Space.xxs) {
        switch holder.owner {
        case .workspace(let path):
          Text(status.names(ofPath: path).title).font(.stim(.body, weight: .semibold)).lineLimit(1)
        case .client(let client):
          Text("Offloaded for \(client)").font(.stim(.body, weight: .semibold)).lineLimit(1)
        case .unresolved:
          Text("Unresolved claim").font(.stim(.body, weight: .semibold))
        }
        Text("Slot \(holder.slot)").font(.stim(.caption)).foregroundStyle(Palette.secondary)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}
