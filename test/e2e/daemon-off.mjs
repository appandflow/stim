import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.STIM_DAEMON = 'off';
process.env.STIM_TEST_GUARD_NO_HOME_PASSES = '1';
process.env.STIM_ENGINE_ROOT = join(tmpdir(), 'stim-e2e-engine-absent');
