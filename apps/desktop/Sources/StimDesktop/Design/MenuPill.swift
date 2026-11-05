import StimKit
import SwiftUI

struct MenuPillOption<Value: Hashable>: Identifiable {
  var value: Value
  var title: String
  var symbol: String?
  var id: Value { value }
}

struct MenuPill<Value: Hashable>: View {
  var label: String
  var selection: Binding<Value>
  var options: [MenuPillOption<Value>]
  var tone: Tone = .brand
  var isActive = false

  var body: some View {
    Menu {
      Picker(selection: selection) {
        ForEach(options) { option in
          if let symbol = option.symbol {
            Label(option.title, systemImage: symbol).tag(option.value)
          } else {
            Text(option.title).tag(option.value)
          }
        }
      } label: {
        EmptyView()
      }
      .pickerStyle(.inline)
      .labelsHidden()
    } label: {
      Pill(tone: tone, outlined: !isActive) {
        Text(options.first { $0.value == selection.wrappedValue }?.title ?? "")
        Image(systemName: "chevron.down").iconFont(IconSize.micro, weight: .semibold)
      }
    }
    .menuStyle(.button)
    .buttonStyle(.plain)
    .menuIndicator(.hidden)
    .fixedSize()
    .hoverHighlight()
    .accessibilityLabel(label)
  }
}
