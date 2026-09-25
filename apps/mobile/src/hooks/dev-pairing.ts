import { useEffect } from 'react';

import { CLIENT, useMacs } from '@/hooks/mac-connection';
import { applyDevPairing, devPairing } from '@/lib/dev-pairing';

/** Stores the `.env.local` machine in a development build, inside `MacsProvider` so the home screen lists it. */
export function DevPairing(): null {
  const { reload } = useMacs();
  useEffect(() => {
    const pairing = devPairing();
    if (!pairing) return;
    applyDevPairing(pairing, CLIENT).then(reload, (error: Error) =>
      console.warn(`Could not pair ${pairing.endpoint} from .env.local: ${error.message}`),
    );
  }, [reload]);
  return null;
}
