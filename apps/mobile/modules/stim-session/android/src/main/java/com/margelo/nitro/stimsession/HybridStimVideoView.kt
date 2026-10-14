package com.margelo.nitro.stimsession

import android.graphics.Color
import android.media.MediaCodec
import android.media.MediaFormat
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Log
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.widget.FrameLayout
import androidx.annotation.Keep
import com.facebook.proguard.annotations.DoNotStrip
import com.facebook.react.uimanager.ThemedReactContext
import com.margelo.nitro.views.RecyclableView
import java.nio.ByteBuffer
import java.util.ArrayDeque
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Decodes the H.264 of the `VideoStream` it is given with MediaCodec onto a SurfaceView. It stays black until a
 * keyframe carrying its SPS and PPS arrives, and fills its bounds.
 */
@DoNotStrip
@Keep
class HybridStimVideoView(context: ThemedReactContext) :
  HybridStimVideoViewSpec(), VideoConsumer, RecyclableView, SurfaceHolder.Callback {
  private val surfaceView = SurfaceView(context)
  private val cover = View(context).apply {
    setBackgroundColor(Color.BLACK)
    visibility = View.GONE
  }
  override val view: FrameLayout = FrameLayout(context).apply {
    setBackgroundColor(Color.BLACK)
    addView(surfaceView, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    addView(cover, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
  }

  override var onKeyframeNeeded: (() -> Unit)? = null
  override var onOrientationCleared: ((generation: Double) -> Unit)? = null

  override var stream: HybridVideoStreamSpec? = null
    set(value) {
      field = value
      attach(value as? HybridVideoStream)
    }

  private val thread = HandlerThread("stim.video.decode").apply { start() }
  private val handler = Handler(thread.looper)
  @Volatile private var attached: HybridVideoStream? = null
  @Volatile private var generation = 0
  private var codec: MediaCodec? = null
  private var sps: ByteArray? = null
  private var pps: ByteArray? = null
  private var size = Pair(0, 0)
  private var surfaceReady = false
  private var waitingForKeyframe = true
  private val inputs = ArrayDeque<Pair<ByteArray, Long>>()
  private val freeInputs = ArrayDeque<Int>()
  private var lastKeyframeRequest = 0L

  init {
    surfaceView.holder.addCallback(this)
  }

  override fun onDropView() {
    attach(null)
    handler.post {
      release()
      thread.quitSafely()
    }
  }

  override fun prepareForRecycle() {
    attach(null)
  }

  override fun decode(accessUnit: ByteArray, width: Int, height: Int, generation: Int, received: Long) {
    handler.post { decodeOnThread(accessUnit, width, height, generation, received) }
  }

  private fun attach(next: HybridVideoStream?) {
    if (attached === next) return
    attached?.detach(this)
    attached = next
    handler.post {
      release()
      sps = null
      pps = null
      size = Pair(0, 0)
      generation = 0
    }
    next?.attach(this)
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
    val done = CountDownLatch(1)
    val posted = handler.post {
      surfaceReady = false
      release()
      done.countDown()
    }
    if (posted) done.await(1, TimeUnit.SECONDS)
  }

  private fun decodeOnThread(accessUnit: ByteArray, width: Int, height: Int, generation: Int, received: Long) {
    if (this.generation != generation) {
      this.generation = generation
      release()
      view.post {
        cover.visibility = View.VISIBLE
        onOrientationCleared?.invoke(generation.toDouble())
      }
    }
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
    if (!surfaceReady) return dropped()
    if (codec == null && (!keyframe || !configure())) {
      dropped()
      return requestKeyframe()
    }
    if (waitingForKeyframe) {
      if (!keyframe) {
        dropped()
        return requestKeyframe()
      }
      waitingForKeyframe = false
    }
    if (inputs.size >= MAX_BACKLOG) {
      repeat(inputs.size) { dropped() }
      inputs.clear()
      if (!keyframe) {
        dropped()
        waitingForKeyframe = true
        requestKeyframe()
        return
      }
    }
    inputs.add(Pair(accessUnit, received))
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
      val configuredGeneration = generation
      created.setOnFrameRenderedListener({ rendered, _, _ ->
        if (rendered === codec && configuredGeneration == generation) {
          rendered.setOnFrameRenderedListener(null, handler)
          view.post { if (configuredGeneration == generation) cover.visibility = View.GONE }
        }
      }, handler)
      created.configure(format, surfaceView.holder.surface, null, 0)
      created.start()
      codec = created
      waitingForKeyframe = true
      true
    } catch (error: Exception) {
      Log.w(TAG, "Could not start the H.264 decoder: ${error.message}")
      created?.release()
      false
    }
  }

  private fun feed() {
    val codec = codec ?: return
    while (inputs.isNotEmpty() && freeInputs.isNotEmpty()) {
      val index = freeInputs.poll()!!
      val (bytes, received) = inputs.poll()!!
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
      codec.queueInputBuffer(index, 0, bytes.size, received / 1000, 0)
      attached?.recordDecoded(received)
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

  private fun dropped() {
    attached?.recordDropped()
  }

  private fun requestKeyframe() {
    val now = SystemClock.elapsedRealtime()
    if (now - lastKeyframeRequest < KEYFRAME_REQUEST_INTERVAL_MS) return
    lastKeyframeRequest = now
    view.post { onKeyframeNeeded?.invoke() }
  }

  private inner class Callbacks : MediaCodec.Callback() {
    override fun onInputBufferAvailable(codec: MediaCodec, index: Int) {
      if (codec !== this@HybridStimVideoView.codec) return
      freeInputs.add(index)
      feed()
    }

    override fun onOutputBufferAvailable(codec: MediaCodec, index: Int, info: MediaCodec.BufferInfo) {
      if (codec !== this@HybridStimVideoView.codec) return
      codec.releaseOutputBuffer(index, true)
      attached?.recordPresented(info.presentationTimeUs * 1000)
    }

    override fun onError(codec: MediaCodec, error: MediaCodec.CodecException) {
      if (codec !== this@HybridStimVideoView.codec) return
      Log.w(TAG, "The H.264 decoder failed: ${error.diagnosticInfo}")
      handler.post {
        if (codec === this@HybridStimVideoView.codec) release()
        requestKeyframe()
      }
    }

    override fun onOutputFormatChanged(codec: MediaCodec, format: MediaFormat) {}
  }

  private companion object {
    const val TAG = "StimVideo"
    val START_CODE = byteArrayOf(0, 0, 0, 1)
    const val MAX_BACKLOG = 3
    const val KEYFRAME_REQUEST_INTERVAL_MS = 500L
  }
}
