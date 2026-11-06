export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function reason(error: unknown): string {
  const message = String((error as Error)?.message || error || 'unknown error');
  return message.split('\n')[0]!.trim() || 'unknown error';
}
