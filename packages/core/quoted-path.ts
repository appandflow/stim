/** Quote a path for a shell command Stim prints for a human to copy and run. */
export function quotedPath(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}
