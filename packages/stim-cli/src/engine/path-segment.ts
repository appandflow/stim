export function segment(value: string): string {
  return (
    String(value)
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^\.+/, '') || 'unknown'
  );
}
