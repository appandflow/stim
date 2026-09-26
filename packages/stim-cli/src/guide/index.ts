import agent from './agent.ts';
import facts from './facts.ts';
import metro from './metro.ts';
import ports from './ports.ts';
import logs from './logs.ts';
import errors from './errors.ts';
import lifecycle from './lifecycle.ts';
import cleanup from './cleanup.ts';
import settings from './settings.ts';
import web from './web.ts';

import type { GuideTopic } from './types.ts';

const TOPICS: Record<string, GuideTopic> = {
  agent,
  facts,
  metro,
  ports,
  logs,
  errors,
  lifecycle,
  cleanup,
  settings,
  web,
};

export default TOPICS;
