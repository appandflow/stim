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

  globalThis.stimKeys = { keyMessage };
})();
