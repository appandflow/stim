package com.margelo.nitro.stimsession

import java.nio.ByteBuffer

internal object NalType {
  const val IDR = 5
  const val SPS = 7
  const val PPS = 8
}

internal object AnnexB {
  /**
   * The NAL units of the Annex-B access unit between `bytes`' position and limit, as absolute [start, end) ranges
   * without their start codes.
   */
  fun units(bytes: ByteBuffer): List<IntRange> {
    val units = ArrayList<IntRange>()
    val limit = bytes.limit()
    var start = -1
    var index = bytes.position()
    while (index + 3 <= limit) {
      if (bytes.get(index).toInt() == 0 && bytes.get(index + 1).toInt() == 0 && bytes.get(index + 2).toInt() == 1) {
        if (start >= 0) {
          var end = index
          if (end > start && bytes.get(end - 1).toInt() == 0) end -= 1
          if (end > start) units.add(start until end)
        }
        index += 3
        start = index
      } else {
        index += 1
      }
    }
    if (start in 0 until limit) units.add(start until limit)
    return units
  }

  fun type(bytes: ByteBuffer, unit: IntRange): Int = bytes.get(unit.first).toInt() and 0x1f

  fun copy(bytes: ByteBuffer, unit: IntRange): ByteArray =
    ByteArray(unit.last + 1 - unit.first).also { bytes.duplicate().apply { position(unit.first) }.get(it) }
}
