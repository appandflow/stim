import Foundation

/// A machine the Machines page can show.
public enum MachineChoice: Hashable, Sendable {
  case thisMachine
  /// A `remote.machines` entry: this machine's work placed there.
  case remote(String)
  /// A paired server, by `PairedServer.id`: its own work, as it reports it.
  case paired(String)
}

/// One row of machine chips. `title` is nil when the page has a single group, since a lone label says nothing.
public struct MachineChoiceGroup: Hashable, Identifiable, Sendable {
  public var title: String?
  public var choices: [MachineChoice]

  public var id: String { title ?? "machines" }
}

public enum MachineChoices {
  public static let thisMachineName = "This machine"
  public static let yoursTitle = "Your machines"
  public static let viewingTitle = "Viewing"

  /// "Your machines" holds this machine and the remote machines it sends work to; "Viewing" holds the paired
  /// machines whose work this machine only looks at.
  public static func groups(remote: [String], paired: [String]) -> [MachineChoiceGroup] {
    let yours = [MachineChoice.thisMachine] + remote.map(MachineChoice.remote)
    guard !paired.isEmpty else { return [MachineChoiceGroup(title: nil, choices: yours)] }
    return [
      MachineChoiceGroup(title: yoursTitle, choices: yours),
      MachineChoiceGroup(title: viewingTitle, choices: paired.map(MachineChoice.paired)),
    ]
  }
}
