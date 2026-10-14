package com.margelo.nitro.stimticker

import android.graphics.Color
import android.graphics.Typeface
import android.view.Gravity
import android.widget.TextView
import com.facebook.react.uimanager.ThemedReactContext
import com.margelo.nitro.views.RecyclableView

class HybridTickerView(context: ThemedReactContext) : HybridTickerViewSpec(), TickerConsumer, RecyclableView {
  override val view: TextView = TextView(context).apply {
    gravity = Gravity.CENTER
    textSize = 28f
    typeface = Typeface.MONOSPACE
    setTextColor(Color.WHITE)
    setBackgroundColor(Color.rgb(88, 86, 214))
    text = "no ticker"
  }

  companion object {
    private var nextId = 0
  }

  private val viewId = ++nextId
  private var attached: HybridTicker? = null

  init {
    tickerLog("view v$viewId init")
  }

  override var ticker: HybridTickerSpec? = null
    set(value) {
      field = value
      tickerLog("view v$viewId setTicker ${value?.let { "#${it.id.toInt()}" } ?: "null"}")
      attach(value as? HybridTicker)
    }

  override fun onTick(tickerId: Double, count: Int) {
    view.post {
      if (attached?.id == tickerId) view.text = "ticker #${tickerId.toInt()}\n$count"
    }
  }

  override fun beforeUpdate() = tickerLog("view v$viewId beforeUpdate")

  override fun afterUpdate() = tickerLog("view v$viewId afterUpdate")

  override fun onDropView() {
    tickerLog("view v$viewId onDropView")
    attach(null)
  }

  override fun prepareForRecycle() {
    tickerLog("view v$viewId prepareForRecycle")
    attach(null)
  }

  private fun attach(next: HybridTicker?) {
    if (attached === next) return
    attached?.detach(this)
    attached = next
    next?.attach(this)
    view.text = next?.let { "ticker #${it.id.toInt()}\n${it.count.toInt()}" } ?: "no ticker"
  }
}
