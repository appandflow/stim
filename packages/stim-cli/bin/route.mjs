const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Orders two semver versions: negative, zero or positive; null when either does not parse. */
export function compareVersions(left, right) {
  const a = SEMVER.exec(left);
  const b = SEMVER.exec(right);
  if (!a || !b) return null;
  for (let index = 1; index <= 3; index++) if (a[index] !== b[index]) return Number(a[index]) - Number(b[index]);
  if (!a[4] || !b[4]) return (a[4] ? -1 : 0) + (b[4] ? 1 : 0);
  const x = a[4].split('.');
  const y = b[4].split('.');
  for (let index = 0; index < Math.max(x.length, y.length); index++) {
    const [p, q] = [x[index], y[index]];
    if (p === q) continue;
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    const [m, n] = [/^\d+$/.test(p), /^\d+$/.test(q)];
    if (m && n) return Number(p) - Number(q);
    return m ? -1 : n ? 1 : p < q ? -1 : 1;
  }
  return 0;
}

/** Whether Node `version` meets an `engines.node` range of the form `>=X.Y.Z`; another form is not checked. */
function satisfies(version, range) {
  const floor = /^>=\s*(\d+)\.(\d+)(?:\.(\d+))?$/.exec(range ?? '');
  return !floor || (compareVersions(version, `${floor[1]}.${floor[2]}.${floor[3] ?? 0}`) ?? 0) >= 0;
}

/** Where a copy of Stim at `dir` (symlinks resolved) is installed, judged by its path. */
export function installKind(dir, root) {
  if (dir.startsWith(`${root}/`) || dir.startsWith(`${root}\\`)) return 'store';
  const parts = dir.split(/[\\/]/);
  if (!parts.includes('node_modules')) return 'development';
  if (parts.includes('_npx')) return 'npx';
  return /[\\/](lib|npm)[\\/]node_modules[\\/]stim$/i.test(dir) ? 'machine' : 'project';
}

/** What the router does with one command, given the engine's `current.json` and `staged.json`. */
export function route({ args, copy, current, staged, node }) {
  if (current === null) return { run: 'own' };
  if (typeof current !== 'object')
    return { run: 'own', fallback: true, note: 'the engine pointer cannot be read; this command runs this copy' };
  // compat C1 permanent
  if (current.format !== 1) {
    const note = `STIM_ROUTER_TOO_OLD: this stim (${copy.version}, ${copy.kind}) cannot read engine format ${String(current.format)}; run npx stim@latest, npm i -D stim@latest or npm i -g stim@latest`;
    return { run: 'refuse', note };
  }
  // compat end
  if (copy.kind === 'development')
    return { run: 'own', note: `this development tree runs in place, not the engine (${current.version})` };
  if (args[2] === '--version' || args[2] === '-V')
    return {
      run: 'own',
      note:
        copy.version === current.version ? null : `engine ${current.version} (this copy ${copy.version}, ${copy.kind})`,
    };
  const fit = satisfies(node, current.engines)
    ? null
    : current.node.find((each) => satisfies(each.version, current.engines));
  const target = satisfies(node, current.engines)
    ? { run: 'engine' }
    : fit
      ? { run: 'node', node: fit.path }
      : {
          run: 'own',
          fallback: true,
          note: `no recorded Node satisfies ${current.engines}; this command runs this copy`,
        };
  const order = copy.kind === 'store' ? 0 : (compareVersions(copy.version, current.version) ?? 0);
  if (current.pinned) {
    const resume = `run stim engine update to resume updates${order > 0 ? ` or stim engine use ${copy.version}` : ''}`;
    return { ...target, note: `the engine is pinned at ${current.version} (${current.pinReason}); ${resume}` };
  }
  if (order <= 0) return target;
  if (copy.version.includes('-') && current.channel === 'latest') {
    const note = `stim ${copy.version} is a prerelease and the engine follows latest; this command runs ${current.version}. To follow prereleases, run stim engine use --channel next`;
    return { ...target, note };
  }
  if (staged && (compareVersions(staged.version, copy.version) ?? -1) >= 0)
    return { ...target, note: `stim ${staged.version} is staged; this command runs ${current.version}` };
  return { ...target, promote: copy.kind === 'machine' ? 'inline' : 'detached' };
}
