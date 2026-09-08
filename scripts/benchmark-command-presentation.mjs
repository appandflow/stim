function shellTokens(command) {
  const tokens = [];
  let index = 0;
  while (index < command.length) {
    if (command[index] !== '\n' && /\s/.test(command[index])) {
      index += 1;
      continue;
    }
    const start = index;
    if (command[index] === '#') return null;
    if (/[;&|\n]/.test(command[index])) {
      index += 1;
      if (command[index] === command[start] && /[&|]/.test(command[start])) index += 1;
      tokens.push({ start, end: index, value: command.slice(start, index), operator: true });
      continue;
    }
    let value = '';
    let quote = null;
    while (index < command.length) {
      const char = command[index];
      if (!quote && /[\s;&|]/.test(char)) break;
      if (char === '`' || (char === '$' && command[index + 1] === '(')) return null;
      if (char === '\\' && quote !== "'") {
        if (index + 1 === command.length) return null;
        if (/[\r\n]/.test(command[index + 1])) return null;
        value += command[index + 1];
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      else if (!quote && (char === "'" || char === '"')) quote = char;
      else value += char;
      index += 1;
    }
    if (quote) return null;
    tokens.push({ start, end: index, value, operator: false });
  }
  return tokens;
}

export function benchmarkCommandPresentation(command, exitCode, output = '') {
  if (command.includes('<<')) return undefined;
  let display = command;
  const statusEcho = display.match(/;\s*echo\s+"(EXIT|PIPELINE_EXIT)=\$\?"\s*$/);
  if (exitCode === 0 && statusEcho) {
    const markers = output.split(/\r?\n/).filter((line) => line.startsWith(`${statusEcho[1]}=`));
    if (markers.length === 1 && markers[0] === `${statusEcho[1]}=0`) {
      display = display.slice(0, statusEcho.index);
    }
  }
  let cwd;
  let tokens = shellTokens(display);
  if (!tokens) return undefined;
  const pathIndex = tokens[1]?.value === '--' ? 2 : 1;
  const path = tokens[pathIndex];
  if (
    exitCode === 0 &&
    tokens[0]?.value === 'cd' &&
    path &&
    !path.operator &&
    path.value &&
    !/^[-~]/.test(path.value) &&
    !/[$`*?{}[\]]/.test(path.value) &&
    tokens[pathIndex + 1]?.value === '&&' &&
    tokens[pathIndex + 2] &&
    !tokens[pathIndex + 2].operator &&
    !tokens.slice(pathIndex + 2).some((token) => token.operator && token.value !== '&&' && token.value !== '|')
  ) {
    cwd = path.value;
    display = display.slice(tokens[pathIndex + 2].start);
    tokens = shellTokens(display);
  }
  const removals = [];
  let isolatedAgentDevice = false;
  for (let index = 0; index < tokens.length; index += 1) {
    if (index > 0 && !tokens[index - 1].operator) continue;
    let first = index;
    if (tokens[first].value === 'do' || tokens[first].value === 'then') first += 1;
    const hasEnv = tokens[first]?.value === 'env';
    let end = first + Number(hasEnv);
    const hidden = [];
    while (
      tokens[end] &&
      !tokens[end].operator &&
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(hasEnv ? tokens[end].value : display.slice(tokens[end].start, tokens[end].end))
    ) {
      if (/^AGENT_DEVICE_(?:STATE_DIR|SESSION)=[^$`]+$/.test(tokens[end].value)) hidden.push(end);
      end += 1;
    }
    if (tokens[end]?.value !== 'agent-device' || hidden.length === 0) continue;
    isolatedAgentDevice = true;
    if (hasEnv && hidden.length === end - first - 1) {
      removals.push([tokens[first].start, tokens[end].start]);
    } else {
      for (const position of hidden) removals.push([tokens[position].start, tokens[position + 1].start]);
    }
    index = end;
  }
  for (const [start, end] of removals.toReversed()) display = display.slice(0, start) + display.slice(end);
  if (!cwd && removals.length === 0) return undefined;
  return { command: display, ...(cwd ? { cwd } : {}), ...(isolatedAgentDevice ? { isolatedAgentDevice } : {}) };
}
