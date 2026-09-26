import { Banner } from '@/components/banner';
import type { ConnectionState } from '@/lib/connection';

export function ConnectionBanner({ state, style }: { state: ConnectionState; style?: { marginHorizontal: number } }) {
  if (state.kind === 'open') return null;
  const text =
    state.kind === 'connecting'
      ? 'Connecting'
      : state.kind === 'waiting'
        ? `${state.reason} Retrying in ${Math.round(state.retryInMs / 1000)}s.`
        : state.kind === 'refused'
          ? state.code === 'protocol-unsupported'
            ? `${state.reason} Update this app or the Stim server on the machine.`
            : `${state.reason} Pair this machine again from Stim Desktop.`
          : 'Disconnected';
  return (
    <Banner variant="attached" tone={state.kind === 'connecting' ? 'neutral' : 'error'} message={text} style={style} />
  );
}
