import { OPTIMIZATION_SHAPES } from '../optimizations.ts';
import assert from 'node:assert';
import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_FINGERPRINT_IGNORES } from '../build-cache.ts';
import { OUTPUT_LABELS } from '../command-output.ts';
import { CLAIM_REFUSED, CLAIM_UNAVAILABLE } from '../ownership-claim.ts';
import TOPICS from '../guide/index.ts';
import {
  topicNames,
  renderTopic,
  renderIndex,
  renderSection,
  renderSectionIndex,
  sectionLookup,
  sectionNames,
} from '../commands/guide.ts';

function allBodies(): string[] {
  const bodies: string[] = [];
  for (const name of topicNames()) {
    const topic = renderTopic(name);
    assert(topic);
    bodies.push(topic);
    for (const section of sectionNames(name)) {
      const body = renderSection(name, section);
      assert(body);
      bodies.push(body);
    }
  }
  return bodies;
}

const NOT_A_REFUSAL_CODE = new Set(['STIM_HOME', 'STIM_ANDROID_CAS_TOOLCHAIN']);

function scrapedCodes(source: string): Set<string> {
  return new Set(
    [...source.matchAll(/STIM_[A-Z_]+/g)].map((m) => m[0]).filter((code) => !NOT_A_REFUSAL_CODE.has(code)),
  );
}

const SUMMARY_ONLY_LABELS = ['app', 'compilation cache'];

test('every advertised topic renders non-empty content', () => {
  for (const name of topicNames()) {
    const body = renderTopic(name);
    const topic = TOPICS[name];
    assert(topic);
    const content = topic.body?.() ?? topic.preamble?.();
    assert(content?.trim());
    expect(body).toContain(content);
  }
});

test('every section of every sectioned topic renders its own content', () => {
  const sectioned = topicNames().filter((name) => sectionNames(name).length > 0);
  expect(sectioned.length).toBeGreaterThan(0);
  for (const name of sectioned) {
    for (const section of sectionNames(name)) {
      const body = renderSection(name, section);
      const content = TOPICS[name]?.sections?.[section]?.body();
      assert(content?.trim());
      expect(body).toContain(content);
    }
  }
});

test('the dev-menu section reads at the left margin, not in the payload table column', () => {
  const facts = renderSection('facts', 'devmenu');
  assert(facts);
  const indents = facts
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => line.length - line.trimStart().length);
  expect(Math.max(...indents)).toBeLessThanOrEqual(2);
});

test('an alias resolves to the same body as the section it spells', () => {
  for (const name of topicNames()) {
    const lookup = sectionLookup(name);
    for (const section of sectionNames(name)) {
      for (const alias of lookup[section]?.aliases ?? []) {
        expect(renderSection(name, alias)).toBe(renderSection(name, section));
      }
    }
  }
});

test('section and alias names are unique within a topic', () => {
  for (const name of topicNames()) {
    const spellings: string[] = [];
    for (const section of sectionNames(name)) {
      spellings.push(section);
      for (const alias of sectionLookup(name)[section]?.aliases ?? []) spellings.push(alias);
    }
    expect(new Set(spellings).size).toBe(spellings.length);
    expect(Object.keys(sectionLookup(name)).toSorted()).toEqual(spellings.toSorted());
  }
});

test('a section name that no topic declares renders nothing', () => {
  expect(renderSection('errors', 'stim_no_metro')).toBe(null);
  expect(renderSection('errors', 'nope')).toBe(null);
  expect(renderSection('logs', 'phone')).toBe(null);
});

test('a sectioned topic prints its preamble and an index of every section', () => {
  for (const name of topicNames().filter((topic) => sectionNames(topic).length > 0)) {
    const body = renderTopic(name);
    assert(body);
    expect(body).toContain('SECTIONS');
    for (const section of sectionNames(name)) {
      expect(body).toContain(section);
      for (const alias of sectionLookup(name)[section]?.aliases ?? []) expect(body).toContain(alias);
    }
    expect(body).toMatch(new RegExp(`Read one with: {2}stim guide ${name} `));
  }
});

test('an index row carries the word count of the section body it names', () => {
  const index = renderSectionIndex('errors');
  assert(index);
  const body = renderSection('errors', 'STIM_BUILD_WAIT_TIMEOUT');
  assert(body);
  const words = body.slice(body.indexOf('STIM_BUILD_WAIT_TIMEOUT')).trim().split(/\s+/).length;
  expect(index).toMatch(new RegExp(`STIM_BUILD_WAIT_TIMEOUT\\s+${words}w {2}`));
});

test('the errors index keeps the configured group separators and preambles', () => {
  const index = renderTopic('errors');
  const groups = Object.values(TOPICS.errors?.sections ?? {}).filter((section) => section.separator);
  expect(groups.length).toBeGreaterThan(0);
  for (const group of groups) {
    assert(group.separator);
    expect(index).toContain(group.separator);
  }
  for (const group of groups.filter((section) => section.context)) {
    assert(group.context);
    expect(index).toContain(group.context);
  }
});

test('a section renders its group preamble before its body', () => {
  const sections = Object.entries(TOPICS.errors?.sections ?? {}).filter(([, section]) => section.context);
  expect(sections.length).toBeGreaterThan(0);
  for (const [name, section] of sections) {
    const rendered = renderSection('errors', name);
    assert(rendered);
    assert(section.context);
    expect(rendered).toContain(`${section.context}\n\n${section.body()}`);
  }
});

test('the lifecycle topic grids every label the output vocabulary allows, and no others', () => {
  const body = renderSection('lifecycle', 'progress');
  assert(body);
  const start = body.indexOf('The labels are a closed set');
  expect(start).toBeGreaterThan(-1);
  const grid = body.slice(body.indexOf('column:', start) + 'column:'.length, body.indexOf('`app` and', start));
  expect(grid.trim().split(/\s+/).toSorted()).toEqual(
    OUTPUT_LABELS.filter((label) => label !== '' && !SUMMARY_ONLY_LABELS.includes(label)).toSorted(),
  );
});

test('native-build cache fields are documented in the JSON failure contract', () => {
  const body = renderSection('facts', 'payloads');
  assert(body);
  const failure = body.slice(body.indexOf('ON FAILURE'), body.indexOf('RULES'));
  expect(failure).toContain('`ccache`');
  expect(failure).toContain('`compilationCache`');
});

test('an unknown topic renders nothing rather than throwing', () => {
  expect(renderTopic('nope')).toBe(null);
  expect(renderSection('nope', 'anything')).toBe(null);
  expect(renderSectionIndex('nope')).toBe(null);
});

test('an inherited property name is an unknown topic, not a prototype member', () => {
  for (const name of ['constructor', 'toString', '__proto__']) {
    expect(renderTopic(name)).toBe(null);
    expect(renderSection(name, 'anything')).toBe(null);
    expect(renderSectionIndex(name)).toBe(null);
  }
});

test('a whole topic offers no section index and no section body', () => {
  const whole = topicNames().filter((name) => sectionNames(name).length === 0);
  expect(whole.length).toBeGreaterThan(0);
  for (const name of whole) {
    expect(renderSectionIndex(name)).toBe(null);
    expect(renderSection(name, 'phone')).toBe(null);
    expect(Object.keys(sectionLookup(name))).toHaveLength(0);
  }
});

test('the index lists every topic and the running version', () => {
  const idx = renderIndex('9.9.9');
  expect(idx).toMatch(/stim 9\.9\.9/);
  for (const name of topicNames()) expect(idx).toMatch(new RegExp(name));
});

test('the errors topic documents every code the build commands and the iOS signing gate can emit', () => {
  const body = renderTopic('errors');
  assert(body);
  const commandFiles = [
    'ios.ts',
    'android.ts',
    'start.ts',
    'native-runtime.ts',
    'dev-client.ts',
    ...['ios', 'android'].flatMap((command) =>
      readdirSync(new URL(`../commands/${command}/`, import.meta.url))
        .filter((file) => file.endsWith('.ts'))
        .map((file) => `${command}/${file}`),
    ),
  ];
  const sources = [
    ...commandFiles.map((file) => readFileSync(new URL(`../commands/${file}`, import.meta.url), 'utf-8')),
    ...['engine/ios-profile.ts', 'engine/ios-signing.ts', 'engine/eas-build.ts'].map((f) =>
      readFileSync(new URL(`../${f}`, import.meta.url), 'utf-8'),
    ),
  ].join('\n');
  const codes = scrapedCodes(sources);
  expect(codes.size).toBeGreaterThan(0);
  for (const code of codes) {
    expect(body).toContain(code);
    expect(sectionLookup('errors')[code]).toBeDefined();
  }
});

test('current guides require completed warming and leave worktree creation to Git', () => {
  const body = allBodies().join('\n');
  expect(body).toContain('git worktree add');
  expect(body).toContain('stim worktree warm');
  expect(body).toContain('stim worktree warm --refresh');
  expect(body).toContain('stim worktree remove');
  for (const guide of [renderTopic('agent'), renderSection('lifecycle', 'options')]) {
    expect(guide).toContain('Wait for warm to exit successfully (exit code 0)');
    expect(guide).toMatch(/Concurrent\s+writes to the destination are unsafe/);
  }
  expect(body).not.toMatch(/worktree create|--carry-ignored|STIM_WORKTREE_BRANCH_EXISTS/);
  expect(body).not.toMatch(/worktreeDir|worktree\.baseRef|worktree\.include|\.worktreeinclude/);
  expect(sectionLookup('errors')['STIM_WORKTREE_BRANCH_EXISTS']).toBeUndefined();
});

test('the errors topic documents every code the engine can emit under a command', () => {
  const body = renderTopic('errors');
  assert(body);
  const sources = [
    'config.ts',
    'engine/workspace-process-lock.ts',
    'engine/build-slots.ts',
    'engine/device-remote.ts',
    'engine/warm-claim.ts',
    'worktree-refresh.ts',
  ]
    .map((f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf-8'))
    .join('\n');
  const codes = new Set(
    [...sources.matchAll(/(?:code:\s*|\.code\s*=\s*)'(STIM_[A-Z_]+)'/g)].map((m) => m[1] as string),
  );
  expect(codes.size).toBeGreaterThan(0);
  for (const code of codes) {
    expect(body.includes(code)).toBeTruthy();
    expect(sectionLookup('errors')[code]).toBeDefined();
  }
});

test('the errors topic documents both codes the ownership-claim primitive raises', () => {
  const body = renderTopic('errors');
  assert(body);
  for (const code of [CLAIM_REFUSED, CLAIM_UNAVAILABLE]) {
    expect(body).toContain(code);
    expect(sectionLookup('errors')[code]).toBeDefined();
  }
});

test('the rendered guide carries the warm --refresh contract, not just its source', () => {
  const options = renderSection('lifecycle', 'options');
  assert(options);
  expect(options).toMatch(/--refresh.*WRITES TO THE SOURCE CHECKOUT/s);
  expect(options).toContain('never switches branches');
  expect(options).toContain('keyed on the repository root');
  expect(options).toMatch(/worktree warm {4}--refresh/);
  expect(renderTopic('settings')).toContain('worktree.defaultBranch');
  for (const code of ['STIM_MAIN_DIRTY', 'STIM_MAIN_DETACHED', 'STIM_MAIN_DIVERGED']) {
    const section = renderSection('errors', code);
    assert(section);
    expect(section).toContain(code);
    expect(renderTopic('errors')).toContain(code);
  }
  expect(renderSection('errors', 'STIM_LOCK_TIMEOUT')).toContain('warm-locks');
  // The refusal is on the unflagged path, so the plain-warm contract has to name it where a waiter looks.
  expect(options).toContain('STIM_DEPS_INCOMPLETE');
  expect(renderSection('errors', 'STIM_DEPS_INCOMPLETE')).toContain('warm-installs');
  expect(renderSection('errors', 'warm')).toContain('appandflow/stim#696');
  expect(options).toContain('appandflow/stim#696');
});

test('the facts topic documents every reload strategy the command can report', () => {
  const body = renderSection('facts', 'payloads');
  assert(body);
  const src = readFileSync(new URL('../commands/reload.ts', import.meta.url), 'utf-8');
  const union = src.slice(src.indexOf('strategy:'), src.indexOf(';', src.indexOf('strategy:')));
  const values = [...union.matchAll(/'([a-z-]+)'/g)].map((m) => m[1] as string);
  expect(values.length).toBeGreaterThan(0);
  for (const value of values) expect(body).toContain(`"${value}"`);
});

test('the settings topic documents every supported setting key', () => {
  const body = renderTopic('settings');
  assert(body);
  const src = readFileSync(new URL('../settings.ts', import.meta.url), 'utf-8');
  const table = src.slice(src.indexOf('const SETTING_SHAPES'), src.indexOf('};', src.indexOf('const SETTING_SHAPES')));
  const known = [...table.matchAll(/^\s*'?([A-Za-z0-9.]+)'?: '[a-z-]+',$/gm)]
    .map((match) => match[1])
    .filter((key): key is string => key !== undefined);
  expect(known.length).toBeGreaterThan(0);
  for (const key of known) {
    expect(body.includes(key)).toBeTruthy();
  }
});

test('the static skill is only the agent guide router', () => {
  const dir = fileURLToPath(new URL('../../skill/', import.meta.url));
  expect(readdirSync(dir).toSorted()).toEqual(['SKILL.md']);
  const skill = readFileSync(new URL('../../skill/SKILL.md', import.meta.url), 'utf-8');
  const wordCount = skill.split(/\s+/).filter(Boolean).length;
  expect(wordCount).toBeLessThanOrEqual(100);
  expect(skill.match(/stim guide agent/g)).toHaveLength(1);
  expect(skill).toMatch(/Follow the version-matched instructions it prints/);

  for (const mutableDetail of [
    'stim doctor',
    'worktree create',
    'STIM_NO_METRO',
    'gc --delete',
    '--force',
    'registry.npmjs.org',
    '20.19.4',
    'sandbox',
  ]) {
    expect(skill).not.toContain(mutableDetail);
  }
});

test('every guide topic explains the npx fallback for short stim commands', () => {
  for (const body of allBodies()) {
    expect(body).toMatch(/not installed globally[^.]*npx stim`/i);
  }
  expect(renderIndex('9.9.9')).toContain('stim guide <topic>');
  expect(renderIndex('9.9.9')).toMatch(/not installed globally[^.]*npx stim`/i);
});

test('the agent workflow checks errors before and after edits, before cleanup', () => {
  const agent = renderTopic('agent');
  assert(agent);
  const normalWorkflow = agent.match(/NORMAL WORKFLOW([\s\S]*?)RULES DURING THE LOOP/)?.[1];
  assert(normalWorkflow);
  expect(normalWorkflow.match(/stim logs --errors/g)).toHaveLength(2);
  expect(normalWorkflow.lastIndexOf('stim logs --errors')).toBeLessThan(normalWorkflow.lastIndexOf('stim stop'));
  expect(agent).toContain('stim guide lifecycle verification');
  expect(renderSection('lifecycle', 'verification')).toBeTruthy();
  expect(agent).toContain('stim guide lifecycle readiness');
  expect(renderSection('lifecycle', 'readiness')).toContain('[stim:readiness] pending');
  expect(renderSection('lifecycle', 'readiness')).toContain('[stim:readiness] ready');
});

test('the logs guides distinguish an unused workspace from an empty filtered timeline', () => {
  const logs = renderTopic('logs');
  const agent = renderTopic('agent');
  const lifecycle = renderTopic('lifecycle');
  const noProject = renderSection('errors', 'STIM_NO_PROJECT');
  for (const guide of [logs, agent, lifecycle, noProject]) {
    expect(guide).toContain('STIM_NO_PROJECT');
  }
  expect(logs).toContain('nearest registered descendant app');
  expect(logs).toMatch(/zero matches after filtering means STDOUT IS EMPTY,\s+exit code 0/);
  expect(noProject).toContain('nearest registered descendant app');
});

test('the agent and lifecycle guides name both workflows', () => {
  for (const guide of [renderTopic('agent'), renderTopic('lifecycle')]) {
    assert(guide);
    expect(guide).toContain('SINGLE CHECKOUT');
    expect(guide).toContain('WORKTREE:');
    expect(guide).toMatch(/is infrastructure, not a workspace/);
  }
});

test('the agent guide routes situations to valid sections before listing every topic', () => {
  const agent = renderTopic('agent');
  assert(agent);
  const [situations, topicList] = agent.split('FULL TOPIC LIST');
  assert(situations);
  assert(topicList);
  const rows = situations
    .split('\n')
    .filter((line) => line.startsWith('| '))
    .slice(2);
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    const route = /^stim guide ([a-z]+)(?: ([\w<>]+))?$/.exec(row.split('|')[2]?.trim() ?? '');
    assert(route, row);
    const [, topic, section] = route;
    assert(topic);
    expect(
      section ? renderSection(topic, section === '<CODE>' ? 'STIM_NO_METRO' : section) : renderTopic(topic),
    ).toBeTruthy();
  }
  for (const topicName of topicNames().filter((name) => name !== 'agent')) {
    expect(topicList).toContain(`guide ${topicName}`);
  }
  expect(agent).toContain('stim guide errors <CODE>');
  for (const route of [
    'guide errors sandbox',
    'guide facts devmenu',
    'guide cleanup collector',
    'guide lifecycle builds',
    'guide lifecycle concurrency',
  ]) {
    expect(agent).toContain(route);
  }
});

test('the agent guide protects other workspaces device lease files', () => {
  const agent = renderTopic('agent');
  expect(agent).toMatch(/Never delete another\s+workspace's lease file/);
  expect(agent).toMatch(/gc --delete removes expired\s+ones/);
});

test('the agent and cleanup guides shut down owned simulators without an occupancy check', () => {
  const agent = renderTopic('agent');
  const cleanup = renderSection('cleanup', 'gc');
  assert(agent);
  assert(cleanup);

  expect(agent).toMatch(/explicit stop shuts down a Stim-owned simulator even when\s+another process uses it/i);
  expect(agent).toMatch(/never shuts down an unowned simulator/i);
  expect(cleanup).toMatch(/do not check simulator occupancy/i);
  expect(cleanup).toMatch(/never shuts down an unowned simulator/i);
  expect(agent).not.toContain('agent-device close --shutdown');
  expect(renderTopic('cleanup')).toMatch(/exact iOS UDID or live Android\nserial/);
  expect(renderTopic('cleanup')).toContain('Physical devices are outside');
});

test('the guide names every path Stim ignores by default', () => {
  const lifecycle = renderSection('lifecycle', 'builds') ?? '';
  for (const path of DEFAULT_FINGERPRINT_IGNORES) {
    const bare = path.replace(/^\*\*\//, '').replace(/\/\*\*$/, '');
    expect(lifecycle).toContain(bare);
  }
});

test('the package exposes only the stim binary', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'));
  expect(packageJson.bin).toEqual({ stim: 'dist/cli.mjs' });
});

test('the reload payload guide distinguishes dispatch from observed completion', () => {
  expect(renderSection('facts', 'payloads')).toMatch(/reload request was sent[\s\S]*does not observe completion/);
});

test('warm guidance protects existing entries and tracked changes', () => {
  const options = renderSection('lifecycle', 'options');
  assert(options);
  expect(options).toMatch(/existing\s+ignored directory such as node_modules is skipped WHOLE/i);
  expect(options).toMatch(/dangling symlinks/);
  expect(options).toMatch(/does not copy tracked changes/);
});

test('temporary storage guidance names the override and Git visibility boundary', () => {
  const settings = renderTopic('settings');
  expect(settings).toContain('STIM_TMPDIR');
  expect(settings).toContain('tempDir');
  expect(settings).toMatch(/outside Git working trees/);
  expect(renderSection('lifecycle', 'options')).toContain('STIM_TMPDIR');
});

test('build guidance names the experimental Android compiler opt-in', () => {
  expect(renderSection('lifecycle', 'builds')).toContain('STIM_ANDROID_CAS_TOOLCHAIN');
});

test('the settings guide documents every configurable optimization', () => {
  const body = renderTopic('settings');
  for (const key of Object.keys(OPTIMIZATION_SHAPES)) {
    expect(body).toContain(key);
  }
});

test('EAS guidance requires profile clarification when needed and authorization for paid builds', () => {
  const agent = renderTopic('agent');
  expect(agent).toContain('stim guide lifecycle eas');
  const eas = renderSection('lifecycle', 'eas');
  expect(eas).toContain('--eas-profile');
  expect(eas).toMatch(/no\s+compatible profile or the choice is ambiguous, ask the user/);
  expect(eas).toContain('fingerprint:generate uploads fingerprint metadata');
  expect(eas).toMatch(/session authorizes the potentially billable/);
  expect(eas).toContain('STIM_EAS_BUILD_MISSING');
  expect(eas).toContain('STIM_EAS_UNAVAILABLE');
  expect(eas).toContain('npx eas-cli device:create');
  expect(eas).toMatch(/Registration, signing changes and cloud builds need session authorization/);
});

test('slot selection and shared Metro behavior are discoverable in operational guidance', () => {
  expect(renderTopic('agent')).toContain('--slot <name>');
  expect(renderSection('lifecycle', 'options')).toContain('--slot <name>');
  expect(renderTopic('logs')).toContain('--slot <name>');
  expect(renderTopic('cleanup')).toContain('stop --slot <name>');
  expect(renderSection('lifecycle', 'options')).toContain('not a single-slot reload');
});
