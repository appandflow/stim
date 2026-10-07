import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadFixtures } from './fixtures.mjs';
import { loadRecording, replayKeyframe, replayRange, VideoFeed } from './replay.mjs';

test('the real archive keeps its five builds and closed spans while replay seek emits frames on that timeline', () => {
  const fixtures = loadFixtures();
  const archive = fixtures.status.archived.find((entry) => entry.id.startsWith('sample-sdk58--'));
  const detail = fixtures.archiveDetails[archive.id];
  assert.deepEqual(
    detail.builds.ios.map((run) => run.durationMs),
    [13140, 29746, 66197, 9406, 129383],
  );
  const spans = detail.recordings[0].spans;
  assert.deepEqual(
    spans.map((span) => span.end - span.start),
    [11367, 469, 551],
  );
  const recording = { ...loadRecording(), spans };
  assert.deepEqual(replayRange(recording).spans, spans);
  const packets = [];
  const socket = { OPEN: 1, readyState: 1, send: (packet) => packets.push(packet) };
  const feed = new VideoFeed(recording, 'test', socket, () => {});
  for (const span of spans) {
    const at = span.start + (span.end - span.start) / 2;
    const shown = feed.seek(at, 0);
    assert.ok(shown >= span.start && shown <= span.end);
    const keyframe = replayKeyframe(recording, at);
    assert.ok(keyframe.at >= span.start && keyframe.at <= span.end);
    assert.ok(keyframe.data.length > 0);
  }
  assert.ok(packets.length > 0);
});
