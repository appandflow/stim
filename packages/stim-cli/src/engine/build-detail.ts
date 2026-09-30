import type { BuildDetail, NativeBuildStep } from '@stim-cli/core/state';

const LINE_MAX = 160;
const TARGET_GRAPH = /^note: Target dependency graph \((\d+) targets?\)/;
const XCODE_ACTION = /^([A-Z][A-Za-z]+)\s(.*)\s\(in target '([^']+)' from project '([^']+)'\)$/;
const XCODE_CONFIGURE =
  /^(ComputeTargetDependencyGraph|CreateBuildDescription|CreateBuildRequest|Resolve Package Graph|Prepare packages)$/;
const GRADLE_TASK = /^> Task (:\S+)/;
/**
 * xcodebuild actions that end a target's work: a clean build touches each product last, and an incremental build
 * that touches nothing still signs framework products last. Targets that end any other way are not counted.
 */
const XCODE_TARGET_DONE = /^(Touch|RegisterExecutionPolicyException|CodeSign)$/;
const GRADLE_CONFIGURE = /^> Configure project /;

const XCODE_STEPS: [RegExp, NativeBuildStep][] = [
  [
    /^(CpResource|CopyPNGFile|CopyStringsFile|CompileAssetCatalog\w*|CompileStoryboard|CompileXIB|LinkStoryboards|ProcessInfoPlistFile)$/,
    'resources',
  ],
  [/^(Compile\w*|Swift\w*|ScanDependencies|Precompile\w*)$/, 'compile'],
  [/^(Ld|Libtool|CreateUniversalBinary|GenerateDSYMFile)$/, 'link'],
  [/^PhaseScriptExecution$/, 'script'],
  [/^CodeSign$/, 'sign'],
];

const GRADLE_STEPS: [RegExp, NativeBuildStep][] = [
  [/[Dd]ex/, 'dex'],
  [/^(createBundle\w*JsAndAssets|generateCodegen\w*)$/, 'script'],
  [/(Resources?|Assets|Manifest|ResValues|RFile|JavaRes)$/, 'resources'],
  [/^(compile|kapt|ksp|javaPreCompile|buildCMake|configureCMake|externalNativeBuild)/, 'compile'],
  [/^(package|assemble|install|zipalign|validateSigning|merge\w*NativeLibs|strip\w*Symbols)/, 'package'],
];

function stepOf(name: string, table: [RegExp, NativeBuildStep][]): NativeBuildStep | null {
  return table.find(([pattern]) => pattern.test(name))?.[1] ?? null;
}

function clip(text: string): string {
  return text.length > LINE_MAX ? `${text.slice(0, LINE_MAX - 3)}...` : text;
}

function unescape(token: string): string {
  return token.replace(/\\(.)/g, '$1');
}

function baseName(path: string): string {
  return path.split('/').findLast(Boolean) ?? path;
}

/**
 * An xcodebuild action line in short form: the action, the file it works on and its target, as in
 * `CompileC sqlite3.c (sqlite3)`. The file is the last absolute path in the arguments, which xcodebuild prints
 * as the source for compile, copy and plist steps and as the product for link and sign steps; a script phase
 * shows its name instead.
 */
function shortXcodeAction(action: string, args: string, target: string): string {
  const tokens = args.match(/(?:\\.|\S)+/g) ?? [];
  const subject =
    action === 'PhaseScriptExecution'
      ? unescape(tokens[0] ?? '')
      : baseName(unescape(tokens.findLast((token) => token.startsWith('/')) ?? ''));
  return clip(`${action}${subject ? ` ${subject}` : ''} (${target})`);
}

export type BuildToolLine =
  | { kind: 'total'; unit: 'targets'; total: number }
  | { kind: 'configure' }
  | {
      kind: 'unit';
      unit: 'targets' | 'tasks';
      id: string;
      step: NativeBuildStep | null;
      line: string | null;
      finished: boolean;
    };

/** What one line of xcodebuild or Gradle output says about the build's progress, or null for any other line. */
export function parseBuildToolLine(msg: string): BuildToolLine | null {
  const graph = TARGET_GRAPH.exec(msg);
  if (graph) return { kind: 'total', unit: 'targets', total: Number(graph[1]) };
  if (XCODE_CONFIGURE.test(msg) || GRADLE_CONFIGURE.test(msg)) return { kind: 'configure' };
  const action = XCODE_ACTION.exec(msg);
  if (action) {
    const [, name, args, target, project] = action as unknown as [string, string, string, string, string];
    const step = stepOf(name, XCODE_STEPS);
    return {
      kind: 'unit',
      unit: 'targets',
      id: `${project}/${target}`,
      step,
      line: step ? shortXcodeAction(name, args, target) : null,
      finished: XCODE_TARGET_DONE.test(name),
    };
  }
  const task = GRADLE_TASK.exec(msg);
  if (task) {
    const path = task[1]!;
    return {
      kind: 'unit',
      unit: 'tasks',
      id: path,
      step: stepOf(path.slice(path.lastIndexOf(':') + 1), GRADLE_STEPS),
      line: clip(`> Task ${path}`),
      finished: false,
    };
  }
  return null;
}

export interface BuildDetailParser {
  /** Reads one line of tool output; true when the detail changed. */
  push(msg: string): boolean;
  detail(updatedAt: string): BuildDetail | null;
}

/**
 * Accumulates a build's tool output into its detail: xcodebuild counts the distinct targets it finished against the
 * total its dependency graph note gives; Gradle counts the task lines it printed and has no total.
 */
export function createBuildDetailParser(): BuildDetailParser {
  let seen = false;
  let step: NativeBuildStep | null = null;
  let unit: BuildDetail['unit'] = null;
  let total: number | null = null;
  let line: string | null = null;
  let tasks = 0;
  const targets = new Set<string>();
  return {
    push(msg) {
      const parsed = parseBuildToolLine(msg);
      if (!parsed) return false;
      seen = true;
      if (parsed.kind === 'total') {
        unit = 'targets';
        total = parsed.total;
        return true;
      }
      if (parsed.kind === 'configure') {
        step = 'configure';
        return true;
      }
      unit = parsed.unit;
      if (parsed.unit === 'tasks') tasks += 1;
      else if (parsed.finished) targets.add(parsed.id);
      if (parsed.step) step = parsed.step;
      if (parsed.line) line = parsed.line;
      return true;
    },
    detail(updatedAt) {
      if (!seen) return null;
      const done = unit === 'tasks' ? tasks : unit === 'targets' ? targets.size : null;
      return {
        step,
        unit,
        done: done !== null && total !== null ? Math.min(done, total) : done,
        total: unit === 'tasks' ? null : total,
        line,
        updatedAt,
      };
    },
  };
}
