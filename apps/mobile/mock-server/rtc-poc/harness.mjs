// Userland shaper and stat collector. No system network settings are touched.
// TCP: each 1448-byte segment is lost with probability `loss`; a loss holds that segment and everything behind it until
//   one round trip (2*delay + 20 ms) after it would have arrived; losses inside that recovery add nothing (SACK repairs
//   them together). Delivery stays in order. Window collapse and RTO are not modelled.
// UDP: each datagram is dropped with probability `loss` and delayed by `delay`, per direction.
import * as net from 'node:net';
import { createSocket } from 'node:dgram';
import { createServer as http } from 'node:http';
import { appendFileSync, mkdirSync } from 'node:fs';

const [, , outDir = 'runs'] = process.argv;
mkdirSync(outDir, { recursive: true });
const profile = { loss: 0, delay: 0 };
let mode = { transport: 'ws', run: 'none' };
const MSS = 1448;

const tcp = net.createServer((client) => {
  const upstream = new net.Socket();
  upstream.connect(7797, '127.0.0.1');
  pipe(client, upstream);
  pipe(upstream, client);
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
  client.on('close', () => upstream.destroy());
  upstream.on('close', () => client.destroy());
});
function pipe(from, to) {
  let release = 0;
  let queue = [];
  let timer = null;
  const pump = () => {
    timer = null;
    const now = Date.now();
    while (queue.length && queue[0].at <= now) {
      if (!to.destroyed) to.write(queue.shift().data);
      else queue.shift();
    }
    if (queue.length) timer = setTimeout(pump, Math.max(1, queue[0].at - Date.now()));
  };
  let recoveryEnd = 0;
  from.on('data', (data) => {
    const now = Date.now();
    for (let i = 0; i < data.length; i += MSS) {
      let at = Math.max(release, now + profile.delay);
      if (now >= recoveryEnd && Math.random() < profile.loss) recoveryEnd = at + 2 * profile.delay + 20;
      if (now < recoveryEnd) at = Math.max(at, recoveryEnd);
      release = at;
      queue.push({ at, data: data.subarray(i, i + MSS) });
    }
    if (!timer) pump();
  });
  from.on('end', () => setTimeout(() => to.end(), 2 * profile.delay + 50));
}
tcp.listen(7788, '127.0.0.1');

const SERVER_RTC = 47000;
const udp = createSocket('udp4');
const up = createSocket('udp4');
let phone = null;
const send = (socket, data, port, host) => {
  if (Math.random() < profile.loss) return;
  setTimeout(() => socket.send(data, port, host), profile.delay);
};
udp.on('message', (data, rinfo) => {
  phone = rinfo;
  send(up, data, SERVER_RTC, '127.0.0.1');
});
up.on('message', (data) => {
  if (phone) send(udp, data, phone.port, phone.address);
});
udp.bind(47100, '127.0.0.1');
up.bind(0, '127.0.0.1');

http((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/set') {
    profile.loss = Number(url.searchParams.get('loss') ?? 0);
    profile.delay = Number(url.searchParams.get('delay') ?? 0);
    const transport = url.searchParams.get('transport');
    if (transport) mode = { transport, run: url.searchParams.get('run') ?? 'run' };
    console.log('set', profile, mode);
    return res.end(JSON.stringify({ profile, mode }));
  }
  if (url.pathname === '/mode') return res.end(JSON.stringify(mode));
  if (url.pathname === '/stat') {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      appendFileSync(`${outDir}/${mode.run}.ndjson`, body.trim() + '\n');
      res.end('ok');
    });
    return;
  }
  res.statusCode = 404;
  res.end();
}).listen(7790, '127.0.0.1');
console.log('harness up: tcp 7788 -> 7797, udp 47100 -> 47000, control 7790');
