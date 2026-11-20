/** The walker's own command line when `file` and `args` run it at background priority on macOS or Linux, else null. */
export function backgroundWalk(file: string, args: readonly string[]): string[] | null {
  if (file === 'taskpolicy' && args[0] === '-b') return args.slice(1);
  if (file === 'ionice' && args.slice(0, 4).join(' ') === '-c3 nice -n 19') return args.slice(4);
  return null;
}
