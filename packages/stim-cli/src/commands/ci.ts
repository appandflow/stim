import { defineOp, type Op } from '../cli/define-op.ts';

const ci: Op = defineOp({
  name: 'ci',
  description: 'Build and run apps in CI',
  passThrough: true,
  async run({ args }) {
    const { main } = await import('@stim-cli/ci/cli');
    await main([...args]);
  },
});

export default ci;
