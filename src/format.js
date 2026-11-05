export function formatDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

/** Publication dates keep the precision the provider gave (day-only dates show no time). */
export function formatPublished(source) {
  if (source.precision === 'day') return formatDate(source.publishedAt);
  if (source.precision === 'relative') return `about ${formatDateTime(source.publishedAt)}`;
  return formatDateTime(source.publishedAt);
}

export function formatSpan(hours) {
  if (hours < 48) return `${hours} hours`;
  const days = Math.round(hours / 24);
  return `${days} days`;
}
