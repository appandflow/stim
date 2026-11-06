import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateSchema, restoreSchema, schemaRefusal, type Migration } from '../engine-store/schema.ts';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stim-schema-'));
  writeFileSync(join(home, 'config.json'), '{"old":true}\n');
  writeFileSync(join(home, 'created-devices.json'), '{"version":1,"devices":[]}\n');
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

const reshape: Migration = {
  files: ['config.json', 'created-devices.json'],
  migrate: (root) => {
    writeFileSync(join(root, 'config.json'), '{"new":true}\n');
    writeFileSync(join(root, 'created-devices.json'), '{"version":1,"devices":["sim"]}\n');
  },
};

describe('home schema', () => {
  it('snapshots the files a bump rewrites, never a ledger of live resources, and stamps the new schema', () => {
    migrateSchema(home, '1.51.0', 2, [reshape]);
    expect(readFileSync(join(home, 'backup', 'schema-1', 'config.json'), 'utf8')).toBe('{"old":true}\n');
    expect(existsSync(join(home, 'backup', 'schema-1', 'created-devices.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(home, 'schema.json'), 'utf8'))).toEqual({ schema: 2, by: '1.51.0' });
  });

  it('refuses a build that reads an older schema and names both remedies', () => {
    migrateSchema(home, '1.51.0', 2, [reshape]);
    expect(schemaRefusal(home, 1)).toBe(
      `home ${home} was migrated to schema 2 by 1.51.0; run stim engine rollback --restore-state (restores ${join(home, 'backup', 'schema-1')}) or stim engine update`,
    );
    expect(() => migrateSchema(home, '1.50.0', 1, [])).toThrow(/was migrated to schema 2/);
  });

  it('restores the snapshot on --restore-state and keeps what the newer build recorded in a ledger', () => {
    migrateSchema(home, '1.51.0', 2, [reshape]);
    restoreSchema(home, 1, '1.50.0');
    expect(readFileSync(join(home, 'config.json'), 'utf8')).toBe('{"old":true}\n');
    expect(readFileSync(join(home, 'created-devices.json'), 'utf8')).toContain('"sim"');
    expect(schemaRefusal(home, 1)).toBeNull();
  });
});
