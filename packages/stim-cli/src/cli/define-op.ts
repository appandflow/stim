import { parseArgs } from 'node:util';

export interface OpOption {
  /**
   * Commander-style flags: `--json`, `--scope <scope>`, `--source <s...>`, `--name [value]` (an optional value), or
   * `--no-name`, which sets the `--name` option's key to false. Without a `--name` option beside it, `--no-name`'s own
   * key defaults to true, as commander's lone negation does.
   */
  readonly flags: string;
  readonly description: string;
  /** Refuse the command line when the option is absent, as commander's `requiredOption`. */
  readonly mandatory?: boolean;
  /** Converts the value; a throw becomes a `STIM_BAD_ARG` usage error naming the flag and value. */
  readonly parse?: (value: string) => unknown;
  /** Each use appends its value to a list that starts empty, as commander's collecting option. */
  readonly repeatable?: boolean;
  /** The value when the option is absent; help shows it as commander does. */
  readonly default?: string;
  /** Parsed, but left out of help. */
  readonly hidden?: boolean;
}

type OptionValue<O extends OpOption> = O extends { parse: (value: string) => infer T }
  ? T
  : O extends { repeatable: true }
    ? string[]
    : O['flags'] extends `${string}...>`
      ? string[]
      : O['flags'] extends `${string}<${string}>`
        ? string
        : O['flags'] extends `${string}[${string}]`
          ? string | true
          : true;

type LongName<F extends string> = F extends `--${infer N} ${string}` ? N : F extends `--${infer N}` ? N : never;
type Negated<O extends Record<string, OpOption>> = {
  [K in keyof O]: LongName<O[K]['flags']> extends `no-${infer P}` ? P : never;
}[keyof O];
type LongNames<O extends Record<string, OpOption>> = { [K in keyof O]: LongName<O[K]['flags']> }[keyof O];
type Paired<O extends Record<string, OpOption>, F extends string> =
  LongName<F> extends `no-${infer P}` ? (P extends LongNames<O> ? true : false) : false;
type OptionType<O extends Record<string, OpOption>, K extends keyof O> =
  LongName<O[K]['flags']> extends `no-${string}`
    ? boolean
    : OptionValue<O[K]> | (LongName<O[K]['flags']> extends Negated<O> ? false : never);
type Defaulted<O extends OpOption> = O extends { default: string } | { repeatable: true } ? true : false;
type OptionValues<O extends Record<string, OpOption>> = {
  readonly [
    K in keyof O as Paired<O, O[K]['flags']> extends true ? never : Defaulted<O[K]> extends true ? never : K
  ]?: OptionType<O, K>;
} & {
  readonly [K in keyof O as Defaulted<O[K]> extends true ? K : never]: OptionType<O, K>;
};

type ArgValue<S extends string> = S extends `<${string}>` ? string : string | undefined;
type ArgValues<S extends string> = S extends `[${string}...]`
  ? string[]
  : S extends `${infer Head} ${infer Tail}`
    ? [ArgValue<Head>, ...ArgValues<Tail>]
    : S extends ''
      ? []
      : [ArgValue<S>];

export interface OpInput<Options, Args> {
  readonly args: Args;
  readonly options: Options;
  /** The parent's options: those before the subcommand's name, or anywhere when the parent has no `positionalOptions`. */
  readonly parent: Readonly<Record<string, unknown>>;
  readonly version: string;
}

/** A command: its argv and help derive from `arguments` and `options`. */
export interface Op {
  readonly name: string;
  readonly arguments: string;
  /** Help's `Arguments:` section, by argument name; commander lists every argument once any has a description. */
  readonly argumentDescriptions: Readonly<Record<string, string>>;
  readonly description: string;
  readonly options: Readonly<Record<string, OpOption>>;
  /** Help lists `-V, --version`. */
  readonly version: boolean;
  /** Options after a subcommand's name belong to the subcommand, and the root's `-V` is not read. */
  readonly positionalOptions: boolean;
  /** Every word after the op's name reaches `run` unparsed: no help, version, option or arity handling. */
  readonly passThrough: boolean;
  readonly commands: readonly Op[];
  run?(input: OpInput<Readonly<Record<string, unknown>>, readonly (string | undefined)[]>): unknown;
}

export function defineOp<const O extends Record<string, OpOption> = {}, const A extends string = ''>(definition: {
  name: string;
  arguments?: A;
  argumentDescriptions?: Readonly<Record<string, string>>;
  description: string;
  options?: O;
  version?: boolean;
  positionalOptions?: boolean;
  passThrough?: boolean;
  commands?: readonly Op[];
  run?(input: OpInput<OptionValues<O>, ArgValues<A>>): unknown;
}): Op {
  return {
    arguments: '',
    argumentDescriptions: {},
    options: {},
    version: false,
    positionalOptions: false,
    passThrough: false,
    commands: [],
    ...definition,
  };
}

/** A command line the op does not accept, worded as commander words it. */
export class CliUsageError extends Error {
  readonly code = 'STIM_BAD_ARG';
}

export interface CliContext {
  readonly version: string;
  /** Runs after the command line parsed and before the op runs, with the command path. */
  readonly before?: (path: string[]) => unknown;
  /** `stim help <op>`: a passThrough op prints its help instead of running. */
  readonly help?: boolean;
  /** The op is the program itself: its name heads usage and is left out of `before`'s path. */
  readonly root?: boolean;
}

const HELP = { flags: '-h, --help', description: 'display help for command' };
const VERSION = { flags: '-V, --version', description: 'output the version number' };
const ROOT_FLAGS = ['--version', '--help'];

interface Spec {
  readonly key: string;
  readonly option: OpOption;
  readonly long: string;
  readonly takesValue: boolean;
  readonly optionalValue: boolean;
  readonly variadic: boolean;
  readonly repeatable: boolean;
  /** The key a `--no-*` option sets to false. */
  readonly negates?: string;
  /** A `--no-*` option without its positive option: its key starts true. */
  readonly lone: boolean;
}

function specs(op: Op): Spec[] {
  const entries = Object.entries(op.options);
  return entries.map(([key, option]) => {
    const [long = '', value = ''] = option.flags.split(' ');
    let negates: string | undefined;
    let lone = false;
    if (long.startsWith('--no-')) {
      negates = entries.find(([, other]) => other.flags.split(' ')[0] === `--${long.slice(5)}`)?.[0];
      lone = negates === undefined;
      negates ??= key;
    }
    return {
      key,
      option,
      long,
      takesValue: value.startsWith('<'),
      optionalValue: value.startsWith('['),
      variadic: value.endsWith('...>'),
      repeatable: option.repeatable === true,
      negates,
      lone,
    };
  });
}

function maybeOption(arg: string): boolean {
  return arg.length > 1 && arg.startsWith('-');
}

function isNegativeNumber(arg: string): boolean {
  return /^-(\d+|\d*\.\d+)(e[+-]?\d+)?$/.test(arg);
}

interface Scan {
  readonly options: Record<string, unknown>;
  readonly operands: string[];
  readonly leading?: number;
  readonly help: boolean;
  readonly unknown?: string;
  readonly taken: ReadonlySet<number>;
}

function scan(op: Op, args: string[]): Scan {
  const known = specs(op);
  const byName = new Map(known.map((spec) => [spec.long.slice(2), spec]));
  const { tokens } = parseArgs({
    args,
    options: Object.fromEntries([
      ['help', { type: 'boolean', short: 'h' }],
      ...known.map((spec) => [spec.long.slice(2), { type: spec.takesValue ? 'string' : 'boolean' }]),
    ]),
    strict: false,
    allowPositionals: true,
    tokens: true,
  });
  const options: Record<string, unknown> = Object.fromEntries(
    known.flatMap((spec): [string, unknown][] => {
      if (spec.lone) return [[spec.key, true]];
      if (spec.repeatable) return [[spec.key, []]];
      return spec.option.default === undefined ? [] : [[spec.key, spec.option.default]];
    }),
  );
  const operands: string[] = [];
  let leading: number | undefined;
  let help = false;
  let unknown: string | undefined;
  let variadic: { spec: Spec; next: number } | undefined;
  let seen = -1;
  let consumed = -1;
  const taken = new Set<number>();
  for (const token of tokens) {
    if (token.index === consumed) continue;
    if (token.kind === 'option-terminator') {
      variadic = undefined;
      continue;
    }
    if (token.kind === 'positional') {
      if (variadic?.next === token.index) {
        taken.add(token.index);
        options[variadic.spec.key] = [...[options[variadic.spec.key] ?? []].flat(), token.value];
        variadic.next += 1;
        continue;
      }
      variadic = undefined;
      if (leading === undefined && !help && unknown === undefined && operands.length === 0) leading = token.index;
      operands.push(token.value);
      continue;
    }
    variadic = undefined;
    if (token.index === seen) continue;
    seen = token.index;
    const raw = args[token.index] ?? '';
    const spec = byName.get(token.name);
    const single =
      raw === token.rawName ||
      ((spec?.takesValue === true || spec?.optionalValue === true) && token.inlineValue === true);
    if (op.commands.length === 0 && isNegativeNumber(raw)) {
      if (leading === undefined && !help && unknown === undefined && operands.length === 0) leading = token.index;
      operands.push(raw);
    } else if (token.name === 'help' && single && !token.inlineValue) {
      help = true;
    } else if (spec && single) {
      taken.add(token.index);
      if (spec.negates !== undefined) {
        options[spec.negates] = false;
        continue;
      }
      if (spec.optionalValue) {
        const next = args[token.index + 1];
        if (token.inlineValue) options[spec.key] = token.value;
        else if (next !== undefined && (!maybeOption(next) || isNegativeNumber(next))) {
          consumed = token.index + 1;
          taken.add(consumed);
          options[spec.key] = next;
        } else options[spec.key] = true;
        continue;
      }
      if (!spec.takesValue) {
        options[spec.key] = true;
        continue;
      }
      if (token.value === undefined) throw new CliUsageError(`error: option '${spec.option.flags}' argument missing`);
      if (!token.inlineValue) taken.add(token.index + 1);
      let value: unknown = token.value;
      if (spec.option.parse) {
        try {
          value = spec.option.parse(token.value);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new CliUsageError(
            `error: option '${spec.option.flags}' argument '${token.value}' is invalid. ${detail}`,
          );
        }
      }
      if (spec.repeatable) options[spec.key] = [...[options[spec.key] ?? []].flat(), value];
      else if (spec.variadic) {
        options[spec.key] = [...[options[spec.key] ?? []].flat(), value];
        if (!token.inlineValue) variadic = { spec, next: token.index + 2 };
      } else options[spec.key] = value;
    } else unknown ??= raw;
  }
  return { options, operands, leading, help, unknown, taken };
}

function end(args: string[]): number {
  const literal = args.indexOf('--');
  return literal < 0 ? args.length : literal;
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return Math.max(a.length, b.length);
  const width = b.length + 1;
  const d: number[] = [];
  const at = (i: number, j: number): number => d[i * width + j] ?? 0;
  for (let i = 0; i <= a.length; i++) d[i * width] = i;
  for (let j = 0; j <= b.length; j++) d[j] = j;
  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      let value = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        value = Math.min(value, at(i - 2, j - 2) + 1);
      d[i * width + j] = value;
    }
  }
  return at(a.length, b.length);
}

/** Commander's `suggestSimilar`, so the suggestions read the same. */
function suggestSimilar(word: string, candidates: string[]): string {
  const options = word.startsWith('--');
  const target = options ? word.slice(2) : word;
  let similar: string[] = [];
  let best = 3;
  for (const each of new Set(candidates)) {
    const candidate = options ? each.slice(2) : each;
    if (candidate.length <= 1) continue;
    const distance = editDistance(target, candidate);
    const length = Math.max(target.length, candidate.length);
    if ((length - distance) / length <= 0.4) continue;
    if (distance < best) {
      best = distance;
      similar = [candidate];
    } else if (distance === best) similar.push(candidate);
  }
  const named = similar.toSorted((a, b) => a.localeCompare(b)).map((each) => (options ? `--${each}` : each));
  if (named.length > 1) return `\n(Did you mean one of ${named.join(', ')}?)`;
  return named.length === 1 ? `\n(Did you mean ${named[0]}?)` : '';
}

function longFlags(op: Op): string[] {
  return [...specs(op).flatMap((spec) => (spec.option.hidden ? [] : [spec.long])), '--help'];
}

function unknownOption(path: Op[], op: Op, flag: string): CliUsageError {
  let suggestion = '';
  if (flag.startsWith('--')) {
    const candidates: string[] = [];
    let at = path.length - 1;
    do candidates.push(...longFlags(path[at] ?? op));
    while (--at >= 0 && !path[at]?.positionalOptions);
    if (at < 0 && !path[0]?.positionalOptions) candidates.push(...ROOT_FLAGS);
    suggestion = suggestSimilar(flag, candidates);
  }
  return new CliUsageError(`error: unknown option '${flag}'${suggestion}`);
}

function boxWrap(text: string, width: number): string {
  if (width < 40) return text;
  return text
    .split(/\r\n|\n/)
    .flatMap((line) => {
      const chunks = line.match(/\s*\S+/g);
      if (!chunks) return [''];
      const lines: string[] = [];
      let current = chunks[0] ?? '';
      for (const chunk of chunks.slice(1)) {
        if (current.length + chunk.length <= width) current += chunk;
        else {
          lines.push(current);
          current = chunk.trimStart();
        }
      }
      lines.push(current);
      return lines;
    })
    .join('\n');
}

function described(option: OpOption): string {
  if (option.repeatable) return `${option.description} (default: [])`;
  return option.default === undefined
    ? option.description
    : `${option.description} (default: ${JSON.stringify(option.default)})`;
}

function helpText(usage: string[], op: Op, width: number): string {
  const items = (heading: string, rows: [string, string][]): string[] =>
    rows.length ? [heading, ...rows.map(([term, description]) => item(term, description)), ''] : [];
  const listed = Object.values(op.options).filter((each) => !each.hidden);
  const options: [string, string][] = (op.passThrough ? [] : [...(op.version ? [VERSION] : []), ...listed, HELP]).map(
    (each) => [each.flags, described(each)],
  );
  const commands: [string, string][] = op.commands.map((sub) => [
    [
      sub.name,
      ...(Object.keys(sub.options).length ? ['[options]'] : []),
      ...(sub.arguments ? [sub.arguments] : []),
    ].join(' '),
    sub.description,
  ]);
  if (op.commands.length > 0 && !op.run) commands.push(['help [command]', HELP.description]);
  const declared = op.arguments ? op.arguments.split(' ').map((arg) => arg.slice(1, -1)) : [];
  const args: [string, string][] = Object.keys(op.argumentDescriptions).length
    ? declared.map((name) => [name, op.argumentDescriptions[name] ?? ''])
    : [];
  const pad = Math.max(...[...args, ...options, ...commands].map(([term]) => term.length));
  const item = (term: string, description: string): string => {
    if (!description) return `  ${term}`;
    const remaining = width - pad - 4;
    const text =
      remaining < 40 || /\n[^\S\r\n]/.test(description)
        ? description
        : boxWrap(description, remaining).replace(/\n/g, `\n${' '.repeat(pad + 2)}`);
    return `  ${term.padEnd(pad)}  ${text.replace(/\n/g, '\n  ')}`;
  };
  const shape = [
    ...(op.passThrough ? [] : ['[options]']),
    ...(op.commands.length ? ['[command]'] : []),
    ...(op.arguments ? [op.arguments] : []),
  ];
  return [
    `Usage: ${[...usage, ...shape].join(' ')}`,
    '',
    ...(op.description ? [boxWrap(op.description, width), ''] : []),
    ...items('Arguments:', args),
    ...items('Options:', options),
    ...items('Commands:', commands),
  ].join('\n');
}

function helpWidth(stream: NodeJS.WriteStream): number {
  return (stream.isTTY ? stream.columns : undefined) ?? 80;
}

function usageNames(path: Op[], root: boolean | undefined): string[] {
  return [...(root ? [] : ['stim']), ...path.map((each) => each.name)];
}

function showHelp(usage: string[], op: Op, error: boolean): number {
  const stream = error ? process.stderr : process.stdout;
  stream.write(helpText(usage, op, helpWidth(stream)));
  return error ? 1 : 0;
}

function checkArity(op: Op, operands: string[], program: boolean): void {
  const declared = op.arguments ? op.arguments.split(' ') : [];
  declared.forEach((arg, index) => {
    if (arg.startsWith('<') && operands[index] === undefined)
      throw new CliUsageError(`error: missing required argument '${arg.slice(1, -1)}'`);
  });
  if (operands.length > declared.length) {
    const s = declared.length === 1 ? '' : 's';
    const name = program ? '' : ` for '${op.name}'`;
    throw new CliUsageError(
      `error: too many arguments${name}. Expected ${declared.length} argument${s} but got ${operands.length}: ${operands.join(', ')}.`,
    );
  }
}

/**
 * Parses `args` (the words after `stim <op>`) as commander parsed them for the same declaration and runs the op it
 * names. Help prints on stdout, or on stderr with exit code 1 when a group is named without a subcommand; a command
 * line the op does not accept throws {@link CliUsageError}. Resolves to the exit code.
 */
export async function runCli(op: Op, args: string[], context: CliContext): Promise<number> {
  const help = (path: Op[], current: Op, error: boolean) => showHelp(usageNames(path, context.root), current, error);
  if (op.passThrough) {
    if (context.help) return help([op], op, false);
    await context.before?.([op.name]);
    await op.run?.({ args, options: {}, parent: {}, version: context.version });
    return 0;
  }
  if (!op.positionalOptions && args.slice(0, end(args)).some((arg) => arg === '--version' || arg.startsWith('-V'))) {
    process.stdout.write(`${context.version}\n`);
    return 0;
  }
  const path = [op];
  let current = op;
  let parent: Record<string, unknown> = {};
  let rest = args;
  for (;;) {
    const parsed = scan(current, rest);
    const word = parsed.leading === undefined ? undefined : rest[parsed.leading];
    if (current === op && op.positionalOptions && op.version) {
      const own = rest.slice(0, parsed.leading ?? end(rest));
      if (own.some((arg) => arg === '--version' || arg === '-V')) {
        process.stdout.write(`${context.version}\n`);
        return 0;
      }
    }
    const sub = current.commands.find((each) => each.name === word);
    if (sub?.passThrough && parsed.leading !== undefined)
      return runCli(sub, rest.slice(parsed.leading + 1), { ...context, root: false });
    if (sub && parsed.leading !== undefined) {
      const { leading, taken } = parsed;
      parent = current.positionalOptions ? scan(current, rest.slice(0, leading)).options : parsed.options;
      const following = current.positionalOptions
        ? rest.slice(leading + 1)
        : rest.filter((_, index) => index > leading && !taken.has(index));
      rest = end(rest) < leading ? ['--', ...following] : following;
      path.push(sub);
      current = sub;
      continue;
    }
    const group = current.commands.length > 0 && !current.run;
    if (group && word === 'help') {
      const named = parsed.operands[1];
      const target = current.commands.find((each) => each.name === named);
      if (target) return help([...path, target], target, false);
      return help(path, current, named !== undefined);
    }
    if (group && rest.length === 0) return help(path, current, true);
    if (parsed.help) return help(path, current, false);
    for (const spec of specs(current)) {
      if (spec.option.mandatory && parsed.options[spec.key] === undefined)
        throw new CliUsageError(`error: required option '${spec.option.flags}' not specified`);
    }
    if (group && word !== undefined) {
      const names = [...current.commands.map((each) => each.name), 'help'];
      throw new CliUsageError(`error: unknown command '${word}'${suggestSimilar(word, names)}`);
    }
    if (parsed.unknown !== undefined) throw unknownOption(path, current, parsed.unknown);
    if (!current.run) return help(path, current, true);
    checkArity(current, parsed.operands, context.root === true && current === op);
    await context.before?.(path.slice(context.root ? 1 : 0).map((each) => each.name));
    await current.run({ args: parsed.operands, options: parsed.options, parent, version: context.version });
    return 0;
  }
}
