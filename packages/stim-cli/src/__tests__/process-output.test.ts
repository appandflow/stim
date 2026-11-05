import { createLineReader } from '../process-output.ts';

test('createLineReader drops the CR of a CRLF final line that has no newline', () => {
  const lines: string[] = [];
  const reader = createLineReader((line) => lines.push(line));
  reader.push('BUILD FAILED\r\nFAILURE: Build failed\r');
  reader.flush();
  expect(lines).toEqual(['BUILD FAILED', 'FAILURE: Build failed']);
});
