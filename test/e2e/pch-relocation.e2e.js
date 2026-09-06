import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getExecutor } from '../../packages/stim-cli/src/exec.ts';
import { ccacheEnvironment, readCcacheActivity } from '../../packages/stim-cli/src/engine/ccache.ts';
import { resolvePch } from '../../packages/stim-cli/src/engine/pch.ts';

test(
  'PCH hits survive relocation, fresh consumers compile, and changed headers invalidate',
  {
    skip: !process.env.STIM_PCH_TEST_NDK,
    timeout: 120000,
  },
  () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'stim-pch-e2e-')));
    const savedHome = process.env.STIM_HOME;
    process.env.STIM_HOME = join(directory, 'home');
    const ndk = process.env.STIM_PCH_TEST_NDK;
    const cmake = process.env.STIM_PCH_TEST_CMAKE || 'cmake';
    const ccache = process.env.STIM_PCH_TEST_CCACHE || '/opt/homebrew/bin/ccache';
    const run = (file, args, env) => getExecutor().runFile(file, args, { env, timeoutMs: 60000 });
    try {
      for (const name of ['first checkout', 'second checkout']) {
        const root = join(directory, name);
        mkdirSync(join(root, 'include'), { recursive: true });
        mkdirSync(join(root, 'shadow/include'), { recursive: true });
        mkdirSync(join(root, 'vendor'), { recursive: true });
        const header =
          '#pragma once\n#include <string>\ninline int ignored(int unused) { return 1; }\nconstexpr int answer() { return 42; }\n';
        writeFileSync(join(root, 'include/Pch.h'), header);
        writeFileSync(join(root, 'shadow/include/Pch.h'), header.replace('return 42', 'return 99'));
        writeFileSync(join(root, 'config.h'), '#define CONFIG 99\n');
        writeFileSync(join(root, 'vendor/config.h'), '#define CONFIG 7\n');
        const assertions = '#include <config.h>\nstatic_assert(CONFIG == 7);\nstatic_assert(answer() == 42);\n';
        writeFileSync(
          join(root, 'owner.cpp'),
          '#include <config.h>\nstatic_assert(CONFIG == 7);\nint owner() { return answer(); }\n',
        );
        writeFileSync(join(root, 'consumer.cpp'), assertions + 'int consumer() { return answer(); }\n');
        const source = `cmake_minimum_required(VERSION 3.22)\nproject(probe LANGUAGES CXX)\nadd_library(owner STATIC owner.cpp)\ntarget_precompile_headers(owner PRIVATE "\${CMAKE_CURRENT_SOURCE_DIR}/include/Pch.h")\nadd_library(consumer STATIC consumer.cpp)\ntarget_precompile_headers(consumer REUSE_FROM owner)\nforeach(target owner consumer)\n  target_include_directories(\${target} PRIVATE "\${CMAKE_CURRENT_SOURCE_DIR}/shadow")\n  target_include_directories(\${target} SYSTEM PRIVATE "\${CMAKE_CURRENT_SOURCE_DIR}/vendor")\nendforeach()\n`;
        writeFileSync(join(root, 'CMakeLists.txt'), source);
        const setup = { dir: join(directory, 'cache'), statsLog: join(directory, `${name}.stats`), env: {} };
        setup.env = ccacheEnvironment({
          binary: ccache,
          dir: setup.dir,
          workspaceRoot: root,
          statsLog: setup.statsLog,
        });
        const pch = resolvePch(root, setup, process.env);
        assert.ok(pch, 'built PCH adapter is available');
        const env = {
          ...process.env,
          ...setup.env,
          ...pch.env,
          ...(process.env.STIM_PCH_TEST_KEEP
            ? { CCACHE_DEBUG: 'true', CCACHE_DEBUGDIR: join(directory, 'debug') }
            : {}),
        };
        const flags = Object.entries(pch.env).map(
          ([key, value]) => `-D${key === 'STIM_PCH_CMAKE' ? 'CMAKE_PROJECT_INCLUDE' : key}=${value}`,
        );
        const build = join(root, name.startsWith('first') ? 'build/hash-a' : 'build/hash-b');
        const configured = run(
          cmake,
          [
            '-S',
            root,
            '-B',
            build,
            '-G',
            'Ninja',
            `-DCMAKE_MAKE_PROGRAM=${process.env.STIM_PCH_TEST_NINJA || join(dirname(cmake), 'ninja')}`,
            `-DCMAKE_TOOLCHAIN_FILE=${ndk}/build/cmake/android.toolchain.cmake`,
            '-DANDROID_ABI=arm64-v8a',
            '-DANDROID_PLATFORM=android-24',
            '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON',
            '-DCMAKE_CXX_FLAGS=-Werror=unused-parameter',
            ...flags,
          ],
          env,
        );
        assert.match(configured, /Stim: relocatable PCH for owner/);
        writeFileSync(setup.statsLog, '');
        run(cmake, ['--build', build], env);
        assert.equal(readFileSync(join(root, 'CMakeLists.txt'), 'utf8'), source, 'project sources stay unchanged');
        if (name.startsWith('first')) {
          renameSync(root, root + '-unavailable');
          continue;
        }
        assert.equal(readCcacheActivity(setup.statsLog).misses, 0);
        assert.equal(readCcacheActivity(setup.statsLog).hits, 3);
        const generated = readFileSync(join(build, 'CMakeFiles/owner.dir/cmake_pch.hxx'), 'utf8');
        assert.ok(generated.includes(root), 'CMake retains the exact original header declaration');
        writeFileSync(
          join(root, 'consumer.cpp'),
          'static_assert(answer() == 42);\nint changed_consumer() { return answer(); }\n',
        );
        run(cmake, ['--build', build], { ...process.env, CCACHE_DIR: setup.dir });
        writeFileSync(join(root, 'include/Pch.h'), header.replace('return 42', 'return 43'));
        writeFileSync(
          join(root, 'consumer.cpp'),
          'static_assert(answer() == 43);\nint updated_consumer() { return answer(); }\n',
        );
        const changedLog = join(directory, 'changed.stats');
        run(cmake, ['--build', build], { ...env, CCACHE_STATSLOG: changedLog });
        assert.equal(readCcacheActivity(changedLog).misses, 3);
        const exclusions = [
          'set_property(TARGET consumer PROPERTY CXX_COMPILER_LAUNCHER /custom/compiler)',
          'set_property(TARGET owner PROPERTY DISABLE_PRECOMPILE_HEADERS ON)',
          'set_property(TARGET owner PROPERTY PRECOMPILE_HEADERS "$<$<COMPILE_LANGUAGE:CXX>:${CMAKE_CURRENT_SOURCE_DIR}/include/Pch.h>")',
        ];
        for (const exclusion of exclusions) {
          writeFileSync(join(root, 'CMakeLists.txt'), source + exclusion + '\n');
          const output = run(cmake, ['-S', root, '-B', build], env);
          assert.doesNotMatch(output, /Stim: relocatable PCH/);
          const commands = JSON.parse(readFileSync(join(build, 'compile_commands.json'), 'utf8'));
          assert.ok(commands.every((entry) => !entry.command.includes('-relocatable-pch')));
        }
        writeFileSync(join(root, 'CMakeLists.txt'), source);
        writeFileSync(join(root, 'include/Pch.h'), '#pragma once\n#define ANSWER 42\n');
        for (const target of ['owner', 'consumer']) {
          writeFileSync(
            join(root, `${target}.cpp`),
            `static_assert(ANSWER == 42);\nint ${target}() { return ANSWER; }\n`,
          );
        }
        run(cmake, ['-S', root, '-B', build], env);
        run(cmake, ['--build', build], env);
        mkdirSync(join(root, 'actual'));
        writeFileSync(join(root, 'actual/Config.h'), '#define ANSWER 99\n');
        writeFileSync(join(root, 'include/Config.h'), '#define ANSWER 42\n');
        renameSync(join(root, 'include/Pch.h'), join(root, 'actual/Pch.h'));
        writeFileSync(join(root, 'actual/Pch.h'), '#pragma once\n#include "Config.h"\n');
        symlinkSync(join(root, 'actual/Pch.h'), join(root, 'include/Pch.h'));
        assert.doesNotMatch(run(cmake, ['-S', root, '-B', build], env), /Stim: relocatable PCH/);
        run(cmake, ['--build', build], env);
        writeFileSync(join(root, 'include/Mixed.h'), '#pragma once\n#define ANSWER 42\n');
        writeFileSync(join(root, 'mixed.c'), 'int mixed() { return ANSWER; }\n');
        writeFileSync(
          join(root, 'CMakeLists.txt'),
          `cmake_minimum_required(VERSION 3.22)\nproject(probe LANGUAGES C CXX)\nadd_library(mixed STATIC mixed.c owner.cpp)\ntarget_precompile_headers(mixed PRIVATE "\${CMAKE_CURRENT_SOURCE_DIR}/include/Mixed.h")\n`,
        );
        run(cmake, ['-S', root, '-B', build], env);
        run(cmake, ['--build', build], env);
        const mixed = JSON.parse(readFileSync(join(build, 'compile_commands.json'), 'utf8'));
        assert.ok(mixed.some((entry) => entry.file.endsWith('mixed.c') && !entry.command.includes('-relocatable-pch')));
        assert.ok(
          mixed.some((entry) => entry.file.endsWith('owner.cpp') && entry.command.includes('-relocatable-pch')),
        );
      }
    } finally {
      if (process.env.STIM_PCH_TEST_KEEP) console.log(directory);
      else rmSync(directory, { recursive: true, force: true });
      if (savedHome === undefined) delete process.env.STIM_HOME;
      else process.env.STIM_HOME = savedHome;
    }
  },
);
