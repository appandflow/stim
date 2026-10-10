import StimKit
import SwiftUI

struct DevicePlacementView: View {
  var device: DeviceRef

  var body: some View {
    if let placement = device.placement {
      Label("on \(placement.machine)", systemImage: "desktopcomputer")
        .font(.stim(.caption))
        .foregroundStyle(Palette.tertiary)
        .lineLimit(1)
        .help(placement.reason ?? "")
    }
  }
}
