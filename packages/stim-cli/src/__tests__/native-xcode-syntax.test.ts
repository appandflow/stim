import { parseNativeXcodeSyntax } from '../integrations/native-xcode-syntax.ts';

test('parses project.pbxproj values without altering identifiers, versions or quoted text', () => {
  const parsed = parseNativeXcodeSyntax(`// !$*UTF8*$!
{
  objectVersion = 0054;
  rootObject = 680759612239798500290469 /* Project object */;
  empty = "";
  quoted = "a \\"b\\"; (c) = {d}";
  version = 1.0;
  list = (
    one /* first */,
    "two, three"
  );
  nothing = ( );
  /* Begin Section */
  nested = { inner = $(A_$(B)); };
}
`);
  expect(JSON.parse(JSON.stringify(parsed))).toEqual({
    objectVersion: '0054',
    rootObject: '680759612239798500290469',
    empty: '""',
    quoted: '"a \\"b\\"; (c) = {d}"',
    version: '1.0',
    list: ['one', '"two, three"'],
    nothing: [],
    nested: { inner: '$(A_$(B))' },
  });
});

test.each(['', '{ a = b }', '{ a = (b c); }', '{ a = "b; }', '{ a = b; } trailing'])(
  'refuses malformed project text %j',
  (source) => {
    expect(() => parseNativeXcodeSyntax(source)).toThrow(/Cannot parse project.pbxproj/);
  },
);
