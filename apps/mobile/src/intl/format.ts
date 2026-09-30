import { i18n } from '@lingui/core';
import { t } from '@lingui/core/macro';

export function formatDateTime(value: Date | number | string, options?: Intl.DateTimeFormatOptions): string {
  return i18n.date(typeof value === 'number' ? new Date(value) : value, options);
}

/** Numbers follow the messages' language, so a size reads the same in the sentence around it. */
function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(i18n.locale, options).format(value);
}

/**
 * `value` rounded half up to `digits` decimals, then formatted. Hermes on iOS rounds half to even and ignores
 * `style: 'unit'`, so sizes round with `toFixed` and carry their unit in the message.
 */
const decimal = (value: number, digits: 0 | 1) =>
  formatNumber(Number(value.toFixed(digits)), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: false,
  });

/**
 * "<1m", "14m", "2h", "2h03m", "3d": the `h`/`m` form apps/desktop uses on activity badges. `seconds` shows "40s"
 * under a minute; `coarse` drops the minutes from hours, "2h".
 */
export function formatDuration(
  ms: number,
  { seconds = false, coarse = false }: { seconds?: boolean; coarse?: boolean } = {},
): string {
  const clamped = ms > 0 ? ms : 0;
  if (clamped < 60_000) {
    const secs = Math.floor(clamped / 1000);
    return seconds ? t`${secs}s` : t`<1m`;
  }
  const minutes = Math.floor(clamped / 60_000);
  if (minutes < 60) return t`${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return t`${days}d`;
  }
  if (coarse || minutes % 60 === 0) return t`${hours}h`;
  const rest = String(minutes % 60).padStart(2, '0');
  return t`${hours}h${rest}m`;
}

/** Decimal units, like the Finder and Stim Desktop's disk figures. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e12) {
    const tb = decimal(bytes / 1e12, 1);
    return t`${tb} TB`;
  }
  const raw = bytes / 1e9;
  const gb = decimal(raw, raw >= 100 ? 0 : 1);
  return t`${gb} GB`;
}

/** Decimal units like the Finder, down to kilobytes for logs and small caches. */
export function formatSize(bytes: number): string {
  if (bytes >= 1e12) return formatBytes(bytes);
  if (bytes >= 1e9) {
    const gb = decimal(bytes / 1e9, 1);
    return t`${gb} GB`;
  }
  if (bytes >= 1e6) {
    const mb = decimal(bytes / 1e6, 0);
    return t`${mb} MB`;
  }
  if (bytes > 0) {
    const kb = decimal(Math.max(1, Math.round(bytes / 1e3)), 0);
    return t`${kb} KB`;
  }
  return t`None`;
}

/** Binary megabytes, shown as GB from 1024 MB, like Activity Monitor. */
export function formatMemoryMb(mb: number): string {
  if (mb >= 1024) {
    const gb = decimal(mb / 1024, 1);
    return t`${gb} GB`;
  }
  const whole = decimal(mb, 0);
  return t`${whole} MB`;
}
