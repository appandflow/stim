import StimKit
import SwiftUI

/// A titled section whose header folds it away and whose content gets only the first `limit` items until the
/// viewer asks for all of them. Both choices persist per `id` in the app's preferences. An uncapped section
/// always gets every item, for lists whose hidden rows an action would still act on.
struct CollapsibleSection<Item, Accessory: View, Content: View>: View {
  static var limit: Int { 10 }

  var title: String
  var items: [Item]
  var capped: Bool
  @ViewBuilder var accessory: Accessory
  @ViewBuilder var content: (ArraySlice<Item>) -> Content
  @AppStorage private var collapsed: Bool
  @AppStorage private var showsAll: Bool

  init(
    _ id: String, title: String, items: [Item], capped: Bool = true, @ViewBuilder accessory: () -> Accessory,
    @ViewBuilder content: @escaping (ArraySlice<Item>) -> Content
  ) {
    self.title = title
    self.items = items
    self.capped = capped
    self.accessory = accessory()
    self.content = content
    _collapsed = AppStorage(wrappedValue: false, AppPreferences.Key.sectionCollapsed(id))
    _showsAll = AppStorage(wrappedValue: false, AppPreferences.Key.sectionShowsAll(id))
  }

  var body: some View {
    VStack(alignment: .leading, spacing: Space.md) {
      HStack(alignment: .firstTextBaseline, spacing: Space.md) {
        Button {
          collapsed.toggle()
        } label: {
          HStack(alignment: .firstTextBaseline, spacing: Space.sm) {
            Image(systemName: "chevron.right")
              .font(.system(size: 11, weight: .semibold))
              .foregroundStyle(Palette.tertiary)
              .rotationEffect(.degrees(collapsed ? 0 : 90))
              .frame(width: 12)
            Text(title).font(.stim(.headline))
            Text("\(items.count)").foregroundStyle(Palette.tertiary)
          }
        }
        .buttonStyle(.hoverRow(outset: Space.xs))
        .help(collapsed ? "Expand \(title)" : "Collapse \(title)")
        .accessibilityLabel("\(title), \(items.count)")
        .accessibilityValue(collapsed ? "Collapsed" : "Expanded")
        accessory
      }
      if !collapsed {
        content(showsAll || !capped ? items[...] : items.prefix(Self.limit))
        if capped, items.count > Self.limit {
          Button(showsAll ? "Show fewer" : "Show all \(items.count)") { showsAll.toggle() }
            .buttonStyle(.hoverRow(outset: Space.xs))
            .foregroundStyle(Palette.primary)
            .help(showsAll ? "Show only the first \(Self.limit)" : "Show all \(items.count) rows")
            .accessibilityLabel(
              showsAll ? "Show only the first \(Self.limit) in \(title)" : "Show all \(items.count) in \(title)")
        }
      }
    }
  }
}

extension CollapsibleSection where Accessory == EmptyView {
  init(_ id: String, title: String, items: [Item], @ViewBuilder content: @escaping (ArraySlice<Item>) -> Content) {
    self.init(id, title: title, items: items, accessory: { EmptyView() }, content: content)
  }
}
