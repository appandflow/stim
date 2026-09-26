package expo.modules.stimvideo

internal object NalType {
  const val IDR = 5
  const val SPS = 7
  const val PPS = 8
}

internal object AnnexB {
  /** The NAL units of an Annex-B access unit, as [start, end) ranges without their start codes. */
  fun units(bytes: ByteArray): List<IntRange> {
    val units = ArrayList<IntRange>()
    var start = -1
    var index = 0
    while (index + 3 <= bytes.size) {
      if (bytes[index].toInt() == 0 && bytes[index + 1].toInt() == 0 && bytes[index + 2].toInt() == 1) {
        if (start >= 0) {
          var end = index
          if (end > start && bytes[end - 1].toInt() == 0) end -= 1
          if (end > start) units.add(start until end)
        }
        index += 3
        start = index
      } else {
        index += 1
      }
    }
    if (start in 0 until bytes.size) units.add(start until bytes.size)
    return units
  }

  fun type(bytes: ByteArray, unit: IntRange): Int = bytes[unit.first].toInt() and 0x1f
}
