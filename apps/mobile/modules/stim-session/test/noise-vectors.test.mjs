import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { fetchLibsodium, libsodiumDir } from '../scripts/fetch-libsodium.mjs';

const module = fileURLToPath(new URL('..', import.meta.url));
const sodium = join(libsodiumDir, 'src');
const fixtures = fileURLToPath(new URL('../../../../../packages/core/__tests__/fixtures/', import.meta.url));
const SODIUM_DEFINES = [
  'CONFIGURED=1',
  'NATIVE_LITTLE_ENDIAN=1',
  'SODIUM_STATIC=1',
  'HAVE_TI_MODE=1',
  'HAVE_STDINT_H=1',
  'HAVE_INTTYPES_H=1',
  'HAVE_C11_MEMORY_FENCES=1',
  'HAVE_ATOMIC_OPS=1',
  'HAVE_GCC_MEMORY_FENCES=1',
  'TLS=_Thread_local',
  'HAVE_PTHREAD=1',
  'HAVE_MMAP=1',
  'HAVE_MLOCK=1',
  'HAVE_MPROTECT=1',
  'HAVE_MADVISE=1',
  'HAVE_POSIX_MEMALIGN=1',
  'HAVE_SYS_MMAN_H=1',
  'HAVE_SYS_PARAM_H=1',
  'HAVE_NANOSLEEP=1',
  'HAVE_CLOCK_GETTIME=1',
  'HAVE_SYSCONF=1',
  'HAVE_GETPID=1',
].map((define) => `-D${define}`);

function sources() {
  return readFileSync(join(module, 'libsodium-sources.txt'), 'utf8').split('\n').filter(Boolean);
}

/** Compiles the fetched libsodium once per source set into the temporary directory, then links the vector runner. */
function build() {
  const files = sources();
  const stamp = createHash('sha256');
  for (const file of files) stamp.update(file).update(String(statSync(join(sodium, file)).mtimeMs));
  const out = join(tmpdir(), `stim-session-noise-${stamp.digest('hex').slice(0, 12)}`);
  mkdirSync(out, { recursive: true });
  const objects = files.map((file, index) => {
    const object = join(out, `${index}.o`);
    if (!existsSync(object)) {
      execFileSync('cc', [
        '-c',
        '-O2',
        '-w',
        '-fwrapv',
        '-fno-strict-aliasing',
        ...SODIUM_DEFINES,
        `-I${join(sodium, 'include/sodium')}`,
        `-I${join(sodium, 'include')}`,
        join(sodium, file),
        '-o',
        object,
      ]);
    }
    return object;
  });
  const binary = join(out, 'noise-vectors');
  execFileSync('c++', [
    '-std=c++20',
    '-O2',
    '-Wall',
    '-Wextra',
    `-I${join(module, 'cpp')}`,
    `-I${join(sodium, 'include')}`,
    join(module, 'cpp/Noise.cpp'),
    join(module, 'test/noise-vectors.cpp'),
    ...objects,
    '-o',
    binary,
  ]);
  return binary;
}

function lines() {
  const { vectors } = JSON.parse(readFileSync(join(fixtures, 'noise-vectors.json'), 'utf8'));
  const framing = JSON.parse(readFileSync(join(fixtures, 'noise-framing-vectors.json'), 'utf8')).vectors;
  const out = [];
  for (const [index, v] of vectors.entries()) {
    const psk = (list) => list?.[0] ?? '-';
    out.push(
      [
        'V',
        `${v.source}#${index}`,
        v.protocol_name,
        v.init_prologue || '-',
        v.init_static,
        v.init_ephemeral,
        psk(v.init_psks),
        v.resp_prologue || '-',
        v.resp_static,
        v.resp_ephemeral,
        psk(v.resp_psks),
        v.handshake_hash || '-',
        v.messages.length,
      ].join(' '),
    );
    for (const m of v.messages) out.push(['M', m.payload || '-', m.ciphertext].join(' '));
  }
  for (const f of framing) out.push(['F', f.key, f.counter, f.type, f.data || '-', f.ciphertext].join(' '));
  return { input: `${out.join('\n')}\n`, handshakes: vectors.length, framings: framing.length };
}

test('the native Noise implementation reproduces every Noise and framing vector', async () => {
  await fetchLibsodium();
  const { input, handshakes, framings } = lines();
  const output = execFileSync(build(), { input, encoding: 'utf8' });
  assert.equal(output.trim(), `${handshakes} handshake vectors, ${framings} framing vectors, 0 failures`);
});
