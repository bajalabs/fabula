/* {{ key }} substitution for the HTML and MJML engines: no loops, no conditionals. 'html' mode escapes the value;
   'raw' passes it through. Typst, Markdown and Quarto receive values as `#let` bindings instead. */

export type SubstMode = 'html' | 'raw'

const TOKEN_RE = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/gi

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function stringify(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  // arrays + objects — JSON-stringify so they don't silently stringify
  // to "[object Object]"; authors can pick them apart client-side if
  // they really need structured data.
  try {
    return JSON.stringify(v)
  } catch {
    return ''
  }
}

export function substitute(
  source: string,
  values: Record<string, unknown>,
  mode: SubstMode = 'html',
): string {
  return source.replace(TOKEN_RE, (match, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) {
      return match // leave unknown tokens alone so they surface in preview
    }
    const raw = stringify(values[key])
    return mode === 'html' ? escapeHtml(raw) : raw
  })
}
