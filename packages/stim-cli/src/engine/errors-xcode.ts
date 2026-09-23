import { podInstallCommand } from './bundler.ts';

export interface Diagnostic {
  file?: string | null;
  line?: number | null;
  column?: number | null;
  message: string;
  remedy?: string;
}

export const MAX_DIAGNOSTICS = 10;

const BUILD_FAILED = '** BUILD FAILED **';

const POSITIONED = /^(\S[^\t]*?):(\d+):(?:(\d+):)?\s*(?:fatal\s+)?error:\s+(.+)$/;

const UNPOSITIONED = /^(\S[^\t]*?)?\berror:\s+(.+)$/;

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

const DEVICE_SIGNING_REMEDY =
  "Set a team and a Development profile for the target's configuration in Xcode > Signing & Capabilities, then build once from Xcode to install the profile. Stim never passes -allowProvisioningUpdates, because registering a device or minting a profile changes your Apple Developer account.";

const SIMULATOR_SIGNING_REMEDY =
  "Stim builds for the simulator here, which needs no signing. Check CODE_SIGNING_REQUIRED / DEVELOPMENT_TEAM in the target's configuration, or build for a phone with `stim ios --device`.";

function remedyFor(message: string, root: string | null, sdk: string): string | null {
  if (CAS_CORRUPT.test(message)) {
    return 'The compilation cache holds a damaged object. Run `stim gc --delete --cache "compilation cache"` to empty that cache, then build again. The next build is a cold one.';
  }
  if (PODS_OUT_OF_SYNC.test(message)) {
    const pod = root ? podInstallCommand(root) : 'pod install';
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
  root: string | null,
  sdk: string,
): Diagnostic {
  const text = String(message).trim();
  const out: Diagnostic = { message: text };
  if (file) out.file = file;
  if (line !== null && line !== undefined) out.line = line;
  if (column !== null && column !== undefined) out.column = column;
  out.message = text;
  const remedy = remedyFor(text, root, sdk);
  if (remedy) out.remedy = remedy;
  return out;
}

function dedupeKey(d: Diagnostic): string {
  return `${d.file || ''}|${d.line || ''}|${d.column || ''}|${d.message}`;
}

export function extractXcodeDiagnostics(
  transcript: string,
  root: string | null = null,
  sdk: string = 'iphonesimulator',
): Diagnostic[] {
  if (typeof transcript !== 'string' || transcript === '') return [];
  const collector = createXcodeDiagnosticCollector(root, sdk);
  for (const line of transcript.split('\n')) collector.push(line);
  return collector.diagnostics;
}

export function createXcodeDiagnosticCollector(
  root: string | null = null,
  sdk: string = 'iphonesimulator',
): { push(line: string): void; readonly diagnostics: Diagnostic[] } {
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

  const push = (line: string) => {
    if (finished) return;
    const raw = line.replace(/\r$/, '');

    if (inUndefinedSymbols) {
      const sym = UNDEFINED_SYMBOL.exec(raw);
      if (sym) {
        const symbol = sym[1];
        if (symbol !== undefined) add(makeDiagnostic({ message: undefinedSymbolMessage(symbol) }, root, sdk));
        return;
      }
      if (/^\s+\S/.test(line) && !/^\S/.test(line)) return;
      inUndefinedSymbols = false;
    }

    if (raw.includes(BUILD_FAILED)) {
      finished = true;
      return;
    }

    if (UNDEFINED_HEADER.test(raw)) {
      inUndefinedSymbols = true;
      return;
    }

    const ld = LD_ERROR.exec(raw);
    if (ld) {
      add(makeDiagnostic({ message: `ld: ${ld[1]}` }, root, sdk));
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
          root,
          sdk,
        ),
      );
      return;
    }

    const plain = UNPOSITIONED.exec(raw);
    if (plain) {
      const plainMsg = plain[2];
      if (plainMsg === undefined) return;
      add(makeDiagnostic({ file: fileFromPrefix(plain[1] || ''), message: plainMsg }, root, sdk));
    }
  };

  return { push, diagnostics: out };
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
