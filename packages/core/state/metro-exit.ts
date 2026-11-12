import { readJsonObject } from './json-file.ts';
import { metroExitFile } from './paths.ts';

/** How a dev server ended, as its helper recorded it in `metro-run.exit.json`. */
export interface MetroExitRecord {
  pid: number;
  processToken: string;
  code: number | null;
  signal: string | null;
  exitedAt: string;
  helperPid: number;
}

export function readMetroExit(projectRoot: string): MetroExitRecord | null {
  const value = readJsonObject(metroExitFile(projectRoot));
  if (
    !value ||
    typeof value.pid !== 'number' ||
    typeof value.processToken !== 'string' ||
    typeof value.exitedAt !== 'string' ||
    typeof value.helperPid !== 'number'
  )
    return null;
  return {
    pid: value.pid,
    processToken: value.processToken,
    code: typeof value.code === 'number' ? value.code : null,
    signal: typeof value.signal === 'string' ? value.signal : null,
    exitedAt: value.exitedAt,
    helperPid: value.helperPid,
  };
}
