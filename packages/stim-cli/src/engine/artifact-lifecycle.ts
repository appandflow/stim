type ArtifactResolution<Artifact> =
  | { kind: 'ready'; artifact: Artifact }
  | { kind: 'cached'; artifact: Artifact }
  | { kind: 'miss' };

export interface ReadyArtifact<Artifact> {
  ready: Artifact;
}

export interface ArtifactLifecycle<Artifact, Preparation, Placement = never> {
  resolve(): Promise<ArtifactResolution<Artifact>>;
  claim?(): Promise<Artifact | null>;
  reuse(artifact: Artifact): Promise<Artifact | null>;
  build: {
    placement?: {
      select(): Placement | null;
      acquire(placement: Placement, preparation: Preparation): Promise<ReadyArtifact<Artifact> | null>;
    };
    admit(): Promise<void>;
    prepare(): Promise<Preparation>;
    revalidate(preparation: Preparation): Promise<ReadyArtifact<Artifact> | null>;
    compile(placement: Placement | null, preparation: Preparation): Promise<Artifact>;
    validate(preparation: Preparation): Promise<'cacheable' | 'uncacheable'>;
    store(artifact: Artifact): Promise<void>;
    finish?(artifact: Artifact): Promise<Artifact>;
  };
  release(): void;
}

export async function runArtifactLifecycle<Artifact, Preparation, Placement>(
  phases: ArtifactLifecycle<Artifact, Preparation, Placement>,
): Promise<Artifact> {
  try {
    const resolved = await phases.resolve();
    if (resolved.kind === 'ready') return resolved.artifact;
    const cached = resolved.kind === 'cached' ? resolved.artifact : ((await phases.claim?.()) ?? null);
    if (cached !== null) {
      const reused = await phases.reuse(cached);
      if (reused !== null) return reused;
    }

    const { build } = phases;
    const placement = build.placement?.select() ?? null;
    if (placement === null) await build.admit();
    const preparation = await build.prepare();
    const late = await build.revalidate(preparation);
    if (late !== null) return late.ready;

    if (build.placement && placement !== null) {
      const offloaded = await build.placement.acquire(placement, preparation);
      if (offloaded !== null) return offloaded.ready;
      await build.admit();
    }
    const artifact = await build.compile(placement, preparation);
    if ((await build.validate(preparation)) === 'cacheable') await build.store(artifact);
    return build.finish ? await build.finish(artifact) : artifact;
  } finally {
    phases.release();
  }
}
