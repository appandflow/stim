import type { Breadcrumb, ErrorEvent } from '@sentry/react-native';

const LONGER_THAN_A_FINGERPRINT = /(?<![\w-])[\w-]{41,}(?![\w-])/g;

const RULES: [RegExp, string][] = [
  [/\bExpo(?:nent)?PushToken\[[^\]]*\]/g, '[push-token]'],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]*[^\s"'<>`.,;:!?)\]]/gi, '[url]'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]'],
  [/(?<![\w.-])(?:[a-z0-9-]+\.)+(?:ts\.net|local)\b/gi, '[host]'],
  [LONGER_THAN_A_FINGERPRINT, '[token]'],
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
    ...(event.contexts?.route ? { contexts: { ...event.contexts, route: scrubValue(event.contexts.route) } } : null),
  };
}
