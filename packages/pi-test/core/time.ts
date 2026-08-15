/** Local wall time helpers for run dir names and ISO timestamps. */

export function nowIso(): string {
  return new Date().toISOString();
}

/** Local `YYYY-MM-DD-HHmm` for run directory prefix. */
export function localStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
