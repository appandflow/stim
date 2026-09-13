import { realpathSync } from 'node:fs';
import { upsertProject } from '../../../packages/stim-cli/src/config.ts';
import { ensureOwnedDevice, ensureBooted } from '../../../packages/stim-cli/src/engine/device.ts';
import { readCommittedSettings } from '../../../packages/stim-cli/src/settings.ts';

if (!process.env.STIM_HOME) throw new Error('Native QA preparation requires an isolated STIM_HOME.');
const [path, slot = 'default', deviceType] = process.argv.slice(2);
const projectPath = realpathSync(path);
const settings = readCommittedSettings(projectPath);
if (!settings.ios?.simslimProfile) throw new Error('Native QA preparation requires an explicit SimSlim profile.');
const out = (message) => process.stderr.write(`${message}\n`);
const device = await ensureOwnedDevice({
  platform: 'ios',
  project: upsertProject(projectPath, {}),
  projectPath,
  slot,
  settings,
  flags: deviceType ? { deviceType } : {},
  out,
  note: out,
});
const boot = await ensureBooted({ platform: 'ios', device, out });
if (!boot.ok) throw new Error(boot.reason);
process.stdout.write(`${JSON.stringify({ udid: boot.udid, slot })}\n`);
