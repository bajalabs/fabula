/* {{ key }} substitution for the HTML and MJML engines: no loops, no conditionals. 'html' mode escapes the value;
   'raw' passes it through. Typst, Markdown and Quarto receive values as `#let` bindings instead.

   Only text, numbers and true/false have a text form. A list or an object in a {{ key }} is refused with
   TemplateValueError rather than written into the markup as JSON. */

export type SubstMode = 'html' | 'raw'

const TOKEN_RE = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/gi

export class TemplateValueError extends Error {
  constructor(readonly key: string) {
    super(`{{ ${key} }}: a list or an object has no text form; an HTML or MJML template takes text, numbers and true/false`)
    this.name = 'TemplateValueError'
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function textOf(key: string, v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  throw new TemplateValueError(key)
}

/** Every key a source names in a {{ key }}. */
export function tokenKeys(source: string): Set<string> {
  return new Set(Array.from(source.matchAll(TOKEN_RE), (m) => m[1]))
}

export function substitute(source: string, values: Record<string, unknown>, mode: SubstMode = 'html'): string {
  return source.replace(TOKEN_RE, (match, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) {
      return match // an unknown token is left alone, so it shows in a preview
    }
    const text = textOf(key, values[key])
    return mode === 'html' ? escapeHtml(text) : text
  })
}
