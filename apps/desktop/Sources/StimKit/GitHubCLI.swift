import Foundation

/// `gh` from Stim Desktop's `PATH`.
public struct GitHubCLI: Sendable {
  public let executable: String?
  let environment: [String: String]
  let registry: ProcessRegistry?

  /// With a `registry`, its `terminateAll` also terminates every run.
  public init(environment: [String: String], registry: ProcessRegistry? = nil) {
    var environment = environment
    executable = resolveExecutable("gh", override: nil, environment: &environment)
    environment["GH_PROMPT_DISABLED"] = "1"
    environment["GH_NO_UPDATE_NOTIFIER"] = "1"
    self.environment = environment
    self.registry = registry
  }

  /// Stdout of a run that exited 0 within `timeout`, else nil.
  public func run(_ arguments: [String], cwd: String, timeout: TimeInterval = 30) -> Data? {
    guard let executable else { return nil }
    var request = ProcessRequest(executable, arguments, cwd: cwd, environment: environment, timeout: timeout)
    request.registry = registry
    guard let result = try? request.runBlocking(), result.succeeded else { return nil }
    return result.stdout
  }
}
