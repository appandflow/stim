/** Whether a resource destination is a contained, non-empty path under Contents/Resources. */
export function validMacosResourceDestination(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 1024 &&
    !value.includes('\0') &&
    !value.includes('\\') &&
    !/^[A-Za-z]:/.test(value) &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}
