const PATH_CHAR = /[^\s'"`(),:;<>[\]{}]/;

/**
 * Shows the Mac's home folder as `~` wherever it starts a path in `text`: in a bare path or inside a
 * sentence. `home` matches only whole path segments, so `/Users/jan` leaves `/Users/janic/x` alone.
 * Without a known home the text is returned unchanged.
 */
export function tildeHome(text: string, home: string | null | undefined): string {
  const root = home?.replace(/\/+$/, '');
  if (!root) return text;
  let out = '';
  let from = 0;
  for (let at = text.indexOf(root); at >= 0; at = text.indexOf(root, at + 1)) {
    if (at < from) continue;
    const before = at > 0 ? text[at - 1] : '';
    const after = text[at + root.length] ?? '';
    if ((before && PATH_CHAR.test(before)) || (after && after !== '/' && PATH_CHAR.test(after))) continue;
    out += `${text.slice(from, at)}~`;
    from = at + root.length;
  }
  return out + text.slice(from);
}
