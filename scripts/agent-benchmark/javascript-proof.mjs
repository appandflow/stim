export function javascriptProof(source, sourcePath, screen) {
  const expected = 'Keep saved trail maps available offline';
  if (typeof source !== 'string' || !source.includes(expected))
    return { valid: false, reason: 'source-edit-missing', sourcePath };
  if (screen?.valid !== true || screen.expected !== expected) return { valid: false, reason: 'screen-proof-failed' };
  return {
    valid: true,
    kind: 'source-edit-and-settings-screen',
    expected,
    target: sourcePath,
    screenTarget: screen.target,
  };
}

export function appAliveErrorIsSuperseded(appAlive, proof, screen) {
  return (
    appAlive.error === 'proof-timeout-after-app-alive' &&
    typeof appAlive.simulator?.udid === 'string' &&
    appAlive.simulator.udid.length > 0 &&
    Number.isFinite(Date.parse(appAlive.observedAt)) &&
    proof.valid === true &&
    proof.kind === 'source-edit-and-settings-screen' &&
    screen.valid === true
  );
}
