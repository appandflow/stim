import StimKit
import SwiftUI

struct ConnectionConfirmationView: View {
  var confirmation: ConnectionConfirmation

  var body: some View {
    VStack(alignment: .leading, spacing: Space.md) {
      Label {
        Text(verbatim: confirmation.name).font(.stim(.headline))
      } icon: {
        Image(systemName: "checkmark.circle.fill").foregroundStyle(Palette.success)
      }
      fact("Direction") { Text(confirmation.direction.title) }
      fact("Access") { AccessPills(access: confirmation.access) }
      fact("Revoke") {
        VStack(alignment: .leading, spacing: Space.xs) {
          Text(confirmation.revoke).fixedSize(horizontal: false, vertical: true)
          ForEach(confirmation.revokeCommands, id: \.self) { command in
            CopyableCommand(
              command: command,
              runsOn: confirmation.direction == .usingThisMachine ? "this machine" : confirmation.name)
          }
        }
      }
    }
    .padding(Space.lg)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Palette.surface, in: RoundedRectangle(cornerRadius: Radius.card))
    .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Palette.border))
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Connection added")
  }

  private func fact<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: Space.md) {
      Text(label).font(.stim(.callout)).foregroundStyle(Palette.secondary).frame(width: 84, alignment: .leading)
      content().font(.stim(.callout))
    }
  }
}
