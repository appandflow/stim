/** The entities that changed since the last emit: whole entities to insert or replace, and keys to drop. */
export interface KeyedDelta<T> {
  upsert: T[];
  remove: string[];
}

/**
 * Tracks the JSON of the entities last sent on one subscription, so the next emit carries only what changed. An
 * entity counts as changed when its JSON differs, so the order of its fields matters and producers build entities
 * with a stable field order.
 */
export class KeyedEntities<T> {
  private sent = new Map<string, string>();
  private readonly key: (entity: T) => string;

  constructor(key: (entity: T) => string) {
    this.key = key;
  }

  /** Records `entities` as sent in full, for a snapshot. */
  reset(entities: readonly T[]): void {
    this.sent = new Map(entities.map((entity) => [this.key(entity), JSON.stringify(entity)]));
  }

  /** The delta from what was last sent to `entities`, recorded as sent; null when nothing changed. */
  next(entities: readonly T[]): KeyedDelta<T> | null {
    const sent = new Map<string, string>();
    const upsert: T[] = [];
    for (const entity of entities) {
      const key = this.key(entity);
      const json = JSON.stringify(entity);
      sent.set(key, json);
      if (this.sent.get(key) !== json) upsert.push(entity);
    }
    const remove = [...this.sent.keys()].filter((key) => !sent.has(key));
    this.sent = sent;
    return upsert.length || remove.length ? { upsert, remove } : null;
  }
}

/** Applies `delta` to `entities` keyed by `key`, keeping the order of `entities` and appending new keys. */
export function applyKeyedDelta<T>(entities: readonly T[], delta: KeyedDelta<T>, key: (entity: T) => string): T[] {
  const removed = new Set(delta.remove);
  const replaced = new Map(delta.upsert.map((entity) => [key(entity), entity]));
  const next = entities.flatMap((entity) => {
    const id = key(entity);
    if (removed.has(id)) return [];
    const replacement = replaced.get(id);
    replaced.delete(id);
    return [replacement ?? entity];
  });
  return [...next, ...replaced.values()];
}
