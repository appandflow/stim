internal import ExpoModulesCore

class StimVideo: Module {
  func definition() -> ModuleDefinition {
    Name("StimVideo")

    Function("push") { (streamId: String, accessUnit: Uint8Array, _: Int, _: Int) in
      guard let view = StimVideoRegistry.view(streamId) else { return }
      view.push(Data(bytes: accessUnit.rawPointer, count: accessUnit.byteLength))
    }

    View(StimVideoView.self) {
      Events("onKeyframeNeeded")

      Prop("streamId") { (view: StimVideoView, streamId: String?) in
        view.streamId = streamId
      }
    }
  }
}
