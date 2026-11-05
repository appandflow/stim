import SwiftUI

enum IconSize {
  static let micro: CGFloat = 8
  static let indicator: CGFloat = 9
  static let compact: CGFloat = 10
  static let small: CGFloat = 11
  static let control: CGFloat = 12
  static let regular: CGFloat = 13
  static let row: CGFloat = 15
  static let medium: CGFloat = 16
  static let large: CGFloat = 18
}

extension View {
  func iconFont(_ size: CGFloat, weight: Font.Weight = .regular) -> some View {
    font(.system(size: size, weight: weight))
  }
}
