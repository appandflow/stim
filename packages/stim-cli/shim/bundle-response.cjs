'use strict';

const { randomUUID } = require('node:crypto');

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
// Metro writes each progress update of a multipart bundle response as its own JSON part:
// https://github.com/facebook/metro/blob/main/packages/metro/src/Server.js (`writeChunk` with done, total, percent).
const PROGRESS_PART = /^\{"done":(\d+),"total":(\d+),"percent":(\d+)\}$/;
const PROGRESS_INTERVAL_MS = 1000;

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
    const prefetch = req.headers['x-stim-metro-warmup'] === '1';
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
    const kind = prefetch ? 'prefetch' : 'response';
    const clientPid = platform === 'ios' && !prefetch ? lookupClientPid(req, runLsof) : null;
    const send = (ts, stage, statusCode, pid, progress) => {
      try {
        write({
          ts,
          src: 'metro',
          level: stage === 'failed' && !prefetch ? 'error' : 'debug',
          event: `bundle_${kind}_${stage}`,
          platform,
          requestId,
          ...(progress ?? { statusCode }),
          msg: progress ? `${platform} bundle ${progress.percent}%` : `${platform} bundle ${kind} ${stage}`,
          ...(pid ? { clientPid: pid } : {}),
        });
      } catch {}
    };
    const emit = (stage, statusCode, progress) => {
      const ts = Date.now();
      if (clientPid) clientPid.then((pid) => send(ts, stage, statusCode, pid, progress));
      else send(ts, stage, statusCode, null, progress);
    };
    emit('started');
    const writeChunk = res.write;
    let progressAt = 0;
    res.write = function (chunk, ...rest) {
      const part = typeof chunk === 'string' && chunk.length < 100 ? PROGRESS_PART.exec(chunk) : null;
      const now = part ? Date.now() : 0;
      if (part && now - progressAt >= PROGRESS_INTERVAL_MS) {
        progressAt = now;
        emit('progress', undefined, { done: Number(part[1]), total: Number(part[2]), percent: Number(part[3]) });
      }
      return writeChunk.call(this, chunk, ...rest);
    };
    let ended = false;
    const finish = (complete) => {
      if (ended) return;
      ended = true;
      const success = complete && (res.statusCode === 200 || res.statusCode === 304);
      emit(success ? 'finished' : 'failed', res.statusCode);
    };
    res.once('finish', () => finish(true));
    res.once('close', () => finish(false));
    return next();
  };
}

module.exports = { bundleResponseMiddleware };
