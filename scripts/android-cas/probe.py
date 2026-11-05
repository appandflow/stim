import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

here = Path(__file__).resolve().parent
resolver = (here.parents[1] / "packages/stim-cli/src/engine/android-cas.ts").as_uri()
setup_script = f"import {{ resolveAndroidCas }} from {json.dumps(resolver)}; console.log(JSON.stringify(resolveAndroidCas(process.argv[1])));"
out = Path(sys.argv[1]).resolve()
out.mkdir()
sdk = Path(os.environ["ANDROID_HOME"])
cmake = sdk / "cmake/3.22.1/bin/cmake"
env = {**os.environ, "STIM_HOME": str(out / "stim-home"),
       "STIM_ANDROID_CAS_TOOLCHAIN": str(Path(os.environ["STIM_ANDROID_CAS_TOOLCHAIN"]).resolve())}
commands = []
results = []

def run(args, cwd=out, active_env=env, success=True):
    args = list(map(str, args))
    p = subprocess.run(args, cwd=cwd, env=active_env, text=True, capture_output=True)
    commands.append(dict(argv=args, cwd=str(cwd), code=p.returncode, stdout=p.stdout, stderr=p.stderr))
    (out / "commands.json").write_text(json.dumps(commands, indent=2))
    if success:
        p.check_returncode()
    return p

repo = out / "repo"
repo.mkdir()
run(["git", "init", repo])
(repo / "CMakeLists.txt").write_text('''cmake_minimum_required(VERSION 3.22)
project(StimCasProbe CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_INTERPROCEDURAL_OPTIMIZATION ON)
file(WRITE "${CMAKE_BINARY_DIR}/generated.h" "#define GENERATED_VALUE 9\\n")
add_library(probe SHARED main.cpp)
target_compile_options(probe PRIVATE -Xclang -fno-pch-timestamp)
target_include_directories(probe PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/early" "${CMAKE_CURRENT_SOURCE_DIR}/include")
target_precompile_headers(probe PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/pch.h" "${CMAKE_BINARY_DIR}/generated.h")
''')
(repo / "main.cpp").write_text('static_assert(VALUE == 42); static_assert(GENERATED_VALUE == 9); int original() { return VALUE; }\n')
(repo / "pch.h").write_text('#pragma once\n#define MARKER 7\n#include "sibling.h"\n#include <selected.h>\n#include "link/../symlink-parent.h"\n#include <vector>\n')
(repo / "sibling.h").write_text('static_assert(MARKER == 7);\n')
(repo / "selected.h").write_text('#error root must not be searched\n')
(repo / "symlink-parent.h").write_text('#error symlink dotdot was normalized\n')
for d in ["early", "include", "actual/deep"]:
    (repo / d).mkdir(parents=True)
    (repo / d / ".keep").touch()
(repo / "actual/symlink-parent.h").write_text('static_assert(MARKER == 7);\n')
(repo / "include/selected.h").write_text('#define VALUE 42\n')
(repo / "link").symlink_to("actual/deep")
run(["git", "add", "."], repo)
run(["git", "-c", "user.name=POC", "-c", "commit.gpgsign=false", "-c", "user.email=poc@example.invalid", "commit", "-m", "Fixture"], repo)
digest_a = None
for checkout in ["A", "B"]:
    source = out / ("source-A" if checkout == "A" else "different depth/source B")
    build = out / ("generated-A/hash-a" if checkout == "A" else "separate/build B/hash-b")
    run(["git", "worktree", "add", "--detach", source], repo)
    setup = json.loads(run(["node", "--experimental-strip-types", "--input-type=module", "-e", setup_script, source]).stdout)
    active_env = {**env, **setup["env"]}
    configure = [cmake, "-S", source, "-B", build, "-G", "Ninja",
                 "-DCMAKE_MAKE_PROGRAM=" + str(cmake.parent / "ninja"),
                 "-DCMAKE_TOOLCHAIN_FILE=" + setup["env"]["STIM_ANDROID_CAS_CMAKE_TOOLCHAIN"],
                 "-DCMAKE_PROJECT_INCLUDE=" + setup["env"]["STIM_ANDROID_CAS_CMAKE_PCH"],
                 "-DSTIM_ANDROID_CAS_STATE=" + setup["env"]["STIM_ANDROID_CAS_STATE"],
                 "-DANDROID_ABI=arm64-v8a", "-DANDROID_PLATFORM=android-24", "-DCMAKE_BUILD_TYPE=Release"]
    run(configure, active_env=active_env)
    log = Path(setup["env"]["STIM_ANDROID_CAS_STATE"]) / "compiler.jsonl"
    def build_stage(label, clean=False):
        if clean:
            run([cmake, "--build", build, "--target", "clean"], active_env=active_env)
        log.write_text("")
        run([cmake, "--build", build, "--parallel", "2"], active_env=active_env)
        rows = [json.loads(line) for line in log.read_text().splitlines()]
        (out / (label + ".compiler.json")).write_text(json.dumps(rows, indent=2))
        compiles = [r for r in rows if "-c" in r["argv"]]
        pchs = [r for r in compiles if any(a.endswith("cmake_pch.hxx.cxx") for a in r["argv"])]
        record = dict(stage=label, hits=sum("compile job cache hit" in r["stderr"] for r in compiles),
                      misses=sum("compile job cache miss" in r["stderr"] for r in compiles),
                      pch_hits=sum("compile job cache hit" in r["stderr"] for r in pchs),
                      pch_misses=sum("compile job cache miss" in r["stderr"] for r in pchs),
                      thinlto=all("-flto=thin" in r["argv"] for r in compiles))
        assert record["thinlto"], record
        results.append(record)
        (out / "results.json").write_text(json.dumps(results, indent=2))
        return record
    row = build_stage(checkout)
    pch = build / "CMakeFiles/probe.dir/cmake_pch.hxx.pch"
    digest = hashlib.sha256(pch.read_bytes()).hexdigest()
    if checkout == "A":
        digest_a = digest
        source.rename(out / "source-A-unavailable")
        build.rename(out / "generated-A-unavailable")
    else:
        assert not (out / "source-A").exists()
        assert not (out / "generated-A/hash-a").exists()
        assert row["hits"] == 2 and row["misses"] == 0 and row["pch_hits"] == 1, row
        assert digest == digest_a
        consumer = source / "main.cpp"
        consumer.write_text(consumer.read_text().replace("original()", "changed()"))
        row = build_stage("changed-consumer")
        assert row["misses"] == 1 and row["pch_misses"] == 0
        assert hashlib.sha256(pch.read_bytes()).hexdigest() == digest
        header = source / "include/selected.h"
        oldsize = header.stat().st_size
        header.write_text(header.read_text().replace("42", "43"))
        assert header.stat().st_size == oldsize
        consumer.write_text(consumer.read_text().replace("42", "43"))
        row = build_stage("same-size-header")
        assert row["pch_misses"] == 1 and row["misses"] == 2
        (source / "early/selected.h").write_text('#define VALUE 44\n')
        consumer.write_text(consumer.read_text().replace("43", "44"))
        row = build_stage("new-include-shadow", clean=True)
        assert row["pch_misses"] == 1 and row["misses"] == 2
        run(configure + ["-DCMAKE_CXX_FLAGS=-DSETTING_CHANGED=1"], active_env=active_env)
        row = build_stage("compiler-setting", clean=True)
        assert row["pch_misses"] == 1 and row["misses"] == 2
print(out)
print(json.dumps(results, indent=2))
