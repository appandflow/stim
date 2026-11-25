#!/usr/bin/env node
process.env.UV_THREADPOOL_SIZE ||= '16';
import('./stim.mjs');
