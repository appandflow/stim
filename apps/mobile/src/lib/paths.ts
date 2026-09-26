const PATH_CHAR = /[^\s'"`(),:;<>[\]{}]/;

function replaceRoot(text: string, root: string, under: string, bare: string | null): string {
  let out = '';
  let from = 0;
  for (let at = text.indexOf(root); at >= 0; at = text.indexOf(root, at + 1)) {
    if (at < from) continue;
    const before = at > 0 ? text[at - 1] : '';
    const after = text[at + root.length] ?? '';
    if (before && PATH_CHAR.test(before)) continue;
    if (after === '/') {
      out += `${text.slice(from, at)}${under}`;
      from = at + root.length + 1;
    } else if (bare !== null && !(after && PATH_CHAR.test(after))) {
      out += `${text.slice(from, at)}${bare}`;
      from = at + root.length;
    }
  }
  return out + text.slice(from);
}

/**
 * Shows the Mac's home folder as `~` wherever it starts a path in `text`: in a bare path or inside a
 * sentence. `home` matches only whole path segments, so `/Users/jan` leaves `/Users/janic/x` alone.
 * Without a known home the text is returned unchanged.
 */
export function tildeHome(text: string, home: string | null | undefined): string {
  const root = home?.replace(/\/+$/, '');
  return root ? replaceRoot(text, root, '~/', '~') : text;
}

/** Writes paths under `root` relative to it, with the same whole-segment matching as `tildeHome`. */
export function relativeTo(text: string, root: string | null | undefined): string {
  const base = root?.replace(/\/+$/, '');
  return base ? replaceRoot(text, base, '', null) : text;
}
