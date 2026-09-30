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
  var tone: PillTone = .accent
  var isActive = false
  @State private var hovering = false

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
        Image(systemName: "chevron.down").font(.system(size: 8, weight: .semibold))
      }
      .opacity(hovering ? 0.8 : 1)
      .contentShape(Rectangle())
    }
    .menuStyle(.button)
    .buttonStyle(.plain)
    .menuIndicator(.hidden)
    .fixedSize()
    .accessibilityLabel(label)
    .onHover { hovering = $0 }
  }
}
