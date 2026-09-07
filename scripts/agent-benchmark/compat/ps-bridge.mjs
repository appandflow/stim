#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const fields = args.at(-1);
const supported = ['lstart=', 'state=', 'command=', 'pid=,state=,lstart=', 'pid=,ppid=,command='];
if (!supported.includes(fields)) process.exit(2);
const all = args.join(' ') === '-ax -o pid=,ppid=,command=';
const selected = args.length === 4 && args[0] === '-p' && args[2] === '-o' ? args[1].split(',') : [];
if (!all && (!selected.length || selected.some((pid) => !/^[1-9]\d{0,9}$/.test(pid)))) process.exit(2);

function startTime(seconds) {
  const date = new Date(Number(seconds) * 1000);
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()];
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getMonth()];
  const time = [date.getHours(), date.getMinutes(), date.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
  return `${day} ${month} ${String(date.getDate()).padStart(2, ' ')} ${time} ${date.getFullYear()}`;
}

try {
  const text = execFileSync(fileURLToPath(new URL('./native-process', import.meta.url)), all ? ['--all'] : selected, {
    encoding: 'utf8',
    timeout: 1000,
    maxBuffer: 8 * 1024 * 1024,
  });
  for (const line of text.trim().split('\n').filter(Boolean)) {
    const value = JSON.parse(line);
    const bytes = Buffer.from(value.argvHex, 'hex');
    const decoded = bytes.toString('utf8');
    const argv = decoded.split('\0');
    if (!Buffer.from(decoded).equals(bytes) || argv.pop() !== '' || argv.length !== value.argc) process.exit(1);
    const command = argv.join(' ').trim();
    const state = value.zombie ? 'Z' : 'S';
    const start = startTime(value.startSeconds);
    const output = {
      'lstart=': start,
      'state=': state,
      'command=': command,
      'pid=,state=,lstart=': `${value.pid} ${state} ${start}`,
      'pid=,ppid=,command=': `${value.pid} ${value.ppid} ${command}`,
    };
    process.stdout.write(`${output[fields]}\n`);
  }
} catch {
  process.exitCode = 1;
}
