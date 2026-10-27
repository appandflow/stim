import StimKit
import SwiftUI

/// The Tools section of a local simulator's or emulator's options popover: location, privacy permissions, a test push
/// and the Android network. Each button runs one `stim device` command through the CLI, which checks that the device
/// is this workspace's own, and shows what the CLI reported.
struct DeviceToolsView: View {
  let platform: String
  let run: (DeviceTool) async throws -> DeviceToolResult
  @State private var coordinate = ""
  @State private var service: String
  @State private var pushTitle = "Stim"
  @State private var pushBody = "Test notification"
  @State private var busy = false
  @State private var status: Status?

  private enum Status {
    case done(String)
    case failed(String)
  }

  private static let places: [(name: String, coordinate: String)] = [
    ("San Francisco", "37.7749, -122.4194"), ("Montreal", "45.5017, -73.5673"),
    ("London", "51.5072, -0.1276"), ("Tokyo", "35.6762, 139.6503"),
  ]

  init(platform: String, run: @escaping (DeviceTool) async throws -> DeviceToolResult) {
    self.platform = platform
    self.run = run
    _service = State(initialValue: platform == "ios" ? "photos" : "camera")
  }

  var body: some View {
    VStack(alignment: .leading, spacing: Space.md) {
      HStack {
        Text("Tools").font(.stim(.headline))
        Spacer()
        if busy { ProgressView().controlSize(.small) }
      }
      location
      permission
      if platform == "ios" { push } else { network }
      if let status {
        switch status {
        case .done(let text):
          Text(text).font(.stim(.caption)).foregroundStyle(Palette.secondary)
            .fixedSize(horizontal: false, vertical: true)
        case .failed(let text):
          Text(text).font(.stim(.caption)).foregroundStyle(Palette.warning)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
  }

  private var location: some View {
    VStack(alignment: .leading, spacing: Space.sm) {
      HStack {
        Text("Location")
        Spacer()
        Menu("Place") {
          ForEach(Self.places, id: \.name) { place in
            Button(place.name) { coordinate = place.coordinate }
          }
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
      }
      HStack(spacing: Space.sm) {
        TextField("Latitude, longitude", text: $coordinate)
          .textFieldStyle(.roundedBorder)
        Button("Set") {
          if let point = DeviceTool.parseCoordinate(coordinate) {
            perform(.setLocation(latitude: point.latitude, longitude: point.longitude))
          }
        }
        .buttonStyle(.stim(.secondary))
        .disabled(busy || DeviceTool.parseCoordinate(coordinate) == nil)
        if platform == "ios" {
          Button("Clear") { perform(.clearLocation) }
            .buttonStyle(.stim(.secondary))
            .disabled(busy)
        }
      }
    }
  }

  private var permission: some View {
    VStack(alignment: .leading, spacing: Space.sm) {
      Picker("Permission", selection: $service) {
        ForEach(DeviceTool.services(platform: platform), id: \.self) { Text($0).tag($0) }
      }
      HStack(spacing: Space.sm) {
        ForEach(DeviceTool.PermissionAction.allCases, id: \.self) { action in
          Button(action.rawValue.capitalized) { perform(.permission(action, service: service)) }
            .buttonStyle(.stim(.secondary))
            .disabled(busy)
        }
      }
    }
  }

  private var push: some View {
    VStack(alignment: .leading, spacing: Space.sm) {
      Text("Test push")
      TextField("Title", text: $pushTitle).textFieldStyle(.roundedBorder)
      HStack(spacing: Space.sm) {
        TextField("Message", text: $pushBody).textFieldStyle(.roundedBorder)
        Button("Send") { perform(.push(payload: pushPayload)) }
          .buttonStyle(.stim(.secondary))
          .disabled(busy)
      }
    }
  }

  private var network: some View {
    HStack(spacing: Space.sm) {
      Text("Network")
      Spacer()
      Button("Off") { perform(.network(enabled: false)) }
        .buttonStyle(.stim(.secondary))
        .disabled(busy)
      Button("On") { perform(.network(enabled: true)) }
        .buttonStyle(.stim(.secondary))
        .disabled(busy)
    }
  }

  private var pushPayload: String {
    let alert: [String: Any] = ["title": pushTitle, "body": pushBody]
    let payload: [String: Any] = ["aps": ["alert": alert, "sound": "default"]]
    let data = try? JSONSerialization.data(withJSONObject: payload)
    return data.flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
  }

  private func perform(_ tool: DeviceTool) {
    guard !busy else { return }
    busy = true
    status = nil
    Task {
      defer { busy = false }
      do {
        status = .done(try await run(tool).summary)
      } catch {
        status = .failed(error.localizedDescription)
      }
    }
  }
}
