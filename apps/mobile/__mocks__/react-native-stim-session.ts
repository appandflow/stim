import { View } from 'react-native';

export function createSession(): never {
  throw new Error('Jest has no native session. Pass the connection a createSocket factory.');
}

export function clientPublicKey(): string {
  return 'jest-client-key';
}

export function createNoiseCheck(): never {
  throw new Error('Jest has no native Noise implementation.');
}

export const StimVideoView = View;
