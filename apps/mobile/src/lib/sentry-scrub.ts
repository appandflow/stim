import type { Breadcrumb, ErrorEvent } from '@sentry/react-native';

const RULES: [RegExp, string][] = [
  [/\bExpo(?:nent)?PushToken\[[^\]]*\]/g, '[push-token]'],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]*[^\s"'<>`.,;:!?)\]]/gi, '[url]'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]'],
  [/(?<![\w.-])(?:[a-z0-9-]+\.)+(?:ts\.net|local)\b/gi, '[host]'],
  // Stim tokens are 32 random bytes in base64url (43 characters); UUIDs (36) and fingerprints (40) stay readable.
  [/(?<![\w-])[\w-]{41,}(?![\w-])/g, '[token]'],
  [/\/Users\/[^/\s"'`]+/g, '~'],
];

export function scrubText(text: string): string {
  return RULES.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), text);
}

function scrubValue<T>(value: T): T {
  if (typeof value === 'string') return scrubText(value) as T;
  if (Array.isArray(value)) return value.map(scrubValue) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, scrubValue(entry)])) as T;
  }
  return value;
}

export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  return {
    ...breadcrumb,
    ...(breadcrumb.message === undefined ? null : { message: scrubText(breadcrumb.message) }),
    ...(breadcrumb.data === undefined ? null : { data: scrubValue(breadcrumb.data) }),
  };
}

/** Tags and contexts are left alone: the SDK fills them with update ids and device facts, not app data. */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  return {
    ...event,
    ...(event.message === undefined ? null : { message: scrubText(event.message) }),
    ...(event.exception?.values
      ? {
          exception: {
            ...event.exception,
            values: event.exception.values.map((value) =>
              value.value === undefined ? value : { ...value, value: scrubText(value.value) },
            ),
          },
        }
      : null),
    ...(event.breadcrumbs ? { breadcrumbs: event.breadcrumbs.map(scrubBreadcrumb) } : null),
    ...(event.extra ? { extra: scrubValue(event.extra) } : null),
  };
}
