package com.margelo.nitro.stimticker

import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import java.lang.ref.WeakReference

interface TickerConsumer {
  fun onTick(tickerId: Double, count: Int)
}

internal fun tickerLog(message: String) {
  Log.i("TickerSpike", "$message (thread=${Thread.currentThread().name})")
}

class HybridTicker : HybridTickerSpec() {
  companion object {
    private var nextId = 0.0
    private val handler = Handler(HandlerThread("stim.ticker").apply { start() }.looper)
  }

  override val id: Double = ++nextId
  @Volatile private var ticks = 0
  @Volatile private var consumer: WeakReference<TickerConsumer>? = null
  private var tick: Tick? = null

  init {
    tickerLog("ticker #${id.toInt()} init")
  }

  private class Tick(ticker: HybridTicker) : Runnable {
    private val ticker = WeakReference(ticker)

    override fun run() {
      val ticker = ticker.get() ?: return
      if (ticker.tick !== this) return
      ticker.ticks += 1
      val target = ticker.consumer?.get()
      if (ticker.ticks == 1 || ticker.ticks % 150 == 0) {
        tickerLog("ticker #${ticker.id.toInt()} tick ${ticker.ticks} consumer=${target != null}")
      }
      target?.onTick(ticker.id, ticker.ticks)
      handler.postDelayed(this, 33)
    }
  }

  override val count: Double
    get() = ticks.toDouble()

  override val hasConsumer: Boolean
    get() = consumer?.get() != null

  override fun start() {
    handler.post {
      if (tick == null) {
        val next = Tick(this)
        tick = next
        next.run()
      }
    }
  }

  override fun stop() {
    handler.post { tick = null }
  }

  fun attach(next: TickerConsumer) {
    consumer = WeakReference(next)
    tickerLog("ticker #${id.toInt()} attached consumer")
  }

  fun detach(previous: TickerConsumer) {
    if (consumer?.get() === previous) consumer = null
    tickerLog("ticker #${id.toInt()} detached consumer")
  }

  protected fun finalize() {
    tickerLog("ticker #${id.toInt()} finalize")
  }
}
