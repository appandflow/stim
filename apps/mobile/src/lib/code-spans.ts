export interface CodeSpan {
  text: string;
  code: boolean;
}

/** Splits text from the CLI at its `backticked` spans; a backtick with no partner stays in the text. */
export function codeSpans(text: string): CodeSpan[] {
  const spans: CodeSpan[] = [];
  let last = 0;
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    if (match.index > last) spans.push({ text: text.slice(last, match.index), code: false });
    spans.push({ text: match[1] ?? '', code: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) spans.push({ text: text.slice(last), code: false });
  return spans;
}
