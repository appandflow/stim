'use strict';

(function () {
  /** The keyframe bit of a video packet's flags; see VIDEO_KEYFRAME in packages/core/protocol.ts. */
  const VIDEO_KEYFRAME = 1;
  const LOSS_WINDOW_MS = 5000;
  const LOSS_MAX_GAPS = 12;
  const LOSS_MAX_ASKS = 6;
  const NEVER_CARRIED_MS = [5000, 30000];
  const FORCED_NEVER_CARRIED_MS = 120000;
  const FELL_BACK_MS = 30000;
  const FELL_BACK_MAX_MS = 600000;
  const STABLE_MS = 60000;

  function wanted(offered, supported, query, cookie) {
    if (!offered || !supported) return 'off';
    if (query === 'webrtc') return 'force';
    return query === 'ws' || cookie === 'ws' ? 'off' : 'try';
  }

  function nalUnits(bytes) {
    const units = [];
    let start = -1;
    let i = 0;
    while (i + 2 < bytes.length) {
      if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) {
        if (start >= 0) units.push(bytes.subarray(start, bytes[i - 1] === 0 ? i - 1 : i));
        i += 3;
        start = i;
      } else i++;
    }
    if (start >= 0) units.push(bytes.subarray(start));
    return units;
  }

  function usableKeyframe(buffer) {
    if (buffer.byteLength < 21) return false;
    const view = new DataView(buffer);
    if (view.getUint8(0) !== 1 || (view.getUint8(1) & VIDEO_KEYFRAME) === 0) return false;
    const offset = view.getUint16(2);
    if (offset < 21 || offset >= buffer.byteLength) return false;
    const types = new Map(nalUnits(new Uint8Array(buffer, offset)).map((unit) => [unit[0] & 31, unit.length]));
    return (types.get(7) || 0) >= 4 && (types.get(8) || 0) >= 1 && types.has(5);
  }

  function createLossMonitor(windowMs = LOSS_WINDOW_MS, maxGaps = LOSS_MAX_GAPS, maxAsks = LOSS_MAX_ASKS) {
    const gaps = [];
    const asks = [];
    const trim = (list, now) => {
      while (list.length && now - list[0] >= windowMs) list.shift();
    };
    const verdict = (now) => {
      trim(gaps, now);
      trim(asks, now);
      if (gaps.length >= maxGaps) return 'gaps';
      return asks.length >= maxAsks ? 'asks' : null;
    };
    return {
      gap(now) {
        gaps.push(now);
        return verdict(now);
      },
      ask(now) {
        asks.push(now);
        return verdict(now);
      },
      reset() {
        gaps.length = 0;
        asks.length = 0;
      },
    };
  }

  function retryDelay(never, fellBack, forced) {
    if (never > 0) {
      const delay = NEVER_CARRIED_MS[never - 1];
      return delay === undefined ? (forced ? FORCED_NEVER_CARRIED_MS : null) : delay;
    }
    return Math.min(FELL_BACK_MS * 2 ** Math.max(0, fellBack - 1), FELL_BACK_MAX_MS);
  }

  globalThis.stimRtcPolicy = {
    wanted,
    usableKeyframe,
    createLossMonitor,
    retryDelay,
    STABLE_MS,
  };
})();
