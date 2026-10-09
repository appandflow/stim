import pbxParser from 'xcode/lib/parser/pbxproj.js';

export function parseNativeXcodeSyntax(source: string): unknown {
  let normalized = '';
  for (let at = 0; at < source.length;) {
    const start = at;
    if (source[at] === '"') {
      at++;
      while (at < source.length) {
        if (source[at] === '\\') at += 2;
        else if (source[at++] === '"') break;
      }
    } else if (source.startsWith('/*', at)) {
      const end = source.indexOf('*/', at + 2);
      at = end < 0 ? source.length : end + 2;
    } else if (source.startsWith('//', at)) {
      const end = source.indexOf('\n', at + 2);
      at = end < 0 ? source.length : end + 1;
    } else if (source.startsWith('$(', at)) {
      at += 2;
      let depth = 1;
      while (at < source.length && depth > 0) {
        if (source[at] === '(') depth++;
        else if (source[at] === ')') depth--;
        at++;
      }
    } else {
      // xcode 3.0.1's LiteralString consumes an array's closing parenthesis without a final comma.
      // Apple permits that syntax: https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/PropertyLists/OldStylePlists/OldStylePLists.html
      if (source[at] === ')') normalized += '\n';
      at++;
    }
    normalized += source.slice(start, at);
  }
  return pbxParser.parse(normalized);
}
