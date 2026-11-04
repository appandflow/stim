import { codeSpans } from '@/lib/code-spans';

test('shows a command from the CLI as code without its backticks', () => {
  expect(codeSpans('On mini, run `stim-server devices revoke 1a2b`, then `tailscale up` again.')).toEqual([
    { text: 'On mini, run ', code: false },
    { text: 'stim-server devices revoke 1a2b', code: true },
    { text: ', then ', code: false },
    { text: 'tailscale up', code: true },
    { text: ' again.', code: false },
  ]);
});

test('keeps a backtick that has no partner', () => {
  expect(codeSpans('Use the ` key')).toEqual([{ text: 'Use the ` key', code: false }]);
  expect(codeSpans('')).toEqual([]);
});
