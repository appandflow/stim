'use strict';

const { randomUUID } = require('node:crypto');

function bundleResponseMiddleware(write) {
  return (req, res, next) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return next();
    }
    const platform = url.searchParams.get('platform');
    if (req.method !== 'GET' || !/\.bundle\/*$/.test(url.pathname) || !['ios', 'android'].includes(platform)) {
      return next();
    }
    const requestId = randomUUID();
    const emit = (event, statusCode) => {
      try {
        write({
          ts: Date.now(),
          src: 'metro',
          level: event === 'bundle_response_failed' ? 'error' : 'debug',
          event,
          platform,
          requestId,
          statusCode,
          msg: `${platform} bundle response ${event.slice('bundle_response_'.length)}`,
        });
      } catch {}
    };
    emit('bundle_response_started');
    let ended = false;
    const finish = (complete) => {
      if (ended) return;
      ended = true;
      const success = complete && (res.statusCode === 200 || res.statusCode === 304);
      emit(success ? 'bundle_response_finished' : 'bundle_response_failed', res.statusCode);
    };
    res.once('finish', () => finish(true));
    res.once('close', () => finish(false));
    return next();
  };
}

module.exports = { bundleResponseMiddleware };
