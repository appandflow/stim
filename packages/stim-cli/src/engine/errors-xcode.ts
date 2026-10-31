import { podInstallCommand } from './bundler.ts';

export interface Diagnostic {
  file?: string | null;
  line?: number | null;
  column?: number | null;
  message: string;
  remedy?: string;
}

const MAX_DIAGNOSTICS = 10;

const BUILD_FAILED = '** BUILD FAILED **';

const POSITIONED = /^(\S[^\t]*?):(\d+):(?:(\d+):)?\s*(?:fatal\s+)?error:\s+(.+)$/;

const UNPOSITIONED = /^(\S[^\t]*?)?\berror:\s+(.+)$/;

const SCRIPT_WRAPPER = /^error: ([\w.@/-]+) - (.*)$/;
const XTRACE = /^\++ /;
const FAILED_COMMANDS = /^The following build commands failed:\s*$/;
const FAILED_COMMANDS_END = /^\(\d+ failures?\)/;
const FAILED_PHASE = /^\s+PhaseScriptExecution\s+((?:\\.|\S)+)\s.*\(in target '([^']+)'/;
const SCRIPT_LINES_KEPT = 40;
const SCRIPT_DETAIL_MAX = 6;
const SCRIPT_LINE_MAX = 300;

const LD_ERROR = /^ld:\s+(?!warning:)(.+)$/;

const UNDEFINED_HEADER = /^(?:ld:\s+)?Undefined symbols?(?:\s+for architecture\s+\S+)?:\s*$/;
const UNDEFINED_SYMBOL = /^\s+"?([^",]+)"?,\s+referenced from:\s*$/;

function undefinedSymbolMessage(symbol: string): string {
  return `Undefined symbol: ${symbol}`;
}

const PODS_OUT_OF_SYNC = /The sandbox is not in sync with the Podfile\.lock/;

const SIGNING = [
  /No profiles for '.*' were found/,
  /requires a development team/i,
  /[Cc]ode ?[Ss]igning [Ee]rror/,
  /No signing certificate/i,
  /code signing is required/i,
  /errSecInternalComponent/,
  /Provisioning profile .* doesn't (?:include|match)/i,
];

const NO_SUCH_SCHEME = /does not contain a scheme named/;

// Xcode fails the dependency scan when a compilation cache object has the
// wrong node kind. See appandflow/stim#138.
const CAS_CORRUPT = /not a IncludeTreeRoot node kind/;

// The compiler's own reports of a damaged object in its on-disk CAS (llvm/lib/CAS, Xcode's compilation caching).
export const COMPILATION_CACHE_CORRUPTION: RegExp =
  /OnDiskCAS: corrupt internal reference|CAS operation failed|not a IncludeTreeRoot node kind/;

const DEVICE_SIGNING_REMEDY =
  "Set a team for the target's configuration in Xcode > Signing & Capabilities, then run `stim device provision ios`, which lists the Apple Developer account changes and asks before making them (agents run it only with the user's go-ahead), or build once from Xcode to install the profile. Builds never pass -allowProvisioningUpdates, because registering a device or minting a profile changes your Apple Developer account.";

const SIMULATOR_SIGNING_REMEDY =
  "Stim builds for the simulator here, which needs no signing. Check CODE_SIGNING_REQUIRED / DEVELOPMENT_TEAM in the target's configuration, or build for a phone with `stim ios --device`.";

type PodsLocation = { root: string; directory: string } | null;

function remedyFor(message: string, pods: PodsLocation, sdk: string): string | null {
  if (CAS_CORRUPT.test(message)) {
    return 'The compilation cache holds a damaged object. Run `stim gc --delete --cache "compilation cache"` to empty that cache, then build again. The next build is a cold one.';
  }
  if (PODS_OUT_OF_SYNC.test(message)) {
    const pod = pods ? podInstallCommand(pods.root, pods.directory) : 'pod install';
    return `Run \`${pod}\` in ios/ (stim ios does this when Podfile.lock and Pods/Manifest.lock disagree), then build again.`;
  }
  if (NO_SUCH_SCHEME.test(message)) {
    return 'Run `xcodebuild -list` in ios/ to see the schemes this project defines, and share the app scheme so it is visible to the build.';
  }
  for (const pattern of SIGNING) {
    if (pattern.test(message)) {
      return sdk.startsWith('iphoneos') ? DEVICE_SIGNING_REMEDY : SIMULATOR_SIGNING_REMEDY;
    }
  }
  return null;
}

// A prefix is a file only when it looks like a path. "xcodebuild", "clang"
// and "ld" are tool names; carrying them in `file` would make a caller print
// "clang:12" -- a location that does not exist.
function fileFromPrefix(prefix: string): string | null {
  const trimmed = String(prefix).trim().replace(/:$/, '');
  if (!trimmed) return null;
  const head = (trimmed.split(': ')[0] ?? '').trim();
  if (!head.includes('/')) return null;
  return head;
}

function makeDiagnostic(
  {
    file = null,
    line = null,
    column = null,
    message,
  }: {
    file?: string | null;
    line?: number | null;
    column?: number | null;
    message: string;
  },
  pods: PodsLocation,
  sdk: string,
): Diagnostic {
  const text = String(message).trim();
  const out: Diagnostic = { message: text };
  if (file) out.file = file;
  if (line !== null && line !== undefined) out.line = line;
  if (column !== null && column !== undefined) out.column = column;
  out.message = text;
  const remedy = remedyFor(text, pods, sdk);
  if (remedy) out.remedy = remedy;
  return out;
}

function unescape(token: string): string {
  return token.replace(/\\(.)/g, '$1');
}

function dedupeKey(d: Diagnostic): string {
  return `${d.file || ''}|${d.line || ''}|${d.column || ''}|${d.message}`;
}

function failureDiagnostics(phases: string[], scriptLines: string[]): Diagnostic[] {
  if (phases.length === 0) return [];
  const anchor = scriptLines.findLastIndex((text) => text.startsWith('error:'));
  const detail = anchor >= 0 ? scriptLines.slice(anchor, anchor + SCRIPT_DETAIL_MAX) : scriptLines.slice(-3);
  return [
    ...phases.map((phase) => ({ message: phase })),
    ...detail.map((text) => ({ message: text.replace(/^error:\s*/, '') })),
  ];
}

/**
 * Reads xcodebuild output line by line. `diagnostics` lists, first, the script phases xcodebuild's
 * `The following build commands failed:` block names and the last error lines the script printed, then the
 * errors found along the way. A script wrapper such as `error: sentry-cli - ` prefixes every line of its
 * output, bash xtrace included; the prefix is removed and the trace lines are dropped.
 */
export function createXcodeDiagnosticCollector(
  root: string | null = null,
  sdk: string = 'iphonesimulator',
  podDirectory: string | null = root,
): { push(line: string): void; readonly diagnostics: Diagnostic[] } {
  const failedPhases: string[] = [];
  const scriptLines: string[] = [];
  let inFailedCommands = false;
  const pods = root ? { root, directory: podDirectory ?? root } : null;
  const out: Diagnostic[] = [];
  const seen = new Set<string>();
  let finished = false;
  let inUndefinedSymbols = false;

  const add = (d: Diagnostic) => {
    const key = dedupeKey(d);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(d);
  };

  const pushFailedCommand = (raw: string) => {
    if (FAILED_COMMANDS.test(raw)) {
      inFailedCommands = true;
      return;
    }
    if (!inFailedCommands) return;
    if (FAILED_COMMANDS_END.test(raw)) {
      inFailedCommands = false;
      return;
    }
    const phase = FAILED_PHASE.exec(raw);
    if (!phase) return;
    const message = `Build phase failed: "${unescape(phase[1] ?? '')}" (target ${phase[2]})`;
    if (!failedPhases.includes(message)) failedPhases.push(message);
  };

  const push = (line: string) => {
    if (finished) {
      pushFailedCommand(line.replace(/\r$/, ''));
      return;
    }
    let raw = line.replace(/\r$/, '');

    if (inUndefinedSymbols) {
      const sym = UNDEFINED_SYMBOL.exec(raw);
      if (sym) {
        const symbol = sym[1];
        if (symbol !== undefined) add(makeDiagnostic({ message: undefinedSymbolMessage(symbol) }, pods, sdk));
        return;
      }
      if (/^\s+\S/.test(line) && !/^\S/.test(line)) return;
      inUndefinedSymbols = false;
    }

    if (raw.includes(BUILD_FAILED)) {
      finished = true;
      return;
    }

    const wrapped = SCRIPT_WRAPPER.exec(raw);
    if (wrapped) {
      const text = (wrapped[2] ?? '').trim();
      if (XTRACE.test(text)) return;
      if (text) {
        scriptLines.push(text.length > SCRIPT_LINE_MAX ? `${text.slice(0, SCRIPT_LINE_MAX - 3)}...` : text);
        if (scriptLines.length > SCRIPT_LINES_KEPT) scriptLines.shift();
      }
      raw = text;
    }

    if (UNDEFINED_HEADER.test(raw)) {
      inUndefinedSymbols = true;
      return;
    }

    const ld = LD_ERROR.exec(raw);
    if (ld) {
      add(makeDiagnostic({ message: `ld: ${ld[1]}` }, pods, sdk));
      return;
    }

    const positioned = POSITIONED.exec(raw);
    if (positioned) {
      const posMsg = positioned[4];
      if (posMsg === undefined) return;
      add(
        makeDiagnostic(
          {
            file: positioned[1],
            line: Number(positioned[2]),
            column: positioned[3] === undefined ? null : Number(positioned[3]),
            message: posMsg,
          },
          pods,
          sdk,
        ),
      );
      return;
    }

    const plain = UNPOSITIONED.exec(raw);
    if (plain) {
      const plainMsg = plain[2];
      if (plainMsg === undefined) return;
      add(makeDiagnostic({ file: fileFromPrefix(plain[1] || ''), message: plainMsg }, pods, sdk));
    }
  };

  return {
    push,
    get diagnostics() {
      const merged: Diagnostic[] = [];
      const keys = new Set<string>();
      for (const d of [...failureDiagnostics(failedPhases, scriptLines), ...out]) {
        const key = dedupeKey(d);
        if (keys.has(key)) continue;
        keys.add(key);
        merged.push(d);
      }
      return merged;
    },
  };
}

export function capDiagnostics(
  diagnostics: Diagnostic[],
  max: number = MAX_DIAGNOSTICS,
): { diagnostics: Diagnostic[]; truncated: number } {
  const list = Array.isArray(diagnostics) ? diagnostics : [];
  if (list.length <= max) return { diagnostics: list.slice(), truncated: 0 };
  return { diagnostics: list.slice(0, max), truncated: list.length - max };
}

export function describeDiagnostic(diagnostic?: Diagnostic | null): string {
  if (!diagnostic || typeof diagnostic !== 'object') return '';
  const { file, line, column, message } = diagnostic;
  if (!file) return String(message ?? '');
  const position = line ? (column ? `:${line}:${column}` : `:${line}`) : '';
  return `${file}${position}: ${message}`;
}
