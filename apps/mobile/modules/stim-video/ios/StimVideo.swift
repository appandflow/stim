internal import ExpoModulesCore

class StimVideo: Module {
  func definition() -> ModuleDefinition {
    Name("StimVideo")

    Function("push") { (streamId: String, accessUnit: Uint8Array, _: Int, _: Int) in
      guard let view = StimVideoRegistry.view(streamId) else { return }
      view.push(Data(bytes: accessUnit.rawPointer, count: accessUnit.byteLength))
    }

    Function("pushWithOrientation") {
      (streamId: String, accessUnit: Uint8Array, _: Int, _: Int, generation: Int) in
      guard let view = StimVideoRegistry.view(streamId) else { return }
      view.push(Data(bytes: accessUnit.rawPointer, count: accessUnit.byteLength), generation: generation)
    }

    View(StimVideoView.self) {
      Events("onKeyframeNeeded", "onOrientationCleared")

      Prop("streamId") { (view: StimVideoView, streamId: String?) in
        view.streamId = streamId
      }
    }
  }
}
