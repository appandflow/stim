export interface AboutApp {
  version: string;
  build: string | null;
  platform: string;
  runtimeVersion: string | null;
  channel: string | null;
  updateId: string | null;
  updatedAt: Date | null;
  embedded: boolean;
  protocol: number;
}

export interface AboutMachine {
  name: string;
  detail: { stim: string; server: string; protocol: number } | { state: string };
}

export interface AboutDevice {
  os: string;
  osVersion: string;
  model: string | null;
  locale: string;
}

export function versionWithBuild({ version, build }: Pick<AboutApp, 'version' | 'build'>): string {
  return build ? `${version} (${build})` : version;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

function updateText(app: AboutApp): string {
  if (app.embedded || !app.updateId) return 'built-in';
  return `${app.updateId}${app.updatedAt ? ` (published ${app.updatedAt.toISOString()})` : ''}`;
}

function machineText(label: string, detail: AboutMachine['detail']): string {
  return 'stim' in detail
    ? `${label}: stim ${detail.stim}, server ${detail.server}, protocol ${detail.protocol}`
    : `${label}: ${detail.state}`;
}

/** Every version the sheet shows, as plain text for a bug report. Not translated, so a report reads the same anywhere. */
export function diagnosticText(app: AboutApp, machines: AboutMachine[]): string {
  return [
    `Stim for phones ${versionWithBuild(app)} (${app.platform})`,
    `Runtime version: ${app.runtimeVersion ?? 'none'}`,
    `Channel: ${app.channel || 'none'}`,
    `Update: ${updateText(app)}`,
    `Protocol: ${app.protocol}`,
    ...machines.map(({ name, detail }) => machineText(name, detail)),
  ].join('\n');
}

const NEW_ISSUE = 'https://github.com/appandflow/stim/issues/new';
const MAX_URL_LENGTH = 7000;

function reportUrl(evidence: string[]): string {
  const body = ['## Problem', '', '', '## Evidence', '', ...evidence, '', '## Cause', '', '', '## Fix idea', ''].join(
    '\n',
  );
  return `${NEW_ISSUE}?template=report.md&title=${encodeURIComponent('mobile: ')}&body=${encodeURIComponent(body)}`;
}

/**
 * A GitHub new-issue URL with the report template's headings and the phone's versions under Evidence. Machines are
 * numbered, never named, so no host, Tailscale name, path or workspace reaches GitHub. Machines beyond what keeps the
 * URL under `MAX_URL_LENGTH` are counted, not listed.
 */
export function bugReportUrl(app: AboutApp, machines: AboutMachine[], device: AboutDevice): string {
  const head = [
    `- App: Stim for phones ${versionWithBuild(app)} (${app.platform})`,
    `- Update: ${updateText(app)}`,
    `- Channel: ${app.channel || 'none'}`,
    `- Runtime version: ${app.runtimeVersion ?? 'none'}`,
    `- Protocol: ${app.protocol}`,
    `- OS: ${device.os === 'ios' ? 'iOS' : 'Android'} ${device.osVersion}`,
    `- Device: ${device.model ?? 'unknown'}`,
    `- Locale: ${device.locale}`,
  ];
  const lines = machines.map(({ detail }, index) => `- ${machineText(`Machine ${index + 1}`, detail)}`);
  let shown = lines.length;
  const evidence = () => [
    ...head,
    ...lines.slice(0, shown),
    ...(shown < lines.length ? [`- ${lines.length - shown} more machines`] : []),
  ];
  while (shown > 0 && reportUrl(evidence()).length > MAX_URL_LENGTH) shown -= 1;
  return reportUrl(evidence());
}
