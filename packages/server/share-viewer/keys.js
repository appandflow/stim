(() => {
  const NAMED = {
    ArrowLeft: 'left',
    ArrowRight: 'right',
    ArrowUp: 'up',
    ArrowDown: 'down',
    Escape: 'escape',
    Tab: 'tab',
    Enter: 'return',
    Backspace: 'backspace',
  };
  const TYPED = { Enter: '\n', Tab: '\t', Backspace: '\b' };

  /**
   * The message a key press sends to the device, or null to leave it to the browser. A key without Command (the
   * shortcut key), Control (on a Mac) or Option types its character with `text`, the arrows and Escape go as `key`,
   * and a chord goes as `key` with its modifiers, named by the character the layout types (a Latin letter or
   * digit) or else by the physical key. On a Mac, an Option character that is printable ASCII is typed. `apple` says the viewer's computer is a Mac, where Command is the
   * shortcut key and Control stays Control; elsewhere Control is the shortcut key. The paste shortcut is left to the
   * page's paste handler, which syncs the clipboard.
   */
  function keyMessage(event, apple) {
    if (!apple && event.metaKey) return null;
    const command = apple ? event.metaKey : event.ctrlKey;
    const control = apple && event.ctrlKey;
    const altGraph = typeof event.getModifierState === 'function' && event.getModifierState('AltGraph');
    if (altGraph || !(command || control || event.altKey)) {
      const key = NAMED[event.key];
      if (key && (event.key.startsWith('Arrow') || key === 'escape')) {
        return { type: 'key', key, ...(event.shiftKey ? { modifiers: ['shift'] } : {}) };
      }
      const text =
        TYPED[event.key] ?? (event.key.length === 1 && event.key >= ' ' && event.key <= '~' ? event.key : null);
      return text === null ? null : { type: 'text', text };
    }
    const printable = event.key.length === 1 && event.key >= ' ' && event.key <= '~';
    if (apple && event.altKey && !command && !control && printable) return { type: 'text', text: event.key };
    const key =
      NAMED[event.key] ??
      (/^[A-Za-z0-9]$/.test(event.key) ? event.key.toLowerCase() : undefined) ??
      /^(?:Key([A-Z])|Digit([0-9]))$/.exec(event.code)?.slice(1).find(Boolean)?.toLowerCase();
    if (!key || (command && !event.shiftKey && !event.altKey && key === 'v')) return null;
    const modifiers = [
      command && 'command',
      event.shiftKey && 'shift',
      event.altKey && 'option',
      control && 'control',
    ].filter(Boolean);
    return { type: 'key', key, modifiers };
  }

  const REPLACEMENTS = {
    '\u2018': "'",
    '\u2019': "'",
    '\u201C': '"',
    '\u201D': '"',
    '\u2013': '-',
    '\u2014': '-',
    '\u2026': '...',
    '\u00A0': ' ',
  };

  /** The printable ASCII a phone keyboard's text types on the device: smart punctuation becomes its ASCII form and other characters are dropped. */
  function asciiText(text) {
    let out = '';
    for (const char of text) {
      for (const c of REPLACEMENTS[char] ?? char) {
        if ((c >= ' ' && c <= '~') || c === '\n') out += c;
      }
    }
    return out;
  }

  /** What to type when the phone's text field changes from `previous` to `next`: a Delete (`\b`) for each character removed after their common prefix, then the characters added. */
  function keyboardDelta(previous, next) {
    const before = asciiText(previous);
    const after = asciiText(next);
    let common = 0;
    while (common < before.length && common < after.length && before[common] === after[common]) common++;
    return '\b'.repeat(before.length - common) + after.slice(common);
  }

  globalThis.stimKeys = { keyMessage, keyboardDelta };
})();
