import SimulatorFrames
import StimKit
import SwiftUI

struct DeviceTile: View {
  var device: DeviceRef
  var screenHeight: CGFloat
  var interactive = false
  @State private var pixelSize: CGSize?

  private let screenPadding: CGFloat = 12

  var body: some View {
    Card {
      VStack(spacing: 0) {
        HStack(spacing: 8) {
          StatusDot(color: device.isRunning ? Theme.live : Theme.tertiary, filled: device.isRunning)
          Text(device.slot).font(Theme.body(12, weight: .semibold))
          Text(device.model).font(Theme.body(12)).foregroundStyle(Theme.secondary).lineLimit(1)
          Spacer(minLength: 8)
          Text(source).font(Theme.body(10.5)).foregroundStyle(Theme.tertiary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        Rectangle().fill(Theme.border).frame(height: 1)
        screen
          .frame(height: screenHeight)
          .background(Theme.screen)
      }
    }
    .overlay {
      if interactive { RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.lavender, lineWidth: 2) }
    }
    .frame(width: width)
  }

  private var width: CGFloat {
    if let pixelSize, pixelSize.height > 0 {
      let inner = screenHeight - screenPadding * 2
      return max(240, inner * pixelSize.width / pixelSize.height + screenPadding * 2)
    }
    switch device.formFactor {
    case .phone: return max(240, screenHeight * 0.52)
    case .tablet: return screenHeight * 0.78
    case .dual: return screenHeight * 1.4
    }
  }

  private var source: String {
    switch device {
    case .ios: return "iOS Simulator"
    case .android: return "Android Emulator"
    }
  }

  @ViewBuilder private var screen: some View {
    switch device {
    case .ios(_, let sim) where device.isRunning:
      SimulatorDisplayView(udid: sim.udid, interactive: interactive) { pixelSize = $0 }.padding(screenPadding)
    case .android where device.isRunning:
      placeholder("Android frames are not streamed yet")
    default:
      placeholder(device.state)
    }
  }

  private func placeholder(_ text: String) -> some View {
    Text(text)
      .font(Theme.body(12))
      .foregroundStyle(Theme.tertiary)
      .multilineTextAlignment(.center)
      .padding()
      .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}
