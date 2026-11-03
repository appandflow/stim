'use strict';

/**
 * The rows of the share viewer's People list, as pure functions over the viewer's roster entries. An entry is
 * `{ id, name, color, kind, viewOnly, touching, self }`; none of these touches the page.
 */

/** What a participant can do now: the host and the agent only appear while they act. */
function roleOf(entry, shareControl) {
  if (entry.kind === 'host' || entry.kind === 'agent') return 'controlling';
  if (!shareControl || entry.viewOnly) return 'view only';
  return entry.touching ? 'controlling' : 'can control';
}

/** One row per participant, the viewer's own first, the others in the order they joined. */
function peopleRows(entries, shareControl) {
  const rows = entries.map((entry) => ({
    id: entry.id,
    name: entry.name,
    color: entry.color,
    kind: entry.kind || 'viewer',
    self: entry.self === true,
    viewOnly: entry.viewOnly === true,
    role: roleOf(entry, shareControl),
    initial: [...entry.name][0] ? [...entry.name][0].toUpperCase() : '?',
  }));
  return [...rows.filter((row) => row.self), ...rows.filter((row) => !row.self)];
}

function peopleCount(count) {
  return count === 1 ? '1 person' : `${count} people`;
}

globalThis.stimPeople = { peopleRows, peopleCount };
