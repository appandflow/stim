package com.margelo.nitro.stimsession

import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import androidx.annotation.Keep
import com.facebook.proguard.annotations.DoNotStrip
import com.margelo.nitro.core.ArrayBuffer
import java.lang.ref.WeakReference
import java.nio.ByteOrder

internal interface VideoConsumer {
  /**
   * One Annex-B access unit of `width` by `height`, belonging to orientation `generation`. `received` is when the
   * stream got it, in `System.nanoTime()`.
   */
  fun decode(accessUnit: ByteArray, width: Int, height: Int, generation: Int, received: Long)
}

/**
 * The video of one subscription. The session pushes stim-server video messages on its socket thread; the attached
 * `HybridStimVideoView` decodes them. While no view is attached, the stream keeps the messages since the last
 * keyframe, so a view that attaches late starts without waiting for one.
 */
@DoNotStrip
@Keep
class HybridVideoStream : HybridVideoStreamSpec() {
  /**
   * Called at once with the current format when set after the first keyframe, as when the session replays the
   * messages that arrived before JavaScript asked for the stream.
   */
  override var onFormat: ((format: VideoFormat) -> Unit)? = null
    set(value) {
      field = value
      synchronized(lock) { format }?.let { value?.invoke(it) }
    }
  override var onProgress: ((progress: VideoProgress) -> Unit)? = null

  private class Pending(val accessUnit: ByteArray, val width: Int, val height: Int, val generation: Int, val received: Long)

  private val lock = Any()
  private var consumer: WeakReference<VideoConsumer>? = null
  private val backlog = ArrayList<Pending>()
  private var backlogBytes = 0
  private var formatKey: String? = null
  private var format: VideoFormat? = null
  private var generation = 0
  private var disposed = false
  private var frames = 0
  private var bytes = 0
  private var capturedAt = 0.0
  private var latencyMs = 0.0
  private var lastProgress = 0L
  private var progressScheduled = false
  private val timings = DoubleArray(8)

  override fun push(packet: ArrayBuffer) {
    val buffer = packet.getBuffer(false).duplicate().order(ByteOrder.BIG_ENDIAN)
    val size = buffer.remaining()
    if (size < FIXED_HEADER_BYTES) return
    val base = buffer.position()
    fun byte(at: Int) = buffer.get(base + at).toInt() and 0xff
    if (byte(0) != 1) return
    val headerLength = (byte(2) shl 8) or byte(3)
    val idLength = byte(20)
    if (headerLength < FIXED_HEADER_BYTES + idLength || headerLength > size) return
    val flags = byte(1)
    val keyframe = flags and 1 != 0
    val posture = if (flags and 2 != 0) VideoPosture.FOLDED else if (flags and 4 != 0) VideoPosture.UNFOLDED else null
    val artworkTurns = if (flags and 32 != 0) ((flags shr 3) and 3).toDouble() else null
    val captured = buffer.getDouble(base + 8)
    val width = (byte(16) shl 8) or byte(17)
    val height = (byte(18) shl 8) or byte(19)
    val received = System.nanoTime()
    val accessUnit = ByteArray(size - headerLength)
    buffer.position(base + headerLength)
    buffer.get(accessUnit)

    var changed: VideoFormat? = null
    val target: VideoConsumer?
    val unitGeneration: Int
    val progress: VideoProgress?
    val formatCallback: ((VideoFormat) -> Unit)?
    synchronized(lock) {
      if (BuildConfig.DEBUG) timings[RECEIVED] += 1.0
      if (disposed) {
        if (BuildConfig.DEBUG) timings[DROPPED] += 1.0
        return
      }
      if (formatKey != null || keyframe) {
        val key = "${width}x$height ${posture ?: ""} ${artworkTurns ?: ""}"
        if (key != formatKey) {
          formatKey = key
          if (artworkTurns != null) generation += 1
          changed = VideoFormat(width.toDouble(), height.toDouble(), posture, artworkTurns, generation.toDouble())
          format = changed
        }
      }
      unitGeneration = generation
      frames += 1
      bytes += accessUnit.size
      capturedAt = captured
      latencyMs = System.currentTimeMillis() - captured
      target = consumer?.get()
      if (target == null) {
        if (keyframe) {
          backlog.clear()
          backlogBytes = 0
        }
        if ((backlog.isNotEmpty() || keyframe) && backlogBytes + accessUnit.size <= MAX_BACKLOG_BYTES) {
          backlog.add(Pending(accessUnit, width, height, unitGeneration, received))
          backlogBytes += accessUnit.size
        } else if (BuildConfig.DEBUG) {
          timings[DROPPED] += 1.0
        }
      }
      progress = takeProgress()
      formatCallback = onFormat
    }
    changed?.let { formatCallback?.invoke(it) }
    target?.decode(accessUnit, width, height, unitGeneration, received)
    progress?.let { onProgress?.invoke(it) }
  }

  internal fun attach(next: VideoConsumer) {
    val replay: List<Pending>
    synchronized(lock) {
      if (disposed) return
      consumer = WeakReference(next)
      replay = ArrayList(backlog)
      backlog.clear()
      backlogBytes = 0
    }
    for (unit in replay) next.decode(unit.accessUnit, unit.width, unit.height, unit.generation, unit.received)
  }

  internal fun detach(previous: VideoConsumer) {
    synchronized(lock) { if (consumer?.get() === previous) consumer = null }
  }

  override fun timing(): VideoTiming {
    if (!BuildConfig.DEBUG) return VideoTiming(false, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0)
    val t = synchronized(lock) { timings.copyOf() }
    return VideoTiming(
      true, t[RECEIVED], t[DECODED], t[PRESENTED], t[DROPPED],
      if (t[DECODED] > 0) t[QUEUE_SUM] / t[DECODED] else 0.0, t[QUEUE_MAX],
      if (t[PRESENTED] > 0) t[PRESENT_SUM] / t[PRESENTED] else 0.0, t[PRESENT_MAX],
    )
  }

  /** The view queued a frame the stream received at `received` to MediaCodec. */
  internal fun recordDecoded(received: Long) = record(DECODED, QUEUE_SUM, QUEUE_MAX, received)

  /** MediaCodec rendered a frame the stream received at `received`. */
  internal fun recordPresented(received: Long) = record(PRESENTED, PRESENT_SUM, PRESENT_MAX, received)

  internal fun recordDropped() {
    if (BuildConfig.DEBUG) synchronized(lock) { timings[DROPPED] += 1.0 }
  }

  private fun record(count: Int, sum: Int, max: Int, received: Long) {
    if (!BuildConfig.DEBUG) return
    val ms = (System.nanoTime() - received) / 1e6
    synchronized(lock) {
      timings[count] += 1.0
      timings[sum] += ms
      timings[max] = maxOf(timings[max], ms)
    }
  }

  override fun dispose() {
    synchronized(lock) {
      disposed = true
      consumer = null
      backlog.clear()
      backlogBytes = 0
    }
  }

  /** The progress to report now, or null; schedules a report for frames inside the interval. Holds `lock`. */
  private fun takeProgress(): VideoProgress? {
    val now = SystemClock.elapsedRealtime()
    val elapsed = now - lastProgress
    if (elapsed < PROGRESS_INTERVAL_MS) {
      if (!progressScheduled) {
        progressScheduled = true
        handler.postDelayed({
          val due = synchronized(lock) {
            progressScheduled = false
            if (disposed) null else takeProgress()
          }
          due?.let { onProgress?.invoke(it) }
        }, PROGRESS_INTERVAL_MS - elapsed)
      }
      return null
    }
    if (frames == 0) return null
    lastProgress = now
    val progress = VideoProgress(capturedAt, frames.toDouble(), bytes.toDouble(), latencyMs)
    frames = 0
    bytes = 0
    return progress
  }

  private companion object {
    const val FIXED_HEADER_BYTES = 21
    const val MAX_BACKLOG_BYTES = 4 * 1024 * 1024
    const val PROGRESS_INTERVAL_MS = 200L
    const val RECEIVED = 0
    const val DECODED = 1
    const val PRESENTED = 2
    const val DROPPED = 3
    const val QUEUE_SUM = 4
    const val QUEUE_MAX = 5
    const val PRESENT_SUM = 6
    const val PRESENT_MAX = 7
    val handler = Handler(HandlerThread("stim.video.progress").apply { start() }.looper)
  }
}
