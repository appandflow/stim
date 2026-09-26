'use strict';

const { randomUUID } = require('node:crypto');

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function clientPidFromLsof(output, clientPort, serverPort) {
  const connection = new RegExp(`:${clientPort}->\\S*:${serverPort}$`);
  let pid = null;
  for (const line of String(output).split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && connection.test(line) && Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}

// An iOS simulator app is a host process, so the peer of its loopback connection names the device's app.
function lookupClientPid(req, runLsof) {
  const { remoteAddress, remotePort, localPort } = req.socket;
  if (!runLsof || !LOOPBACK.has(remoteAddress)) return null;
  return Promise.resolve()
    .then(() => runLsof(['-nP', `-iTCP:${remotePort}`, '-Fpn']))
    .then((output) => clientPidFromLsof(output, remotePort, localPort))
    .catch(() => null);
}

function bundleResponseMiddleware(write, { runLsof } = {}) {
  return (req, res, next) => {
    if (req.method === 'GET' && req.url === '/_stim/metro-warmup') {
      res.end('ready');
      return;
    }
    if (req.headers['x-stim-metro-warmup'] === '1') return next();
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
    const clientPid = platform === 'ios' ? lookupClientPid(req, runLsof) : null;
    const send = (event, statusCode, pid) => {
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
          ...(pid ? { clientPid: pid } : {}),
        });
      } catch {}
    };
    const emit = (event, statusCode) =>
      clientPid ? clientPid.then((pid) => send(event, statusCode, pid)) : send(event, statusCode, null);
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
