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
  detail: { stim: string; server: string } | { state: string };
}

export function versionWithBuild({ version, build }: Pick<AboutApp, 'version' | 'build'>): string {
  return build ? `${version} (${build})` : version;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** Every version the sheet shows, as plain text for a bug report. Not translated, so a report reads the same anywhere. */
export function diagnosticText(app: AboutApp, machines: AboutMachine[]): string {
  const update =
    app.embedded || !app.updateId
      ? 'built-in'
      : `${app.updateId}${app.updatedAt ? ` (published ${app.updatedAt.toISOString()})` : ''}`;
  const lines = [
    `Stim for phones ${versionWithBuild(app)} (${app.platform})`,
    `Runtime version: ${app.runtimeVersion ?? 'none'}`,
    `Channel: ${app.channel || 'none'}`,
    `Update: ${update}`,
    `Protocol: ${app.protocol}`,
  ];
  for (const { name, detail } of machines) {
    lines.push('stim' in detail ? `${name}: stim ${detail.stim}, server ${detail.server}` : `${name}: ${detail.state}`);
  }
  return lines.join('\n');
}
