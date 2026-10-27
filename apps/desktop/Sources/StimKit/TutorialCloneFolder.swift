import Foundation

public struct TutorialCloneFolder: Equatable, Sendable {
  public enum Stage: Equatable, Sendable {
    case absent, cloning, cloned, installing, installed
  }

  public var created: Date?
  public var checkedOut: Bool
  public var dependenciesFolder: Bool
  public var dependenciesInstalled: Bool

  public init(created: Date?, checkedOut: Bool = false, dependenciesFolder: Bool = false, dependenciesInstalled: Bool = false) {
    self.created = created
    self.checkedOut = checkedOut
    self.dependenciesFolder = dependenciesFolder
    self.dependenciesInstalled = dependenciesInstalled
  }

  /// The npm completion marker: the tutorial app ships a package-lock.json and the run guide installs with npm ci.
  public init(path: String, fileManager: FileManager = .default) {
    let created = (try? fileManager.attributesOfItem(atPath: path))?[.creationDate] as? Date
    self.init(
      created: created,
      checkedOut: fileManager.fileExists(atPath: path + "/.git/HEAD") && fileManager.fileExists(atPath: path + "/package.json"),
      dependenciesFolder: fileManager.fileExists(atPath: path + "/node_modules"),
      dependenciesInstalled: fileManager.fileExists(atPath: path + "/node_modules/.package-lock.json"))
  }

  public func stage(since start: Date) -> Stage {
    guard let created, created >= start else { return .absent }
    if !checkedOut { return .cloning }
    if dependenciesInstalled { return .installed }
    return dependenciesFolder ? .installing : .cloned
  }
}
