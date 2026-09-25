import { router } from 'expo-router';
import { useEffect } from 'react';

import { CLIENT } from '@/hooks/mac-connection';
import { applyDevPairing, devPairing } from '@/lib/dev-pairing';

/** In development, pairs the Mac from `.env.local` and opens its workspaces. */
export function useDevPairing(): void {
  useEffect(() => {
    const pairing = devPairing();
    if (!pairing) return;
    applyDevPairing(pairing, CLIENT).then(
      (mac) => router.push({ pathname: '/mac/[id]', params: { id: mac.id } }),
      (error: Error) => console.warn(`Could not pair ${pairing.endpoint} from .env.local: ${error.message}`),
    );
  }, []);
}
