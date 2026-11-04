const SPACE = /[ \t\n\r]/;
const VALUE_END = /[ \t\n\r,\]}]/;

function skipSpace(text: string, from: number): number {
  let index = from;
  while (index < text.length && SPACE.test(text.charAt(index))) index++;
  return index;
}

/** The index after the JSON value starting at `from`, in text that is valid JSON. */
function skipValue(text: string, from: number): number {
  const first = text[from];
  if (first === '"') {
    let index = from + 1;
    while (text[index] !== '"') index += text[index] === '\\' ? 2 : 1;
    return index + 1;
  }
  if (first === '{' || first === '[') {
    let depth = 0;
    for (let index = from; ; index++) {
      const char = text[index];
      if (char === '"') index = skipValue(text, index) - 1;
      else if (char === '{' || char === '[') depth++;
      else if (char === '}' || char === ']') {
        depth--;
        if (depth === 0) return index + 1;
      }
    }
  }
  let index = from;
  while (index < text.length && !VALUE_END.test(text.charAt(index))) index++;
  return index;
}

/**
 * Calls `visit` with each member's key, the [start, end) span of its value and the index where the member starts, in the
 * object or array at `from`.
 */
function eachMember(
  text: string,
  from: number,
  visit: (key: unknown, start: number, end: number, memberStart: number) => void,
): void {
  const object = text[from] === '{';
  let index = from + 1;
  for (;;) {
    index = skipSpace(text, index);
    if (text[index] === '}' || text[index] === ']') return;
    const memberStart = index;
    let key: unknown = null;
    if (object) {
      const keyEnd = skipValue(text, index);
      key = JSON.parse(text.slice(index, keyEnd));
      index = skipSpace(text, keyEnd) + 1;
      index = skipSpace(text, index);
    }
    const end = skipValue(text, index);
    visit(key, index, end, memberStart);
    index = skipSpace(text, end);
    if (text[index] === ',') index++;
  }
}

/**
 * The [start, end) span in `text` of each element of the array that the top-level object `text` holds under `member`,
 * or null when it holds none. `text` must be valid JSON. Like `JSON.parse`, the last of a repeated key counts.
 */
export function arrayElementSpans(text: string, member: string): Array<[number, number]> | null {
  const members: Array<[number, number]> = [];
  eachMember(text, skipSpace(text, 0), (key, start, end) => {
    if (key === member) members.push([start, end]);
  });
  const array = members.at(-1);
  if (array === undefined || text[array[0]] !== '[') return null;
  const spans: Array<[number, number]> = [];
  eachMember(text, array[0], (_key, start, end) => spans.push([start, end]));
  return spans;
}

/** The text of each member of the top-level object `text` whose key is not in `omit`, from its key to the end of its value. */
export function otherMembers(text: string, omit: readonly string[]): string[] {
  const members: string[] = [];
  eachMember(text, skipSpace(text, 0), (key, _start, end, memberStart) => {
    if (typeof key !== 'string' || !omit.includes(key)) members.push(text.slice(memberStart, end));
  });
  return members;
}
