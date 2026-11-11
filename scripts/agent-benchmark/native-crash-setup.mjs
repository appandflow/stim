import { basename } from 'node:path';

const TOKEN = /^STIM_BENCH_LAUNCH_CRASH_[0-9A-F]{12}$/;

const SWIFT_ANCHOR = 'struct NativeAcceptance: App {\n';
const KOTLIN_ANCHOR = '    super.onCreate(state)\n';
const EXACT_STATEMENTS = {
  rust: (token) => `panic!("${token}");`,
  typescript: (token) => `throw new Error('${token}');`,
};

export function nativeCrashPlan(fixture) {
  if (fixture.framework === 'native-xcode' || fixture.framework === 'native-swiftpm') {
    return { kind: 'swift', source: fixture.source };
  }
  if (fixture.framework === 'native-gradle') return { kind: 'kotlin', source: fixture.source };
  if (fixture.framework === 'exact') {
    const crash = fixture.crash;
    if (!crash?.source || !crash.anchor || !EXACT_STATEMENTS[crash.language]) {
      throw new Error('Exact fixture.json needs crash: { source, anchor, language: rust|typescript }');
    }
    return { kind: 'exact', source: crash.source, anchor: crash.anchor, language: crash.language };
  }
  throw new Error(`no native launch crash is defined for framework ${fixture.framework}`);
}

function insertAfter(source, anchor, text) {
  const at = source.indexOf(anchor);
  if (at === -1) throw new Error(`launch-crash anchor was not found: ${JSON.stringify(anchor.trim())}`);
  if (source.indexOf(anchor, at + 1) !== -1) throw new Error('launch-crash anchor is not unique');
  const end = at + anchor.length;
  return `${source.slice(0, end)}${text}${source.slice(end)}`;
}

export function injectNativeCrash(source, plan, token) {
  if (!TOKEN.test(token)) throw new Error('launch-crash token has an unexpected format');
  if (source.includes(token)) throw new Error('launch-crash token is already present');
  if (plan.kind === 'swift') {
    return insertAfter(
      source,
      SWIFT_ANCHOR,
      `    init() {\n        NSLog("%@", "${token}")\n        fatalError("${token}")\n    }\n`,
    );
  }
  if (plan.kind === 'kotlin')
    return insertAfter(source, KOTLIN_ANCHOR, `    throw IllegalStateException("${token}")\n`);
  const line = EXACT_STATEMENTS[plan.language](token);
  const anchorEnd = plan.anchor.endsWith('\n') ? plan.anchor : `${plan.anchor}\n`;
  return insertAfter(source, anchorEnd, `${line}\n`);
}

export function nativeCrashReproduced(commands, { token, source }) {
  const inspected = (command) => String(command.command ?? '').includes(basename(source));
  const ordered = commands.toSorted((a, b) => (a.startEventOffset ?? 0) - (b.startEventOffset ?? 0));
  const capture = ordered.findIndex((command) => String(command.output ?? '').includes(token));
  if (capture === -1) return { valid: false, reason: 'native-crash-not-captured' };
  if (ordered.slice(0, capture + 1).some(inspected)) {
    return { valid: false, reason: 'native-crash-source-inspected-before-capture' };
  }
  return { valid: true };
}
