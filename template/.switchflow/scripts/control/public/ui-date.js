const supportedFormats = new Set(['yyyy-mm-dd', 'dd/mm/yyyy', 'mm/dd/yyyy']);

export function normalizeDateFormat(value) {
  return supportedFormats.has(value) ? value : 'yyyy-mm-dd';
}

function parts(value) {
  const calendar = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(String(value));
  if (calendar) return { year: calendar[1], month: calendar[2], day: calendar[3] };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return {
    year: String(date.getFullYear()).padStart(4, '0'),
    month: String(date.getMonth() + 1).padStart(2, '0'),
    day: String(date.getDate()).padStart(2, '0'),
  };
}

export function formatProjectDate(value, format = 'yyyy-mm-dd', fallback = 'Date unavailable') {
  if (!value) return fallback;
  const date = parts(value);
  if (!date) return String(value);
  switch (normalizeDateFormat(format)) {
    case 'dd/mm/yyyy': return `${date.day}/${date.month}/${date.year}`;
    case 'mm/dd/yyyy': return `${date.month}/${date.day}/${date.year}`;
    default: return `${date.year}-${date.month}-${date.day}`;
  }
}
