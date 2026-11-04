import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { workspaceStateDir } from '../index.ts';
import type { PresenceGesture, PresencePoint, PresenceRect } from '../protocol.ts';
import { isJsonObject } from './json-file.ts';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The refs and rects of an agent-device snapshot, and the screen box they are measured in. */
export interface AgentSnapshotTree {
  viewport: { width: number; height: number } | null;
  nodes: { ref: string; rect: Rect }[];
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function rectOf(value: unknown): Rect | null {
  if (!isJsonObject(value)) return null;
  const { x, y, width, height } = value;
  return finite(x) && finite(y) && finite(width) && finite(height) && width >= 0 && height >= 0
    ? { x, y, width, height }
    : null;
}

function treeOf(value: unknown): AgentSnapshotTree | null {
  if (!isJsonObject(value) || !Array.isArray(value.nodes)) return null;
  const nodes = value.nodes.flatMap((node) => {
    if (!isJsonObject(node) || typeof node.ref !== 'string') return [];
    const rect = rectOf(node.rect);
    return rect ? [{ ref: node.ref.replace(/^@/, ''), rect }] : [];
  });
  const viewport = isJsonObject(value.viewport) ? value.viewport : {};
  const { width, height } = viewport;
  return {
    viewport: finite(width) && finite(height) && width > 0 && height > 0 ? { width, height } : null,
    nodes,
  };
}

/**
 * Reads the tree from agent-device's `snapshot --json` output, or from the JSON-RPC answer to its command: `nodes[]`
 * with `ref` and `rect`, and `viewport`.
 */
export function parseAgentSnapshot(text: string): AgentSnapshotTree | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isJsonObject(parsed)) return null;
  return (
    treeOf(parsed) ??
    treeOf(parsed.data) ??
    treeOf(parsed.result) ??
    (isJsonObject(parsed.result) ? treeOf(parsed.result.data) : null)
  );
}

/** Where `stim agent-device` keeps the last snapshot tree of an agent-device session in this workspace. */
export function agentSnapshotFile(root: string, session: string): string {
  const name = createHash('sha256').update(session).digest('hex').slice(0, 16);
  return join(workspaceStateDir(root), 'agent-snapshots', `${name}.json`);
}

export function readAgentSnapshot(root: string, session: string): AgentSnapshotTree | null {
  try {
    return treeOf(JSON.parse(readFileSync(agentSnapshotFile(root, session), 'utf8')));
  } catch {
    return null;
  }
}

function contains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

function details(value: unknown): Record<string, number> {
  if (!isJsonObject(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => finite(entry[1])));
}

/**
 * Where an agent-device action landed, from its `action.recorded` details, as fractions of `viewport`: `x`/`y` for
 * a point action, `x1,y1,x2,y2` for a scroll or swipe. Null without a viewport or coordinates.
 */
export function agentActionPoints(
  recorded: unknown,
  viewport: AgentSnapshotTree['viewport'],
): { from: PresencePoint; to?: PresencePoint } | null {
  if (!viewport) return null;
  const d = details(recorded);
  const point = (x: number | undefined, y: number | undefined) =>
    x === undefined || y === undefined ? null : { x: x / viewport.width, y: y / viewport.height };
  const from = point(d.x1, d.y1);
  const to = point(d.x2, d.y2);
  if (from && to) return { from, to };
  const at = point(d.x, d.y);
  return at ? { from: at } : null;
}

/**
 * The element an agent action acted on, from the details agent-device records. A ref is kept as `@ref`; a selector
 * is redacted to `<arg>` in the record, so a single positional that is not a coordinate pair stands for one, and
 * the recorded point picks the element.
 */
export function agentActionTarget(recorded: unknown): string | undefined {
  if (!isJsonObject(recorded)) return undefined;
  const { ref, positionals, targetLabel } = recorded;
  if (typeof ref === 'string') return `@${ref}`;
  return Array.isArray(positionals) &&
    positionals.length === 1 &&
    typeof targetLabel === 'string' &&
    !targetLabel.startsWith('(')
    ? '<selector>'
    : undefined;
}

/**
 * The presence gesture of one recorded agent-device action. `target` is the action's first positional: for an
 * `@ref`, the ref's rect from `tree` outlines it only when it contains the point the action reports, since a ref
 * from an older screen is stale; for a selector, the smallest node containing the point does. Coordinates outline
 * nothing. The point is measured in the tree's viewport, or in `fallback`, the device's logical size, without one.
 */
export function agentActionGesture(
  recorded: unknown,
  tree: AgentSnapshotTree | null,
  target: string | undefined,
  fallback: AgentSnapshotTree['viewport'] = null,
): PresenceGesture | null {
  const viewport = tree?.viewport ?? fallback;
  const points = agentActionPoints(recorded, viewport);
  if (!points || !viewport) return null;
  const d = details(recorded);
  const durationMs = Math.max(0, d.durationMs ?? 0);
  if (points.to) return { kind: 'swipe', from: points.from, to: points.to, durationMs };
  const { x = 0, y = 0 } = d;
  let rect: Rect | undefined;
  const nodes = tree?.nodes ?? [];
  if (target?.startsWith('@')) {
    const ref = target.slice(1).split('~')[0];
    const node = nodes.find((each) => each.ref === ref);
    if (node && contains(node.rect, x, y)) rect = node.rect;
  } else if (target !== undefined && !/^-?\d+(\.\d+)?$/.test(target)) {
    rect = nodes
      .filter((node) => contains(node.rect, x, y))
      .reduce<Rect | undefined>(
        (best, node) => (!best || node.rect.width * node.rect.height < best.width * best.height ? node.rect : best),
        undefined,
      );
  }
  const { width, height } = viewport;
  const outline: PresenceRect | undefined = rect && {
    x: rect.x / width,
    y: rect.y / height,
    width: rect.width / width,
    height: rect.height / height,
  };
  return { kind: 'tap', from: points.from, durationMs, ...(outline ? { target: outline } : {}) };
}
