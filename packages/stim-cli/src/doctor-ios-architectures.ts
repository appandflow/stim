import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Finding } from './doctor.ts';
import { getExecutor } from './exec.ts';

interface ArchitectureTarget {
  target: string;
  architectures: string[];
}

interface ArchitectureReport {
  affected: ArchitectureTarget[];
  unknown: boolean;
}

const COMPILED_PRODUCTS = new Set([
  'com.apple.product-type.application',
  'com.apple.product-type.application.on-demand-install-capable',
  'com.apple.product-type.app-extension',
  'com.apple.product-type.framework',
  'com.apple.product-type.library.static',
  'com.apple.product-type.library.dynamic',
]);

function architectureList(value: unknown): string[] | null {
  if (typeof value !== 'string' || /[^\w\s-]/.test(value)) return null;
  return [...new Set(value.split(/\s+/).filter(Boolean))];
}

export function parseIosDebugArchitectures(output: string): ArchitectureReport {
  const report: ArchitectureReport = { affected: [], unknown: false };
  let data: unknown;
  try {
    data = JSON.parse(output);
  } catch {
    return { ...report, unknown: true };
  }
  if (!Array.isArray(data) || data.length === 0) return { ...report, unknown: true };
  let inspected = false;
  for (const entry of data) {
    if (!entry || typeof entry !== 'object' || entry.error || !entry.buildSettings) {
      report.unknown = true;
      continue;
    }
    const settings = entry.buildSettings;
    if (settings.CONFIGURATION !== 'Debug' || settings.PLATFORM_NAME !== 'iphonesimulator') {
      report.unknown = true;
      continue;
    }
    if (!settings.PRODUCT_TYPE) continue;
    if (settings.PRODUCT_TYPE === 'com.apple.product-type.bundle') {
      inspected = true;
      continue;
    }
    if (!COMPILED_PRODUCTS.has(settings.PRODUCT_TYPE)) {
      report.unknown = true;
      continue;
    }
    inspected = true;
    if (settings.ONLY_ACTIVE_ARCH === 'YES') continue;
    const archs = architectureList(settings.ARCHS);
    const valid = settings.VALID_ARCHS === undefined ? archs : architectureList(settings.VALID_ARCHS);
    const excluded = architectureList(settings.EXCLUDED_ARCHS ?? '');
    if (
      settings.ONLY_ACTIVE_ARCH !== 'NO' ||
      !archs?.length ||
      !valid ||
      !excluded ||
      typeof entry.target !== 'string'
    ) {
      report.unknown = true;
      continue;
    }
    const architectures = archs.filter((arch) => valid.includes(arch) && !excluded.includes(arch));
    if (architectures.length > 1) report.affected.push({ target: entry.target, architectures });
  }
  return { ...report, unknown: report.unknown || !inspected };
}

export function inspectIosDebugArchitectures(projectRoot: string): Finding[] {
  const iosRoot = join(projectRoot, 'ios');
  if (!existsSync(iosRoot)) return [];
  const findings: Finding[] = [];
  const unknown: string[] = [];
  let projects: string[];
  try {
    projects = readdirSync(iosRoot)
      .filter((name) => name.endsWith('.xcodeproj'))
      .toSorted()
      .map((name) => join(iosRoot, name));
  } catch {
    projects = [];
  }
  if (!projects.length) unknown.push('app project');
  const pods = join(iosRoot, 'Pods', 'Pods.xcodeproj');
  if (existsSync(pods)) projects.push(pods);
  else if (existsSync(join(iosRoot, 'Podfile'))) unknown.push('Pods project (not generated)');
  const deadline = Date.now() + 60_000;
  for (const project of projects) {
    const label = relative(projectRoot, project);
    const timeoutMs = Math.min(30_000, deadline - Date.now());
    if (timeoutMs <= 0) {
      unknown.push(label);
      continue;
    }
    try {
      const output = getExecutor().runFile(
        'xcodebuild',
        [
          '-project',
          project,
          '-alltargets',
          '-configuration',
          'Debug',
          '-sdk',
          'iphonesimulator',
          '-showBuildSettings',
          '-json',
          '-disableAutomaticPackageResolution',
          '-skipPackageUpdates',
        ],
        { cwd: iosRoot, timeoutMs },
      );
      const report = parseIosDebugArchitectures(output);
      if (report.unknown) unknown.push(label);
      if (report.affected.length) {
        const targets = report.affected
          .slice(0, 5)
          .map(({ target, architectures }) => `${target} (${architectures.join(', ')})`)
          .join('; ');
        findings.push({
          code: 'ios-debug-architectures',
          level: 'cost',
          title: 'iOS Debug targets build multiple simulator architectures',
          detail: `${label}: ${report.affected.length} Debug target(s) resolve ONLY_ACTIVE_ARCH=NO with multiple architectures after exclusions: ${targets}${report.affected.length > 5 ? `; plus ${report.affected.length - 5} more` : ''}. This can compile extra native code when targeting one simulator.`,
          fix: 'Review the Debug ONLY_ACTIVE_ARCH override in the project, xcconfig, or Podfile post_install helpers. Prefer YES for local Debug simulator builds where appropriate; preserve intentional Release and distribution settings. Regenerate Pods through the project workflow after changing a helper, then rerun stim doctor --platform ios. Doctor --fix does not change architecture settings.',
        });
      }
    } catch {
      unknown.push(label);
    }
  }
  if (unknown.length)
    findings.push({
      code: 'ios-debug-architectures-unknown',
      level: 'note',
      title: 'iOS Debug architecture settings could not be fully inspected',
      detail: `Effective Debug simulator settings are unavailable for ${unknown.join(', ')}. Architecture policy is not verified for those targets. Metadata inspection has a 60-second total budget.`,
      fix: 'Ensure Xcode can read the generated app and Pods projects, then rerun stim doctor --platform ios. Doctor does not evaluate Podfiles or install Pods to inspect architecture settings.',
    });
  return findings;
}
