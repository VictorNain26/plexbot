/** « 3:07 », or « 1:02:03 » past an hour. Negative or invalid input reads as 0:00. */
export function formatDuration(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Reads « 90 », « 1:30 » or « 1:02:03 » as milliseconds; undefined when it isn't a time. */
export function parseDuration(text: string): number | undefined {
  const parts = text.trim().split(':');
  if (parts.length > 3 || parts.some((p) => !/^[0-9]{1,4}$/.test(p))) return undefined;
  const [s = 0, m = 0, h = 0] = parts.map(Number).reverse();
  if (parts.length > 1 && s >= 60) return undefined;
  if (parts.length > 2 && m >= 60) return undefined;
  return ((h * 60 + m) * 60 + s) * 1000;
}

const BAR_WIDTH = 16;

/** A text progress bar, ▰ for elapsed and ▱ for what remains. */
export function progressBar(elapsedMs: number, totalMs: number, width = BAR_WIDTH): string {
  const raw = totalMs > 0 ? elapsedMs / totalMs : 0;
  const ratio = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 1) : 0;
  const filled = Math.round(ratio * width);
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

/** Escapes Discord markdown so a title like « *NSYNC » or « Track_1 » prints as written. */
export function escapeMarkdown(text: string): string {
  return text.replace(/([\\*_~`|>#[\]()-])/g, '\\$1');
}
