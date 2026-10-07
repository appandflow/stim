#if DEBUG
  import SimulatorFrames
  import StimKit
  import StimStores
  import SwiftUI

  enum PlaygroundScenario: String, CaseIterable, Identifiable {
    case ready = "Ready"
    case loading = "Loading"
    case empty = "Empty"
    case error = "Error"
    case longText = "Long text"
    case largeData = "Large data"
    var id: Self { self }
  }

  struct PlaygroundSimulator {
    let loading: Bool
    let error: String?
    private var values: [String: Any]

    init(scenario: PlaygroundScenario) {
      loading = scenario == .loading
      error = scenario == .error ? "Xcode did not report the simulator's appearance settings. Refresh to try again." : nil
      values =
        scenario == .empty || loading || error != nil
        ? [:]
        : [
          "deviceIdentifier": "playground", "userInterfaceStyle": "light", "textSize": "large",
          "largerAccessibilitySizesEnabled": false, "increaseContrast": false,
          "reduceMotion": ["enabled": false], "reduceTransparency": ["enabled": false],
          "showBorders": ["enabled": false],
        ]
    }

    var appearance: SimulatorAppearance? {
      guard !values.isEmpty, let data = try? JSONSerialization.data(withJSONObject: values) else { return nil }
      return try? JSONDecoder().decode(SimulatorAppearance.self, from: data)
    }

    mutating func apply(_ change: SimulatorOptions.Change?) {
      guard !loading, error == nil else { return }
      switch change {
      case .mode(let mode): values["userInterfaceStyle"] = mode.rawValue
      case .textSize(let size): values["textSize"] = size.rawValue
      case .largerSizes(let value): values["largerAccessibilitySizesEnabled"] = value
      case .increaseContrast(let value): values["increaseContrast"] = value
      case .reduceMotion(let value): values["reduceMotion"] = ["enabled": value]
      case .reduceTransparency(let value): values["reduceTransparency"] = ["enabled": value]
      case .showBorders(let value): values["showBorders"] = ["enabled": value]
      case nil: break
      }
    }
  }

  @MainActor
  struct PlaygroundFixtures {
    static let workspace = "/Playground/checkout/apps/mobile"
    let inbox: NotificationInbox
    let settings: SettingsModel
    let environment: Workspace
    let archive: ArchivedWorkspace
    let checks: BuildPlanChecks

    static func make(_ scenario: PlaygroundScenario, now: Date = Date()) throws -> Self {
      let long = "The workspace with a very long branch name for accessibility and narrow-window review"
      let notificationCount = scenario == .empty ? 0 : scenario == .largeData ? Inbox.limit : 6
      let entries = (0..<notificationCount).map { index in
        InboxEntry(
          id: "fixture-\(index)",
          notification: OversightNotification(
            id: "fixture-\(index)", category: index.isMultiple(of: 2) ? .finished : .stuck,
            title: scenario == .longText ? long : index.isMultiple(of: 2) ? "feature-search" : "fix-navigation",
            body: scenario == .longText
              ? "The build finished, but the application could not confirm its connection to Metro. Review the retained output before restarting this workspace."
              : index.isMultiple(of: 2) ? "The iOS build finished successfully." : "No activity has been observed for 8 minutes.",
            quiet: false, thread: nil,
            target: .workspace(path: index.isMultiple(of: 2) ? workspace : "/Playground/other/apps/mobile")
          ), date: now.addingTimeInterval(-Double(index) * 1200)
        )
      }
      let schema: [String: Any] = [
        "properties": [
          "cache": field(
            "optimizations.buildCache", kind: "boolean", value: true, description: "Keep the native build cache enabled."),
          "limit": field(
            "concurrency.maxBuilds", kind: "number", value: 0, description: "Concurrent native builds; 0 means no limit",
            scopes: ["machine"]),
          "viewer": field(
            "iosSimulatorApp", kind: "choice", value: "stim-desktop", description: "App that displays an owned iOS simulator.",
            scopes: ["machine"]),
          "model": field(
            "ios.deviceType", kind: "string", value: scenario == .longText ? long : "iPhone 17 Pro",
            description: "Simulator model for owned simulators"),
        ]
      ]
      let fields = try SettingsSchema.fields(from: JSONSerialization.data(withJSONObject: schema))
      let payload: SettingsPayload = try decode([
        "project": workspace,
        "files": scenario == .empty
          ? ["machine": "/Playground/config.json"]
          : [
            "machine": "/Playground/config.json", "workspace": "\(workspace)/.stim.json",
            "repo": "/Playground/checkout/.stim.json", "committed": "\(workspace)/.stim.json",
          ],
        "settings": fields.map { field in
          ["key": field.key, "value": value(field.defaultValue), "origin": "default", "layers": [:]] as [String: Any]
        }, "unknown": [],
      ])
      let phases: [String: Double] = [
        "prepare": 200, "cache-lookup": 600, "prebuild": 2400, "pods": 5200,
        "compile": 112000, "install": 7000, "launch": 1000,
      ]
      let miss: [String: Any] = [
        "kind": "changed", "summary": "Native sources changed",
        "changes": [
          ["source": "ios/Example/AppDelegate.swift", "change": "changed", "category": "native-source"],
          ["source": "node_modules/expo-clipboard", "change": "added", "category": "native-dependency"],
          ["source": "ios/Example/OldBridge.swift", "change": "removed", "category": "native-source"],
        ],
        "changeCount": 5, "baseline": ["fingerprint": "0123456789abcdef", "from": "workspace"], "rekeyedBy": [],
      ]
      var env: [String: Any] = ["path": workspace, "live": false, "warnings": []]
      if scenario != .empty {
        let count = scenario == .largeData ? 10 : 3
        let builds = (0..<count).map { index -> [String: Any] in
          let failed = scenario == .error || (scenario == .longText && index == 0)
          let date = now.addingTimeInterval(-Double(index + 1) * 600)
          let cacheHit: Any = failed || (scenario == .largeData && index == 0) ? false : index.isMultiple(of: 2) ? "local" : false
          var build: [String: Any] = [
            "platform": "ios", "status": failed ? "failed" : "ok", "cacheHit": cacheHit,
            "durationMs": 128400, "startedAt": date.ISO8601Format(),
            "finishedAt": date.addingTimeInterval(128.4).ISO8601Format(), "fingerprint": "abc123456789abcd",
            "result": failed ? "failed" : "succeeded", "slot": "default", "configuration": "Debug",
            "phases": failed ? phases.filter { !["install", "launch"].contains($0.key) } : phases,
          ]
          if scenario == .largeData && index == 0 {
            build["missReason"] = miss
            build["offloadFallback"] =
              "janics-mac-mini: busy with another native build; no less loaded than this Mac, so compilation ran here."
          }
          if failed {
            build["missReason"] = miss
            build["errorCode"] = "STIM_IOS_BUILD_FAILED"
            build["diagnostics"] = (0..<3).map { line in
              [
                "file": "\(workspace)/ios/Example/Components/WorkspaceHeader.swift", "line": 48 + line,
                "message": scenario == .longText
                  ? "Cannot convert the returned value to the expected type. Verify the component's generic constraints and the dependency versions used by this checkout."
                  : "Cannot find type 'WorkspaceHeader' in scope",
              ] as [String: Any]
            }
          }
          return build
        }
        env["lastBuilds"] = ["ios": builds[0]]
        env["builds"] = ["ios": builds]
        if scenario == .largeData {
          let android = builds.map { build in
            var build = build
            build["platform"] = "android"
            return build
          }
          env["lastBuilds"] = ["ios": builds[0], "android": android[0]]
          env["builds"] = ["ios": builds, "android": android]
        }
      }
      if scenario == .loading {
        let date = now.addingTimeInterval(-30).ISO8601Format()
        env["build"] = [
          "platform": "ios", "slot": "default", "state": "running", "phase": "compile",
          "startedAt": date, "phaseStartedAt": date, "basis": 3, "expectedMs": 120000,
          "expectedPhaseMs": 100000, "outcome": "cold", "outcomeKnown": true,
          "cacheLookupOutcome": "miss", "missReason": miss, "missProvisional": true,
          "placement": ["host": "janics-mac-mini", "phase": "build", "startedAt": date, "phaseStartedAt": date],
          "plannedPhases": phases.map { ["phase": $0.key, "expectedMs": $0.value] as [String: Any] },
          "waitingFor": [
            "kind": "device-slot", "inUse": 2, "max": 2, "since": now.addingTimeInterval(-42).ISO8601Format(),
          ],
          "detail": [
            "step": "compile", "unit": "targets", "done": 45, "total": 180,
            "line": "CompileSwift ios/Example/Components/WorkspaceHeader.swift",
          ],
        ]
      }
      let plan: BuildPlan = try decode([
        "platform": "ios", "fingerprint": "fixture-fingerprint", "cacheHit": "local", "cacheSkipped": false,
        "basis": 3, "outcome": "hit", "expectedMs": 8400,
      ])
      return Self(
        inbox: NotificationInbox(fixtures: Inbox(entries: entries)),
        settings: SettingsModel(
          fixtures: fields, payload: scenario == .loading ? nil : payload,
          error: scenario == .error ? "The settings response could not be read. Check the selected workspace and retry." : nil
        ),
        environment: try decode(env),
        archive: try archived(now: now, last: env["lastBuilds"] as? [String: Any], miss: miss),
        checks: BuildPlanChecks { _, _ in
          if scenario == .error { throw PlaygroundFailure.plan }
          return .plan(plan)
        }
      )
    }

    private static func archived(now: Date, last: [String: Any]?, miss: [String: Any]) throws -> ArchivedWorkspace {
      var build = last?["ios"] as? [String: Any]
      build?["cacheHit"] = false
      build?["missReason"] = miss
      let stamp = ISO8601DateFormatter()
      return try decode([
        "id": "playground-archive", "projectRoot": workspace, "project": "Example", "workspace": "feature-search",
        "worktree": [
          "repository": "/Playground/checkout", "branch": "feature-search", "head": "abc123",
          "subject": "Add search", "merged": true,
          "pullRequest": [
            "number": 2602, "state": "merged", "title": "Keep earlier workspace runs", "url": "https://example.invalid/pull/2602",
          ],
        ],
        "removedAt": stamp.string(from: now.addingTimeInterval(-172800)), "removedBy": "worktree-remove",
        "lastUsedAt": stamp.string(from: now.addingTimeInterval(-173000)),
        "builds": ["count": 4, "last": build.map { $0 as Any } ?? NSNull(), "lastErrorCount": 0],
        "agents": [
          [
            "tool": "codex", "sessionId": "ended-fixture", "cwd": workspace, "title": "Add search",
            "endedAt": stamp.string(from: now.addingTimeInterval(-173000)),
          ]
        ],
        "bytes": ["logs": 1048576, "recordings": 2097152, "agentActions": 1024, "record": 1024, "total": 3147776],
        "expires": ["logs": NSNull(), "recordings": NSNull(), "agentActions": NSNull(), "record": NSNull()],
        "version": 1, "replacedBy": workspace,
      ])
    }

    private static func field(
      _ key: String, kind: String, value: Any, description: String,
      scopes: [String] = ["machine", "repo", "workspace", "committed"]
    ) -> [String: Any] {
      var field: [String: Any] = [
        "type": kind == "choice" ? "string" : kind == "number" ? "integer" : kind, "default": value, "description": description,
        "x-stim": ["key": key, "kind": kind, "scopes": scopes],
      ]
      if kind == "choice" { field["enum"] = ["xcode", "siniulator", "stim-desktop"] }
      if kind == "number" {
        field["minimum"] = 0
      }
      return field
    }

    private static func value(_ value: JSONValue?) -> Any {
      switch value {
      case .bool(let value): return value
      case .number(let value): return value
      case .string(let value): return value
      default: return NSNull()
      }
    }

    private static func decode<T: Decodable>(_ object: [String: Any]) throws -> T {
      try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: object))
    }
  }

  private enum PlaygroundFailure: LocalizedError {
    case plan
    var errorDescription: String? { "The build plan is unavailable. Check the workspace's native project and retry." }
  }
#endif
