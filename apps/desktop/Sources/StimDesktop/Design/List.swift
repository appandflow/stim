import SwiftUI

/// A titled list of rows for custom surfaces such as the inspector and the Machine page; native `Form` stays for
/// settings. `grouped` joins the rows in one card with separators; `separated` gives each row its own fill.
struct ListSection<Data: RandomAccessCollection, ID: Hashable, Header: View, Row: View>: View {
  enum Style: CaseIterable {
    case grouped
    case separated
  }

  var data: Data
  var id: KeyPath<Data.Element, ID>
  var style: Style = .grouped
  @ViewBuilder var header: Header
  @ViewBuilder var row: (Data.Element) -> Row

  var body: some View {
    VStack(alignment: .leading, spacing: Space.md) {
      header
      switch style {
      case .grouped:
        Card {
          VStack(spacing: 0) {
            ForEach(data, id: id) { element in
              if element[keyPath: id] != data.first?[keyPath: id] {
                Rectangle().fill(Palette.separator).frame(height: 1)
              }
              row(element)
            }
          }
        }
      case .separated:
        ForEach(data, id: id) { element in
          row(element).background(RoundedRectangle(cornerRadius: Radius.control).fill(Palette.surface))
        }
      }
    }
  }
}

extension ListSection where Header == SectionLabel {
  init(
    _ title: String, _ data: Data, id: KeyPath<Data.Element, ID>, style: Style = .grouped,
    @ViewBuilder row: @escaping (Data.Element) -> Row
  ) {
    self.init(data: data, id: id, style: style, header: { SectionLabel(title: title) }, row: row)
  }
}

extension ListSection where Data.Element: Identifiable, ID == Data.Element.ID, Header == SectionLabel {
  init(_ title: String, _ data: Data, style: Style = .grouped, @ViewBuilder row: @escaping (Data.Element) -> Row) {
    self.init(title, data, id: \.id, style: style, row: row)
  }
}

extension ListSection where Header == EmptyView, Data.Element: Identifiable, ID == Data.Element.ID {
  init(_ data: Data, style: Style = .grouped, @ViewBuilder row: @escaping (Data.Element) -> Row) {
    self.init(data: data, id: \.id, style: style, header: { EmptyView() }, row: row)
  }
}

/// A list row's content with the standard insets.
struct ListRow<Content: View>: View {
  var compact = false
  @ViewBuilder var content: Content

  var body: some View {
    HStack(spacing: Space.md) { content }
      .padding(.horizontal, compact ? Space.md + Space.xxs : Space.xl)
      .padding(.vertical, compact ? Space.md : Space.md + Space.xxs)
      .frame(maxWidth: .infinity, alignment: .leading)
  }
}

struct SectionLabel: View {
  var title: String

  var body: some View {
    Text(title.uppercased())
      .textStyle(.caption2, weight: .semibold)
      .tracking(0.6)
      .foregroundStyle(Palette.tertiary)
  }
}

struct Card<Content: View>: View {
  @ViewBuilder var content: Content

  var body: some View {
    content
      .background(RoundedRectangle(cornerRadius: Radius.card).fill(Palette.surface))
      .clipShape(RoundedRectangle(cornerRadius: Radius.card))
      .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Palette.border))
  }
}
