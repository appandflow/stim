import { resolve4 } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';

export async function probePublicHttp(url: string, signal: AbortSignal): Promise<number | null> {
  try {
    const response = await fetch(url, { signal, redirect: 'follow' });
    return response.status;
  } catch (error) {
    const cause = (error as { cause?: { code?: unknown } })?.cause;
    if (cause?.code !== 'ENOTFOUND' && cause?.code !== 'EAI_AGAIN') return null;
  }

  const hostname = new URL(url).hostname;
  if (!hostname.endsWith('.trycloudflare.com')) return null;

  let addresses: string[];
  try {
    addresses = await resolve4(hostname);
  } catch {
    return null;
  }
  const firstAddress = addresses[0];
  if (!firstAddress) return null;

  return new Promise((resolve) => {
    const request = httpsRequest(
      url,
      {
        signal,
        lookup: (_hostname, options, callback) => {
          // Node requests all addresses when automatic family selection is enabled.
          if (options.all)
            callback(
              null,
              addresses.map((address) => ({ address, family: 4 })),
            );
          else callback(null, firstAddress, 4);
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? null);
      },
    );
    request.on('error', () => resolve(null));
    request.end();
  });
}
