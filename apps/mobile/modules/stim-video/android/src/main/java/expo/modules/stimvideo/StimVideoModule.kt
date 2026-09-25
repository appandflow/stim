package expo.modules.stimvideo

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.typedarray.Uint8Array

class StimVideoModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("StimVideo")

    Function("push") { streamId: String, accessUnit: Uint8Array, width: Int, height: Int ->
      val view = StimVideoRegistry.view(streamId) ?: return@Function
      val bytes = ByteArray(accessUnit.byteLength)
      accessUnit.read(bytes, 0, bytes.size)
      view.push(bytes, width, height)
    }

    View(StimVideoView::class) {
      Events("onKeyframeNeeded")

      OnViewDestroys { view: StimVideoView -> view.destroy() }

      Prop("streamId") { view: StimVideoView, streamId: String? ->
        view.streamId = streamId
      }
    }
  }
}
