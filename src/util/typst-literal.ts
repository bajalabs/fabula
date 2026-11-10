/* A JSON value as a Typst literal, for the `#let <key> = <literal>` lines written before a template's source.

   Strings are escaped for Typst (quote, backslash, line breaks) and every `{` is written as `\u{7b}`: Pandoc and
   Quarto read these lines inside a raw Typst block of a Markdown file, and Quarto expands a `{{< shortcode >}}`
   even there (`include` reads a file). Typst reads `\u{7b}` back as `{`, so the value is unchanged. */

export type FieldTypeHint =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'money_cents'
  | 'object'
  | 'array'
  | 'enum'

function escapeString(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/\{/g, '\\u{7b}')
}

/** Convert any JSON-compatible value to its Typst literal representation. */
export function toTypstLiteral(
  v: unknown,
  fieldType?: FieldTypeHint,
): string {
  // Explicit type hint — coerce strings to the declared shape
  if (fieldType === 'date' && typeof v === 'string' && v) {
    const d = new Date(v)
    if (!isNaN(d.getTime())) {
      return `datetime(year: ${d.getUTCFullYear()}, month: ${d.getUTCMonth() + 1}, day: ${d.getUTCDate()})`
    }
  }
  if (fieldType === 'money_cents') {
    const n = typeof v === 'number' ? v : parseInt(String(v ?? 0), 10)
    return Number.isFinite(n) ? String(n) : '0'
  }

  if (v === null || v === undefined) return 'none'
  if (typeof v === 'string') return `"${escapeString(v)}"`
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '0'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (v instanceof Date) {
    return `datetime(year: ${v.getUTCFullYear()}, month: ${v.getUTCMonth() + 1}, day: ${v.getUTCDate()})`
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return '()'
    return (
      '(' +
      v.map((x) => toTypstLiteral(x)).join(', ') +
      (v.length === 1 ? ',)' : ')')
    )
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
    if (entries.length === 0) return '(:)'
    return (
      '(' +
      entries
        // A key is a string too: written bare, a key from a request would run as Typst code
        .map(([k, val]) => `"${escapeString(k)}": ${toTypstLiteral(val)}`)
        .join(', ') +
      ')'
    )
  }
  return 'none'
}
