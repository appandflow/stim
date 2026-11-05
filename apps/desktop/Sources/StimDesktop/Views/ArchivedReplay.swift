import StimKit
import SwiftUI

@MainActor final class ArchivedReplayModel: ObservableObject {
  let controllers: [ReplayController]

  init(archive: String, recordings: [ArchiveDetail.Recording]? = nil) {
    let targets =
      recordings?.map { ReplayTarget(archive: archive, platform: $0.platform, slot: $0.slot) }
      ?? ["ios", "android", "web"].map { ReplayTarget(archive: archive, platform: $0) }
    controllers = targets.map { target in
      let controller = ReplayController(target: target)
      controller.previews.decode = ReplayPreviewDecoder.shared.decode
      return controller
    }
  }

  func connect(_ server: ReplayServer?) async {
    for controller in controllers { controller.connect(nil) }
    guard let server else { return }
    for controller in controllers {
      guard !Task.isCancelled else { return }
      await controller.connect(server)?.value
    }
  }

  func stop() {
    for controller in controllers { controller.stop() }
  }
}

struct ArchivedReplays: View {
  @ObservedObject private var session = ServerSession.shared
  @StateObject private var model: ArchivedReplayModel

  init(archive: String, recordings: [ArchiveDetail.Recording]? = nil) {
    _model = StateObject(wrappedValue: ArchivedReplayModel(archive: archive, recordings: recordings))
  }

  var body: some View {
    VStack(alignment: .leading, spacing: Space.xxl) {
      ForEach(model.controllers, id: \.target) { controller in
        ArchivedReplay(controller: controller, platform: controller.target.platform)
      }
    }
    .task(id: session.isOpen) { await model.connect(session.isOpen ? session.client : nil) }
    .onDisappear { model.stop() }
  }
}

private struct ArchivedReplay: View {
  @ObservedObject var controller: ReplayController
  var platform: String

  var body: some View {
    if let timeline = controller.timeline {
      VStack(alignment: .leading, spacing: Space.md) {
        SectionLabel(title: "Replay \u{00B7} \(platformName(platform)) \u{00B7} \(controller.target.slot)")
        ReplayScreen(controller: controller, onPixelSizeChange: { _ in })
          .frame(height: 360)
        ReplayBar(controller: controller, running: false, replayOff: false)
        if let error = controller.error { Text(error).foregroundStyle(Palette.secondary) }
      }
      .onAppear { controller.seek(at: timeline.start, rate: 0) }
    } else if let error = controller.error {
      Text(error).foregroundStyle(Palette.secondary)
    }
  }
}
