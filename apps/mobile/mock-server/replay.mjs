import { readFileSync } from 'node:fs';

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url);
const STOPPED_MS = 2 * 60 * 60 * 1000;

/**
 * A recorded iOS screen replayed from `recording-ios.seg`, stored the way stim-server stores footage. The mock
 * presents it twice: once ending two hours before the mock started, before a stop, and once ending when it
 * started. Seeking past that shows the last frame.
 */
export function loadRecording() {
  const bytes = readFileSync(fixture('recording-ios.seg'));
  const meta = JSON.parse(readFileSync(fixture('recording-ios.json'), 'utf8'));
  const units = [];
  for (let at = 0; at + 4 <= bytes.length;) {
    const length = bytes.readUInt32BE(at);
    units.push({
      flags: bytes[at + 4],
      at: bytes.readDoubleBE(at + 5) - meta.start,
      width: bytes.readUInt16BE(at + 13),
      height: bytes.readUInt16BE(at + 15),
      data: bytes.subarray(at + 17, at + 4 + length),
    });
    at += 4 + length;
  }
  return { units, length: meta.end - meta.start, markers: meta.markers.map((m) => ({ ...m, at: m.at - meta.start })) };
}

const anchor = Date.now();

/** The two copies' start times, oldest first. */
function starts(recording) {
  const current = anchor - recording.length;
  return [current - STOPPED_MS, current];
}

export function replayRange(recording) {
  return {
    enabled: true,
    recording: true,
    spans: starts(recording).map((start) => ({ start, end: start + recording.length })),
    markers: starts(recording).flatMap((start) =>
      recording.markers.map((marker) => ({ ...marker, at: start + marker.at })),
    ),
  };
}

function packet(subscription, sequence, unit, capturedAt) {
  const id = Buffer.from(subscription, 'ascii');
  const header = Buffer.alloc(21 + id.length);
  header.writeUInt8(1, 0);
  header.writeUInt8(unit.flags, 1);
  header.writeUInt16BE(header.length, 2);
  header.writeUInt32BE(sequence >>> 0, 4);
  header.writeDoubleBE(capturedAt, 8);
  header.writeUInt16BE(unit.width, 16);
  header.writeUInt16BE(unit.height, 18);
  header.writeUInt8(id.length, 20);
  id.copy(header, 21);
  return Buffer.concat([header, unit.data]);
}

/**
 * One video subscription: live loops the recording with capture times of now; `seek` sends the frame at a time
 * from its keyframe and plays on at `rate`, ending with `replay-ended`.
 */
export class VideoFeed {
  constructor(recording, subscription, socket, send) {
    this.recording = recording;
    this.subscription = subscription;
    this.socket = socket;
    this.send = send;
    this.sequence = 0;
    this.timer = null;
  }

  emit(unit, capturedAt) {
    if (this.socket.readyState === this.socket.OPEN) {
      this.socket.send(packet(this.subscription, this.sequence++, unit, capturedAt));
    }
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  live() {
    this.stop();
    const { units, length } = this.recording;
    const loopStart = Date.now();
    let index = 0;
    const next = () => {
      const unit = units[index % units.length];
      const lap = Math.floor(index / units.length);
      const due = loopStart + lap * length + unit.at;
      this.timer = setTimeout(
        () => {
          this.emit(unit, Date.now());
          index++;
          next();
        },
        Math.max(0, due - Date.now()),
      );
    };
    next();
  }

  /** Returns the capture time of the frame shown. */
  seek(at, rate) {
    this.stop();
    const [older, current] = starts(this.recording);
    const start = at <= older + this.recording.length ? older : current;
    const { units } = this.recording;
    const target = Math.min(this.recording.length, Math.max(0, at - start));
    let first = 0;
    for (let i = 0; i < units.length && units[i].at <= target; i++) if (units[i].flags & 1) first = i;
    let next = first;
    while (next < units.length && (next === first || units[next].at <= target)) {
      this.emit(units[next], start + units[next].at);
      next++;
    }
    const shown = start + units[next - 1].at;
    if (rate > 0) {
      const wallStart = Date.now();
      const from = units[next - 1].at;
      const play = (index) => {
        if (index >= units.length) {
          this.send({ event: 'replay-ended', subscription: this.subscription, at: start + units.at(-1).at });
          return;
        }
        this.timer = setTimeout(
          () => {
            this.emit(units[index], start + units[index].at);
            play(index + 1);
          },
          Math.max(0, wallStart + (units[index].at - from) / rate - Date.now()),
        );
      };
      play(next);
    }
    return shown;
  }
}
