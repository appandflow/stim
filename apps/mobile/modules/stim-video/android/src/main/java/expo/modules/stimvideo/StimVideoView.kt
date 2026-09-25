package expo.modules.stimvideo

import android.content.Context
import android.media.MediaCodec
import android.media.MediaFormat
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.view.SurfaceHolder
import android.view.SurfaceView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.lang.ref.WeakReference
import java.nio.ByteBuffer
import java.util.ArrayDeque

class StimVideoView(context: Context, appContext: AppContext) : ExpoView(context, appContext), SurfaceHolder.Callback {
  override val shouldUseAndroidLayout = true

  private val onKeyframeNeeded by EventDispatcher()
  private val surfaceView = SurfaceView(context)
  private val thread = HandlerThread("stim.video.decode").apply { start() }
  private val handler = Handler(thread.looper)

  private var codec: MediaCodec? = null
  private var sps: ByteArray? = null
  private var pps: ByteArray? = null
  private var size = Pair(0, 0)
  private var surfaceReady = false
  private var waitingForKeyframe = true
  private val inputs = ArrayDeque<ByteArray>()
  private val freeInputs = ArrayDeque<Int>()

  var streamId: String? = null
    set(value) {
      field?.let { StimVideoRegistry.remove(it, this) }
      field = value
      value?.let { StimVideoRegistry.add(it, this) }
    }

  init {
    setBackgroundColor(android.graphics.Color.BLACK)
    surfaceView.holder.addCallback(this)
    addView(surfaceView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  fun destroy() {
    streamId?.let { StimVideoRegistry.remove(it, this) }
    handler.post {
      release()
      thread.quitSafely()
    }
  }

  override fun surfaceCreated(holder: SurfaceHolder) {
    handler.post {
      surfaceReady = true
      waitingForKeyframe = true
      requestKeyframe()
    }
  }

  override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {}

  override fun surfaceDestroyed(holder: SurfaceHolder) {
    val done = java.util.concurrent.CountDownLatch(1)
    val posted = handler.post {
      surfaceReady = false
      release()
      done.countDown()
    }
    if (posted) done.await(1, java.util.concurrent.TimeUnit.SECONDS)
  }

  fun push(accessUnit: ByteArray, width: Int, height: Int) {
    handler.post { decode(accessUnit, width, height) }
  }

  private fun decode(accessUnit: ByteArray, width: Int, height: Int) {
    var keyframe = false
    var parametersChanged = false
    for (unit in AnnexB.units(accessUnit)) {
      when (AnnexB.type(accessUnit, unit)) {
        NalType.SPS -> accessUnit.copyOfRange(unit.first, unit.last + 1).let {
          if (!it.contentEquals(sps)) { sps = it; parametersChanged = true }
        }
        NalType.PPS -> accessUnit.copyOfRange(unit.first, unit.last + 1).let {
          if (!it.contentEquals(pps)) { pps = it; parametersChanged = true }
        }
        NalType.IDR -> keyframe = true
      }
    }
    if (parametersChanged || size != Pair(width, height)) {
      release()
      size = Pair(width, height)
    }
    if (!surfaceReady) return
    if (codec == null && (!keyframe || !configure())) return requestKeyframe()
    if (waitingForKeyframe) {
      if (!keyframe) return requestKeyframe()
      waitingForKeyframe = false
    }
    if (inputs.size >= MAX_BACKLOG) {
      inputs.clear()
      if (!keyframe) {
        waitingForKeyframe = true
        requestKeyframe()
        return
      }
    }
    inputs.add(accessUnit)
    feed()
  }

  private fun configure(): Boolean {
    val sps = sps ?: return false
    val pps = pps ?: return false
    val (width, height) = size
    if (width <= 0 || height <= 0) return false
    val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height).apply {
      setByteBuffer("csd-0", ByteBuffer.wrap(START_CODE + sps))
      setByteBuffer("csd-1", ByteBuffer.wrap(START_CODE + pps))
      setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, width * height)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
    }
    var created: MediaCodec? = null
    return try {
      created = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
      created.setCallback(Callbacks(), handler)
      created.configure(format, surfaceView.holder.surface, null, 0)
      created.start()
      codec = created
      waitingForKeyframe = true
      true
    } catch (error: Exception) {
      android.util.Log.w("StimVideo", "Could not start the H.264 decoder: ${error.message}")
      created?.release()
      false
    }
  }

  private fun feed() {
    val codec = codec ?: return
    while (inputs.isNotEmpty() && freeInputs.isNotEmpty()) {
      val index = freeInputs.poll()!!
      val bytes = inputs.poll()!!
      val buffer = codec.getInputBuffer(index) ?: continue
      if (bytes.size > buffer.capacity()) {
        codec.queueInputBuffer(index, 0, 0, 0, 0)
        inputs.clear()
        waitingForKeyframe = true
        requestKeyframe()
        continue
      }
      buffer.clear()
      buffer.put(bytes)
      codec.queueInputBuffer(index, 0, bytes.size, System.nanoTime() / 1000, 0)
    }
  }

  private fun release() {
    codec?.let {
      try {
        it.stop()
      } catch (_: Exception) {}
      it.release()
    }
    codec = null
    inputs.clear()
    freeInputs.clear()
    waitingForKeyframe = true
  }

  private var lastKeyframeRequest = 0L

  private fun requestKeyframe() {
    val now = android.os.SystemClock.elapsedRealtime()
    if (now - lastKeyframeRequest < KEYFRAME_REQUEST_INTERVAL_MS) return
    lastKeyframeRequest = now
    post { onKeyframeNeeded(mapOf()) }
  }

  private inner class Callbacks : MediaCodec.Callback() {
    override fun onInputBufferAvailable(codec: MediaCodec, index: Int) {
      if (codec !== this@StimVideoView.codec) return
      freeInputs.add(index)
      feed()
    }

    override fun onOutputBufferAvailable(codec: MediaCodec, index: Int, info: MediaCodec.BufferInfo) {
      if (codec !== this@StimVideoView.codec) return
      codec.releaseOutputBuffer(index, true)
    }

    override fun onError(codec: MediaCodec, error: MediaCodec.CodecException) {
      if (codec !== this@StimVideoView.codec) return
      android.util.Log.w("StimVideo", "The H.264 decoder failed: ${error.diagnosticInfo}")
      handler.post {
        if (codec === this@StimVideoView.codec) release()
        requestKeyframe()
      }
    }

    override fun onOutputFormatChanged(codec: MediaCodec, format: MediaFormat) {}
  }

  private companion object {
    val START_CODE = byteArrayOf(0, 0, 0, 1)
    const val MAX_BACKLOG = 3
    const val KEYFRAME_REQUEST_INTERVAL_MS = 500L
  }
}

internal object StimVideoRegistry {
  private val views = HashMap<String, WeakReference<StimVideoView>>()

  @Synchronized
  fun add(id: String, view: StimVideoView) {
    views[id] = WeakReference(view)
  }

  @Synchronized
  fun remove(id: String, view: StimVideoView) {
    if (views[id]?.get() === view) views.remove(id)
  }

  @Synchronized
  fun view(id: String): StimVideoView? = views[id]?.get()
}
