import { describe, expect, test } from 'vitest';
import { agentActionGesture, parseAgentSnapshot, type AgentSnapshotTree } from '../state/agent-presence.ts';

const tree: AgentSnapshotTree = {
  viewport: { width: 400, height: 800 },
  nodes: [
    { ref: 'e1', rect: { x: 0, y: 0, width: 400, height: 800 } },
    { ref: 'e2', rect: { x: 100, y: 200, width: 200, height: 100 } },
    { ref: 'e3', rect: { x: 120, y: 220, width: 40, height: 40 } },
  ],
};

describe('parseAgentSnapshot', () => {
  test('keeps refs with rects and the viewport, dropping the @ and nodes without a rect', () => {
    const text = JSON.stringify({
      data: {
        nodes: [
          { ref: '@e1', rect: { x: 0, y: 0, width: 10, height: 20 }, label: 'Root' },
          { ref: 'e2', label: 'No rect' },
          { label: 'No ref', rect: { x: 0, y: 0, width: 1, height: 1 } },
        ],
        viewport: { x: 0, y: 0, width: 402, height: 874 },
      },
    });
    expect(parseAgentSnapshot(text)).toEqual({
      viewport: { width: 402, height: 874 },
      nodes: [{ ref: 'e1', rect: { x: 0, y: 0, width: 10, height: 20 } }],
    });
  });

  test('reads no tree from text output', () => {
    expect(parseAgentSnapshot('@e1 [button] "OK"')).toBeNull();
  });
});

describe('agentActionGesture', () => {
  test('a press on a ref outlines that ref when its rect contains the dispatched point', () => {
    expect(agentActionGesture({ x: 200, y: 250 }, tree, '@e2')).toEqual({
      kind: 'tap',
      from: { x: 0.5, y: 0.3125 },
      durationMs: 0,
      target: { x: 0.25, y: 0.25, width: 0.5, height: 0.125 },
    });
  });

  test('a stale ref whose rect misses the point draws the point only', () => {
    expect(agentActionGesture({ x: 20, y: 700 }, tree, '@e2~s4')).toEqual({
      kind: 'tap',
      from: { x: 0.05, y: 0.875 },
      durationMs: 0,
    });
  });

  test('a selector outlines the smallest node containing the point', () => {
    expect(agentActionGesture({ x: 130, y: 230, durationMs: 800 }, tree, 'label="OK"')?.target).toEqual({
      x: 0.3,
      y: 0.275,
      width: 0.1,
      height: 0.05,
    });
  });

  test('a coordinate press outlines nothing', () => {
    expect(agentActionGesture({ x: 130, y: 230 }, tree, '130')?.target).toBeUndefined();
  });

  test('a scroll becomes a swipe from its start to its end over its duration', () => {
    expect(agentActionGesture({ x1: 200, y1: 600, x2: 200, y2: 200, durationMs: 300 }, tree, undefined)).toEqual({
      kind: 'swipe',
      from: { x: 0.5, y: 0.75 },
      to: { x: 0.5, y: 0.25 },
      durationMs: 300,
    });
  });

  test('without a measured screen or a recorded point there is no gesture', () => {
    expect(agentActionGesture({ x: 1, y: 1 }, { ...tree, viewport: null }, '@e2')).toBeNull();
    expect(agentActionGesture({ x: 1, y: 1 }, null, '@e2')).toBeNull();
    expect(agentActionGesture({ positionals: ['@e2'] }, tree, '@e2')).toBeNull();
  });

  test("without a snapshot the device's screen measures the point, and a snapshot's viewport wins over it", () => {
    const screen = { width: 402, height: 874 };
    const scroll = { x1: 201, y1: 721, x2: 201, y2: 153, durationMs: 400 };
    expect(agentActionGesture(scroll, null, undefined, screen)).toEqual({
      kind: 'swipe',
      from: { x: 0.5, y: 721 / 874 },
      to: { x: 0.5, y: 153 / 874 },
      durationMs: 400,
    });
    expect(agentActionGesture({ x: 201, y: 437, durationMs: 0 }, { viewport: null, nodes: [] }, '@e2', screen)).toEqual(
      {
        kind: 'tap',
        from: { x: 0.5, y: 0.5 },
        durationMs: 0,
      },
    );
    expect(agentActionGesture({ x: 200, y: 400 }, tree, undefined, screen)?.from).toEqual({ x: 0.5, y: 0.5 });
  });
});
