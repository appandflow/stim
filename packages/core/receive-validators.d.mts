import type { Method } from './phone-protocol.ts';

export const responses: Record<Method, (value: unknown) => boolean>;
export function event(value: unknown): boolean;
export function error(value: unknown): boolean;
export const eventNames: readonly string[];
