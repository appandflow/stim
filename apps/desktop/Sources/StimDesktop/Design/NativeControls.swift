import SwiftUI

extension View {
  @ViewBuilder func nativeControlStyle(_ variant: ButtonVariant = .secondary) -> some View {
    #if compiler(>=6.2)
      if #available(macOS 26, *) {
        if variant == .primary {
          buttonStyle(.glassProminent).tint(Palette.brand).buttonBorderShape(.capsule).controlSize(.small)
        } else {
          buttonStyle(.glass).tint(variant == .destructive ? Palette.error : Palette.accent)
            .buttonBorderShape(.capsule).controlSize(.small)
        }
      } else {
        buttonStyle(.stim(variant))
      }
    #else
      buttonStyle(.stim(variant))
    #endif
  }

  @ViewBuilder func nativeIconStyle(tint: Color = Palette.secondary, active: Bool = false) -> some View {
    #if compiler(>=6.2)
      if #available(macOS 26, *) {
        buttonStyle(.glass)
          .buttonBorderShape(.capsule)
          .foregroundStyle(tint)
          .tint(active ? tint : nil)
          .controlSize(.small)
      } else {
        buttonStyle(.icon(tint: tint, active: active))
      }
    #else
      buttonStyle(.icon(tint: tint, active: active))
    #endif
  }
}
