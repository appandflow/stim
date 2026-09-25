import Foundation
import Testing

@testable import StimKit

private let schema = Data(
  #"""
  {
    "type": "object",
    "properties": {
      "$schema": { "type": "string" },
      "ios": {
        "type": "object",
        "properties": {
          "remote": {
            "description": "Default remote backend for iOS", "type": "string", "enum": ["proxy", "eas"],
            "x-stim": { "key": "ios.remote", "kind": "choice", "scopes": ["workspace", "repo", "committed"] }
          }
        }
      },
      "android": {
        "type": "object",
        "properties": {
          "dataPartitionSizeGb": {
            "description": "Data partition size", "type": "integer", "minimum": 6, "maximum": 16384, "default": 8,
            "x-stim": { "key": "android.dataPartitionSizeGb", "kind": "number", "scopes": ["workspace", "repo", "committed"] }
          },
          "keystorePassword": {
            "description": "Keystore password", "type": "string", "pattern": "^(env|file):\\S",
            "x-stim": { "key": "android.keystorePassword", "kind": "string", "scopes": ["workspace", "repo", "committed"], "sensitive": true }
          }
        }
      },
      "worktree": {
        "type": "object",
        "properties": {
          "exclude": {
            "description": "Ignored paths", "type": "array", "items": { "type": "string" },
            "x-stim": { "key": "worktree.exclude", "kind": "strings", "scopes": ["repo", "committed"], "committedAt": "repository" }
          }
        }
      },
      "optimizations": {
        "type": "object",
        "properties": {
          "buildCache": {
            "description": "Build cache", "type": "boolean", "default": true,
            "x-stim": { "key": "optimizations.buildCache", "kind": "boolean", "scopes": ["machine", "workspace", "repo", "committed"] }
          }
        }
      }
    },
    "$defs": {
      "machine": {
        "type": "object",
        "properties": {
          "optimizations": {
            "type": "object",
            "properties": {
              "buildCache": {
                "description": "Build cache", "type": "boolean", "default": true,
                "x-stim": { "key": "optimizations.buildCache", "kind": "boolean", "scopes": ["machine", "workspace", "repo", "committed"] }
              }
            }
          },
          "tempDir": {
            "description": "Temporary copies", "type": "string",
            "x-stim": { "key": "tempDir", "kind": "path", "scopes": ["machine"], "absolute": true, "env": "STIM_TMPDIR" }
          }
        }
      }
    }
  }
  """#.utf8)

@Suite struct SettingsSchemaTests {
  @Test func readsEverySettingOnceWithItsLayersAndControl() throws {
    let fields = try SettingsSchema.fields(from: schema)
    #expect(
      fields.map(\.key) == [
        "android.dataPartitionSizeGb", "android.keystorePassword", "ios.remote", "optimizations.buildCache",
        "worktree.exclude", "tempDir",
      ])
    let byKey = Dictionary(uniqueKeysWithValues: fields.map { ($0.key, $0) })
    #expect(byKey["ios.remote"]?.control == .picker(["proxy", "eas"]))
    #expect(byKey["android.dataPartitionSizeGb"]?.control == .stepper(minimum: 6, maximum: 16384, integer: true))
    #expect(byKey["android.dataPartitionSizeGb"]?.defaultValue == .number(8))
    #expect(byKey["android.keystorePassword"]?.control == .secure)
    #expect(byKey["optimizations.buildCache"]?.control == .toggle)
    #expect(byKey["optimizations.buildCache"]?.scopes == [.machine, .workspace, .repo, .committed])
    #expect(byKey["worktree.exclude"]?.control == .tokens)
    #expect(byKey["worktree.exclude"]?.committedAtRepository == true)
    #expect(byKey["tempDir"]?.control == .filePicker)
    #expect(byKey["tempDir"]?.env == "STIM_TMPDIR")
  }

  @Test func refusesAFileThatDescribesNoSetting() {
    #expect(throws: SettingsSchema.Invalid.self) { try SettingsSchema.fields(from: Data(#"{"type":"object"}"#.utf8)) }
  }

  @Test func passesStringsAsIsAndEverythingElseAsJSON() throws {
    let fields = Dictionary(uniqueKeysWithValues: try SettingsSchema.fields(from: schema).map { ($0.key, $0) })
    #expect(fields["ios.remote"]?.argument(for: .string("eas")) == "eas")
    #expect(fields["android.dataPartitionSizeGb"]?.argument(for: .number(12)) == "12")
    #expect(fields["optimizations.buildCache"]?.argument(for: .bool(false)) == "false")
    #expect(fields["worktree.exclude"]?.argument(for: .array([.string("a b"), .string("c\"d")])) == #"["a b","c\"d"]"#)
  }

  @Test func findsTheSchemaBesideTheResolvedExecutable() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("stim-schema-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }
    let dist = root.appendingPathComponent("lib/node_modules/stim/dist")
    let bin = root.appendingPathComponent("bin")
    try FileManager.default.createDirectory(at: dist, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
    try Data().write(to: dist.appendingPathComponent("cli.mjs"))
    try schema.write(to: dist.appendingPathComponent("settings.schema.json"))
    try FileManager.default.createSymbolicLink(
      atPath: bin.appendingPathComponent("stim").path, withDestinationPath: "../lib/node_modules/stim/dist/cli.mjs")

    let found = SettingsSchema.locate(executable: bin.appendingPathComponent("stim").path)
    #expect(found?.resolvingSymlinksInPath() == dist.appendingPathComponent("settings.schema.json").resolvingSymlinksInPath())
    #expect(SettingsSchema.locate(executable: root.appendingPathComponent("nowhere/stim").path) == nil)
  }
}

@Suite struct SettingsPayloadTests {
  let payload = try! JSONDecoder().decode(
    SettingsPayload.self,
    from: Data(
      #"""
      {
        "project": "/repo/app",
        "files": { "machine": "/h/config.json", "committed": "/repo/app/.stim.json" },
        "settings": [
          { "key": "android.dataPartitionSizeGb", "value": 12, "origin": "repo", "layers": { "repo": 12, "committed": 10 } },
          { "key": "optimizations.buildCache", "value": true, "origin": "default", "layers": {} },
          { "key": "tempDir", "value": "/fast", "origin": "env", "layers": { "machine": "/slow" }, "env": { "name": "STIM_TMPDIR", "value": "/fast" } },
          { "key": "android.keystorePassword", "value": "********", "origin": "repo", "layers": { "repo": "********" }, "sensitive": true }
        ],
        "unknown": [{ "key": "bogus", "scope": "committed", "file": "/repo/app/.stim.json", "value": true }]
      }
      """#.utf8))
  let fields = Dictionary(uniqueKeysWithValues: try! SettingsSchema.fields(from: schema).map { ($0.key, $0) })

  @Test func namesTheLayerAWriteWouldOverride() throws {
    let size = try #require(payload.entry("android.dataPartitionSizeGb"))
    let field = try #require(fields["android.dataPartitionSizeGb"])
    #expect(size.overridden(by: .workspace, field: field)?.source == "repo")
    #expect(size.overridden(by: .repo, field: field)?.value == .number(10))
    #expect(size.overridden(by: .committed, field: field)?.source == "default")
    let cache = try #require(payload.entry("optimizations.buildCache"))
    #expect(cache.overridden(by: .committed, field: try #require(fields["optimizations.buildCache"]))?.value == .bool(true))
  }

  @Test func keepsTheEnvironmentOverrideAndUnknownKeys() throws {
    let temp = try #require(payload.entry("tempDir"))
    #expect(temp.origin == "env" && temp.env?.name == "STIM_TMPDIR" && temp.layer(.machine) == .string("/slow"))
    #expect(payload.unknown.map(\.key) == ["bogus"])
    #expect(payload.file(for: .committed) == "/repo/app/.stim.json")
    #expect(payload.file(for: .workspace) == nil)
  }

  @Test func decodesARefusal() throws {
    let refusal = try JSONDecoder().decode(
      SettingsRefusal.self,
      from: Data(#"{"code":"STIM_BAD_ARG","message":"Invalid x","remedy":null}"#.utf8))
    #expect(refusal == SettingsRefusal(code: "STIM_BAD_ARG", message: "Invalid x", remedy: nil))
  }
}

@Suite struct StatusEventTests {
  private func status(_ json: String) -> StatusPayload {
    try! JSONDecoder().decode(StatusPayload.self, from: Data(json.utf8))
  }

  private func workspace(build: String = "null", errors: Int = 0, ios: String = "Booted", remote: String = "[]") -> String {
    #"""
    {"path":"/w/app","live":true,"warnings":[],"metro":{"port":8081,"running":true},
     "ios":{"name":"stim-app (iPhone 17 26.0)","udid":"U1","owned":true,"state":"\#(ios)"},
     "logs":{"dir":"/l","errorsSinceMarker":\#(errors)},"build":\#(build),"remoteDevices":\#(remote)}
    """#
  }

  private func build(phase: String, state: String = "running") -> String {
    #"{"platform":"ios","slot":"default","state":"\#(state)","phase":"\#(phase)","startedAt":"2026-09-24T19:50:00Z","phaseStartedAt":"2026-09-24T19:50:00Z","basis":0}"#
  }

  private func events(_ before: String, _ after: String, overCapacity: Bool = false, reported: Set<String> = [])
    -> [StatusEvent]
  {
    let capacity = #"{"liveCount":1,"committedMb":9000,"totalMemoryMb":8000,"overCapacity":\#(overCapacity)}"#
    return StatusEvents.events(
      previous: status(#"{"environments":[\#(before)]}"#),
      current: status(#"{"environments":[\#(after)],"capacity":\#(capacity)}"#),
      now: ISO8601DateFormatter().date(from: "2026-09-24T20:30:00Z")!, remoteMinutes: 30, reported: reported)
  }

  @Test func reportsABuildThatInstalledAsFinishedAndOneThatStoppedEarlyAsEnded() {
    #expect(events(workspace(build: build(phase: "launch")), workspace()).map(\.title) == ["app: ios build finished"])
    #expect(
      events(workspace(build: build(phase: "compile")), workspace()).map(\.title)
        == ["app: ios build ended during compile"])
    #expect(
      events(workspace(build: build(phase: "pods")), workspace(build: build(phase: "pods", state: "stale")))
        .map(\.title) == ["app: ios build failed"])
    #expect(events(workspace(build: build(phase: "compile")), workspace(build: build(phase: "install"))).isEmpty)
  }

  @Test func reportsNewErrorsAndADeviceThatStoppedUnderARunningDevServer() {
    #expect(events(workspace(errors: 2), workspace(errors: 5)).map(\.title) == ["app: 3 new errors"])
    #expect(events(workspace(), workspace(ios: "Shutdown")).map(\.kind) == [.crash])
  }

  @Test func reportsMemoryOnceWhenCapacityIsFirstExceeded() {
    #expect(events(workspace(), workspace(), overCapacity: true).map(\.kind) == [.memory])
  }

  @Test func reportsARemoteSessionOncePastTheThreshold() {
    let session = #"[{"platform":"ios","backend":"eas","sessionId":"s1","state":"claimed","startedAt":"2026-09-24T19:50:00Z"}]"#
    let fresh = #"[{"platform":"ios","backend":"eas","sessionId":"s2","state":"claimed","startedAt":"2026-09-24T20:20:00Z"}]"#
    #expect(events(workspace(), workspace(remote: session)).map(\.id) == ["remote:s1"])
    #expect(events(workspace(), workspace(remote: session), reported: ["remote:s1"]).isEmpty)
    #expect(events(workspace(), workspace(remote: fresh)).isEmpty)
  }
}

@Suite struct ExternalAppTests {
  @Test func prefersTheChosenAppOnlyWhenItIsInstalled() {
    let installed: Set<String> = ["com.apple.dt.Xcode", "dev.zed.Zed"]
    #expect(ExternalApp.choose("dev.zed.Zed", from: ExternalApp.editors, isInstalled: installed.contains)?.name == "Zed")
    #expect(
      ExternalApp.choose("com.microsoft.VSCode", from: ExternalApp.editors, isInstalled: installed.contains)?.name
        == "Xcode")
    #expect(ExternalApp.choose(nil, from: ExternalApp.terminals, isInstalled: { _ in false }) == nil)
  }
}
