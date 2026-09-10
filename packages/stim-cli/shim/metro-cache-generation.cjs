'use strict';

const { createHash } = require('node:crypto');
const { mkdirSync } = require('node:fs');
const { join } = require('node:path');

function applyMetroCacheGeneration(config, generation, directory) {
  if (!generation) return config;
  const fileMapCacheDirectory = join(directory, generation);
  mkdirSync(fileMapCacheDirectory, { recursive: true });
  return {
    ...config,
    cacheVersion: createHash('sha256')
      .update(JSON.stringify([config.cacheVersion ?? '1.0', generation]))
      .digest('hex'),
    fileMapCacheDirectory,
  };
}

module.exports = { applyMetroCacheGeneration };
