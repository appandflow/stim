import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeRecord } from './store.ts';

/** `~/.stim/machine`, shared by every Stim home of this user. */
export const machineRoot = (): string => join(homedir(), '.stim', 'machine');

// compat C4 permanent
/** The layout of a Stim home and of `~/.stim/machine` this build reads and writes. Only ever goes up. */
export const SCHEMA: number = 1;

/** A step from schema `n` to `n + 1`: the files it rewrites, relative to the root, and the rewrite. */
export interface Migration {
  files: string[];
  migrate(root: string): void;
}

/** Index `n - 1` migrates schema `n` to `n + 1`. Schema 1 is the layout before the marker existed. */
const MIGRATIONS: Migration[] = [];

/** Ledgers of live external resources: never reshaped, snapshotted or restored, so every build reads them. */
const LEDGERS = new Set(['created-devices.json', 'eas/sessions.json', 'homes/homes.json']);

export function readSchema(root: string): { schema: number; by: string } | null {
  try {
    const { schema, by } = JSON.parse(readFileSync(join(root, 'schema.json'), 'utf8'));
    return typeof schema === 'number' ? { schema, by: String(by) } : null;
  } catch {
    return null;
  }
}

export function schemaRefusal(root: string, schema: number): string | null {
  const found = readSchema(root);
  if (!found || found.schema <= schema) return null;
  return `home ${root} was migrated to schema ${found.schema} by ${found.by}; run stim engine rollback --restore-state (restores ${join(root, 'backup', `schema-${schema}`)}) or stim engine update`;
}

/** Brings `root` up to `schema`, snapshotting each step's files first, and stamps it. Refuses a higher schema. */
export function migrateSchema(
  root: string,
  by: string,
  schema: number = SCHEMA,
  migrations: Migration[] = MIGRATIONS,
): void {
  const refusal = schemaRefusal(root, schema);
  if (refusal)
    throw Object.assign(new Error(refusal), { code: 'STIM_SCHEMA_NEWER', remedy: 'Run stim engine update.' });
  mkdirSync(root, { recursive: true });
  for (let at = readSchema(root)?.schema ?? 1; at < schema; at++) {
    const step = migrations[at - 1];
    if (!step) throw new Error(`No migration from schema ${at}.`);
    for (const file of step.files.filter((each) => !LEDGERS.has(each) && existsSync(join(root, each))))
      cpSync(join(root, file), join(root, 'backup', `schema-${at}`, file), { recursive: true });
    step.migrate(root);
    writeRecord(join(root, 'schema.json'), { schema: at + 1, by });
  }
  writeRecord(join(root, 'schema.json'), { schema, by });
}

/** `--restore-state`: puts back the snapshot taken before `root` left `schema`, ledgers excepted, and stamps it. */
export function restoreSchema(root: string, schema: number, by: string): void {
  const backup = join(root, 'backup', `schema-${schema}`);
  if (existsSync(backup))
    cpSync(backup, root, {
      recursive: true,
      filter: (path) => !LEDGERS.has(path.slice(backup.length + 1).replaceAll('\\', '/')),
    });
  writeRecord(join(root, 'schema.json'), { schema, by });
}
// compat end
