import StimKit
import SwiftUI

struct MachineChip {
  var title: String
  var subtitle: String
  var tone: Tone?
  var help: String?
}

struct MachineChoiceBar: View {
  var groups: [MachineChoiceGroup]
  var selection: MachineChoice
  var previews: [String] = []
  var chip: (MachineChoice) -> MachineChip
  var select: (MachineChoice) -> Void

  var body: some View {
    ViewThatFits(in: .horizontal) {
      HStack(alignment: .bottom, spacing: Space.xxl) {
        ForEach(groups) { group in
          VStack(alignment: .leading, spacing: Space.sm) {
            if let title = group.title {
              Text(title).font(.stim(.caption, weight: .semibold)).foregroundStyle(Palette.secondary)
            }
            HStack(spacing: Space.md) {
              ForEach(group.choices, id: \.self) { choice in button(choice) }
              if group.choices.first == .thisMachine { previewChips }
            }
          }
        }
      }
      .fixedSize(horizontal: true, vertical: false)
      Picker("Machine", selection: Binding(get: { selection }, set: select)) {
        ForEach(groups) { group in
          Section(group.title ?? "") {
            ForEach(group.choices, id: \.self) { choice in
              Text(verbatim: chip(choice).title).tag(choice)
            }
            if group.choices.first == .thisMachine { previewItems }
          }
        }
      }
      .pickerStyle(.menu)
      .frame(maxWidth: 360, alignment: .leading)
    }
  }

  private func button(_ choice: MachineChoice) -> some View {
    let item = chip(choice)
    let selected = choice == selection
    return Button {
      select(choice)
    } label: {
      MachineChipLabel(chip: item, selected: selected)
    }
    .buttonStyle(.hoverRow(radius: Radius.control, selected: selected))
    .accessibilityAddTraits(selected ? .isSelected : [])
    .help(item.help ?? "")
  }

  @ViewBuilder private var previewChips: some View {
    #if DEBUG
      ForEach(previews, id: \.self) { name in
        Button {
        } label: {
          MachineChipLabel(chip: MachineChip(title: name, subtitle: "Preview", tone: .tertiary), selected: false)
        }
        .buttonStyle(.hoverRow(radius: Radius.control))
        .disabled(true)
        .help("Visual preview only. This machine is not connected.")
      }
    #endif
  }

  @ViewBuilder private var previewItems: some View {
    #if DEBUG
      ForEach(previews, id: \.self) { name in
        Text("\(name) (preview)").tag(MachineChoice.remote("preview:\(name)")).disabled(true)
      }
    #endif
  }
}

private struct MachineChipLabel: View {
  var chip: MachineChip
  var selected: Bool

  var body: some View {
    HStack(spacing: Space.lg) {
      if let tone = chip.tone {
        StatusDot(color: Color(tone))
          .padding(2)
          .background(Circle().fill(selected ? Palette.onBrand : Color.clear))
          .accessibilityHidden(true)
      } else {
        Image(systemName: "laptopcomputer").accessibilityHidden(true)
      }
      VStack(alignment: .leading, spacing: Space.xxs) {
        Text(verbatim: chip.title).font(.stim(.callout, weight: .semibold))
        Text(verbatim: chip.subtitle).font(.stim(.caption))
          .foregroundStyle(selected ? Palette.onBrand.opacity(0.85) : Palette.secondary)
      }
    }
    .foregroundStyle(selected ? Palette.onBrand : Palette.text)
    .padding(.horizontal, Space.xl)
    .padding(.vertical, Space.lg)
    .frame(minWidth: 120, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: Radius.control).fill(selected ? Palette.brand : Palette.surface))
    .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(selected ? Color.clear : Palette.border))
    .contentShape(RoundedRectangle(cornerRadius: Radius.control))
  }
}
