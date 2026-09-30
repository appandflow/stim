import { t } from '@lingui/core/macro';

import { Banner } from '@/components/banner';
import type { ConnectionState } from '@/lib/connection';

export function ConnectionBanner({ state, style }: { state: ConnectionState; style?: { marginHorizontal: number } }) {
  if (state.kind === 'open') return null;
  const text = bannerText(state);
  return (
    <Banner variant="attached" tone={state.kind === 'connecting' ? 'neutral' : 'error'} message={text} style={style} />
  );
}

function bannerText(state: Exclude<ConnectionState, { kind: 'open' }>): string {
  switch (state.kind) {
    case 'connecting':
      return t`Connecting`;
    case 'waiting': {
      const { reason } = state;
      const seconds = Math.round(state.retryInMs / 1000);
      return t`${reason} Retrying in ${seconds}s.`;
    }
    case 'refused': {
      const { reason } = state;
      return state.code === 'protocol-unsupported'
        ? t`${reason} Update this app or the Stim server on the machine.`
        : t`${reason} Pair this machine again from Stim Desktop.`;
    }
    case 'closed':
      return t`Disconnected`;
  }
}
