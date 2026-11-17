const SHAPES = [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, /\bsk-[A-Za-z0-9_-]{16,}/g];
const MIN_SECRET_LENGTH = 8;

export function secretValues(json: string): string[] {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value.length >= MIN_SECRET_LENGTH) found.add(value);
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  try {
    walk(JSON.parse(json));
  } catch {
    return [];
  }
  return [...found];
}

export function redact(text: string, secrets: string[]): string {
  let result = text;
  const variants = secrets.flatMap((secret) => [secret, JSON.stringify(secret).slice(1, -1)]);
  for (const secret of variants.toSorted((a, b) => b.length - a.length))
    result = result.replaceAll(secret, '[redacted]');
  for (const shape of SHAPES) result = result.replace(shape, '[redacted]');
  return result;
}
