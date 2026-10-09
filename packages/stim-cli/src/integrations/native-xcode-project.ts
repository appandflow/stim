import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { DOMParser, type Element } from '@xmldom/xmldom';
import { parseNativeXcodeSyntax } from './native-xcode-syntax.ts';
import type { XcodeProject } from '../engine/xcode.ts';
import type { ProjectIntegration } from './project-registry.ts';
import { declaresAppDependency, readPackageJson } from '../workspace/project-files.ts';

type PbxObject = Record<string, unknown>;

export interface NativeXcodeModel {
  path: string;
  directory: string;
  objects: Map<string, PbxObject>;
  project: PbxObject;
}

export interface NativeXcodeSelection {
  container: XcodeProject & { path: string; flag: string; dir: string };
  projects: NativeXcodeModel[];
  scheme: string;
  targetId: string;
  targetName: string;
  targetProject: NativeXcodeModel;
  configuration: string;
  settings: Record<string, unknown>;
  schemePath: string | null;
  schemeBuildScripts: boolean;
}

interface NativeScheme {
  name: string;
  path: string | null;
  target: string;
  project: NativeXcodeModel;
  buildScripts: boolean;
}

interface NativeContainer {
  path: string;
  projects: NativeXcodeModel[];
  schemes: NativeScheme[];
}

export class NativeXcodeError extends Error {
  readonly code = 'STIM_BAD_ARG';
  readonly remedy: string;
  constructor(message: string, remedy: string) {
    super(message);
    this.remedy = remedy;
  }
}

export function pbxString(value: unknown): string | null {
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') return null;
  if (!value.startsWith('"')) return value.trim();
  try {
    return JSON.parse(value);
  } catch {
    throw new NativeXcodeError(
      'An Xcode project contains an unreadable quoted value.',
      'Open the project in Xcode and repair its project file.',
    );
  }
}

function object(value: unknown): PbxObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as PbxObject) : null;
}

export function pbxReferences(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const name = pbxString(object(entry)?.value ?? entry);
        return name === null ? [] : [name];
      })
    : [];
}

function readNativeXcodeModel(path: string): NativeXcodeModel {
  const parsed = object(parseNativeXcodeSyntax(readFileSync(join(path, 'project.pbxproj'), 'utf8')));
  const project = object(parsed?.project);
  const objects = new Map<string, PbxObject>();
  const collect = (value: unknown) => {
    for (const [id, entry] of Object.entries(object(value) ?? {})) {
      const record = object(entry);
      if (!record) continue;
      if (typeof record.isa === 'string') objects.set(id, record);
      else collect(record);
    }
  };
  collect(project?.objects);
  const root = objects.get(pbxString(project?.rootObject) ?? '');
  if (!root || root.isa !== 'PBXProject')
    throw new NativeXcodeError(`No Xcode project object in ${path}.`, 'Repair the project in Xcode.');
  return { path: realpathSync(path), directory: realpathSync(dirname(path)), project: root, objects };
}

function xml(path: string): Element {
  const document = new DOMParser({
    onError: (_level, message) => {
      throw new Error(message);
    },
  }).parseFromString(readFileSync(path, 'utf8'), 'application/xml');
  if (document.doctype || !document.documentElement) throw new Error(`Unsupported XML document at ${path}.`);
  return document.documentElement;
}

function workspaceProjects(path: string): string[] {
  const projects: string[] = [];
  const walk = (node: Element, base: string) => {
    const location = node.getAttribute('location');
    let here = base;
    if (location) {
      const colon = location.indexOf(':');
      const kind = location.slice(0, colon);
      const value = location.slice(colon + 1);
      if (kind === 'group') here = resolve(base, value);
      else if (kind === 'container' || kind === 'self') here = resolve(dirname(path), value);
      else if (kind === 'absolute' && isAbsolute(value)) here = value;
      else throw new Error(`Unsupported workspace reference ${location}.`);
    }
    if (node.tagName === 'FileRef') {
      if (!here.endsWith('.xcodeproj')) throw new Error(`Workspace reference ${here} is not an Xcode project.`);
      projects.push(here);
    }
    for (let i = 0; i < node.childNodes.length; i++) {
      const child = node.childNodes.item(i);
      if (child?.nodeType === 1) walk(child as Element, here);
    }
  };
  walk(xml(join(path, 'contents.xcworkspacedata')), dirname(path));
  return [...new Set(projects)];
}

function configurations(project: NativeXcodeModel, owner: PbxObject): PbxObject[] {
  const list = project.objects.get(pbxString(owner.buildConfigurationList) ?? '');
  return pbxReferences(list?.buildConfigurations).flatMap((id) => {
    const configuration = project.objects.get(id);
    return configuration ? [configuration] : [];
  });
}

function buildSettings(project: NativeXcodeModel, target: PbxObject, configuration: string): Record<string, unknown> {
  const settings = (owner: PbxObject) =>
    object(configurations(project, owner).find((config) => pbxString(config.name) === configuration)?.buildSettings) ??
    {};
  return { ...settings(project.project), ...settings(target) };
}

function applicationTargets(project: NativeXcodeModel): [string, PbxObject][] {
  return [...project.objects].filter(
    ([, target]) =>
      target.isa === 'PBXNativeTarget' &&
      pbxString(target.productType) === 'com.apple.product-type.application' &&
      configurations(project, target).some((config) => {
        const settings = buildSettings(project, target, pbxString(config.name) ?? '');
        return (
          /iphone(os|simulator)/.test(pbxString(settings.SDKROOT) ?? '') ||
          /iphone(os|simulator)/.test(pbxString(settings.SUPPORTED_PLATFORMS) ?? '') ||
          settings.IPHONEOS_DEPLOYMENT_TARGET !== undefined
        );
      }),
  );
}

function sharedSchemes(container: string, projects: NativeXcodeModel[]): NativeScheme[] {
  const schemes: NativeScheme[] = [];
  for (const owner of new Set([container, ...projects.map((project) => project.path)])) {
    const directory = join(owner, 'xcshareddata', 'xcschemes');
    if (!existsSync(directory)) continue;
    for (const file of readdirSync(directory)
      .filter((name) => name.endsWith('.xcscheme'))
      .toSorted()) {
      const path = join(directory, file);
      const scheme = xml(path);
      const launch = scheme.getElementsByTagName('LaunchAction').item(0);
      const runnable = launch?.getElementsByTagName('BuildableProductRunnable').item(0);
      const reference = runnable?.getElementsByTagName('BuildableReference').item(0);
      if (!reference) continue;
      const target = reference.getAttribute('BlueprintIdentifier');
      const location = reference.getAttribute('ReferencedContainer');
      if (!target || !location?.startsWith('container:')) continue;
      const referenced = realpathSync(resolve(dirname(owner), location.slice('container:'.length)));
      const project = projects.find((candidate) => candidate.path === referenced);
      if (!project || !applicationTargets(project).some(([id]) => id === target)) continue;
      schemes.push({
        name: basename(file, '.xcscheme'),
        path,
        project,
        target,
        buildScripts: scheme.getElementsByTagName('ExecutionAction').length > 0,
      });
    }
  }
  for (const project of projects)
    for (const [target, value] of applicationTargets(project)) {
      const name = pbxString(value.name);
      if (name && !schemes.some((scheme) => scheme.project === project && scheme.target === target))
        schemes.push({ name, path: null, project, target, buildScripts: false });
    }
  return schemes;
}

function containers(root: string): NativeContainer[] {
  const entries = readdirSync(root).toSorted();
  const workspaces = entries.filter((name) => name.endsWith('.xcworkspace'));
  const projects = entries.filter((name) => name.endsWith('.xcodeproj'));
  const result: NativeContainer[] = [];
  const claimed = new Set<string>();
  for (const file of workspaces) {
    const path = join(root, file);
    const models = workspaceProjects(path).flatMap((project) => {
      if (!existsSync(project) && existsSync(join(root, 'Podfile')) && project === join(root, 'Pods', 'Pods.xcodeproj'))
        return [];
      return [readNativeXcodeModel(project)];
    });
    for (const model of models) claimed.add(model.path);
    result.push({ path, projects: models, schemes: sharedSchemes(path, models) });
  }
  for (const file of projects) {
    const path = join(root, file);
    if (claimed.has(realpathSync(path))) continue;
    const model = readNativeXcodeModel(path);
    result.push({ path, projects: [model], schemes: sharedSchemes(path, [model]) });
  }
  return result;
}

export function selectNativeXcodeProject(root: string, scheme?: string, configuration = 'Debug'): NativeXcodeSelection {
  let available: NativeContainer[];
  try {
    available = containers(root);
  } catch (error) {
    if (error instanceof NativeXcodeError) throw error;
    throw new NativeXcodeError(
      `Could not read native Xcode project: ${(error as Error).message}`,
      'Repair the project/workspace and its referenced files in Xcode, then retry.',
    );
  }
  const choices = available.flatMap((container) => container.schemes.map((candidate) => ({ container, candidate })));
  const matching = scheme === undefined ? choices : choices.filter(({ candidate }) => candidate.name === scheme);
  if (matching.length !== 1)
    throw new NativeXcodeError(
      matching.length
        ? `Native Xcode application selection is ambiguous${scheme ? ` for scheme ${JSON.stringify(scheme)}` : ''}.`
        : `No runnable native iOS application${scheme ? ` with scheme ${JSON.stringify(scheme)}` : ''} was found.`,
      choices.length
        ? `Select one shared application scheme with --scheme. Candidates: ${choices.map(({ container, candidate }) => `${relative(root, container.path)}: ${candidate.name}`).join(', ')}. Duplicate container/scheme names must be made unambiguous in Xcode.`
        : 'Open the intended project in Xcode and add a shared scheme whose Run action selects an iOS application.',
    );
  const { container, candidate } = matching[0]!;
  const target = candidate.project.objects.get(candidate.target)!;
  const names = configurations(candidate.project, target).map((config) => pbxString(config.name));
  if (!names.includes(configuration))
    throw new NativeXcodeError(
      `Configuration ${JSON.stringify(configuration)} does not exist for ${candidate.name}.`,
      `Select --configuration or ios.configuration from: ${names.join(', ')}.`,
    );
  const workspace = container.path.endsWith('.xcworkspace');
  return {
    container: {
      path: container.path,
      dir: dirname(container.path),
      kind: workspace ? 'workspace' : 'project',
      flag: workspace ? '-workspace' : '-project',
      name: basename(container.path, workspace ? '.xcworkspace' : '.xcodeproj'),
    },
    projects: container.projects,
    scheme: candidate.name,
    targetId: candidate.target,
    targetName: pbxString(target.name)!,
    targetProject: candidate.project,
    configuration,
    settings: buildSettings(candidate.project, target, configuration),
    schemePath: candidate.path,
    schemeBuildScripts: candidate.buildScripts,
  };
}

export const nativeXcodeProjectIntegration: ProjectIntegration = {
  id: 'native-xcode',
  inspect(root) {
    if (declaresAppDependency(readPackageJson(root))) return null;
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      return null;
    }
    if (
      !entries.some(
        (entry) =>
          (entry.endsWith('.xcodeproj') || entry.endsWith('.xcworkspace')) &&
          statSync(join(root, entry), { throwIfNoEntry: false })?.isDirectory(),
      )
    )
      return null;
    let problem: { kind: 'not-an-app' | 'unreadable'; message: string; remedy: string } | null = null;
    try {
      if (!containers(root).some((container) => container.schemes.length))
        problem = {
          kind: 'not-an-app',
          message: 'This Xcode container has no runnable iOS application.',
          remedy: 'Use an iOS application target and shared Run scheme.',
        };
    } catch (error) {
      problem = {
        kind: 'unreadable',
        message: `Could not read Xcode project inputs: ${(error as Error).message}`,
        remedy: 'Repair the project/workspace and its references in Xcode.',
      };
    }
    return {
      root: 'candidate',
      application: problem === null,
      platforms: () => (problem ? [] : ['ios']),
      validate: (operation) => (operation === 'ios' ? problem : undefined),
      ios: async () => (await import('./native-xcode-ios.ts')).nativeXcodeIosProject(root),
      doctor: async () => (await import('./native-xcode-ios.ts')).nativeXcodeDoctor(root),
    };
  },
};
