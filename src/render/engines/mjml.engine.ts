/* MjmlEngine: MJML to email-safe HTML, in process (no subprocess).

     1. {{ key }} substitution, HTML-escaped.
     2. The brand's <mj-attributes> into <mj-head>, unless the template has its own (after the values, so a brand
        name is never read as a {{ key }}).
     3. mjml2html(), with includes off: an <mj-include> is not read, so a source cannot pull a server file into the
        email. (MJML 5 defaults to this; it is set here so an upgrade cannot change it.) */

import { Injectable } from '@nestjs/common'
// mjml's default export is the compile function.
// @ts-expect-error — mjml ships types but eslint is squishy about CJS interop
import mjml2html from 'mjml'
import type {
  CompileError,
  OutputType,
  RenderFormat,
} from '../../contracts/index.js'
import { BrandIdentityService } from '../brand/brand-identity.service.js'
import { substitute, TemplateValueError } from '../../util/mustache.js'
import type {
  EngineRenderRequest,
  EngineRenderResult,
  RenderEngine,
} from '../../contracts/engine.js'

interface MjmlResult {
  html: string
  errors: Array<{
    line?: number
    message: string
    tagName?: string
    formattedMessage?: string
  }>
}

function injectBrandAttributes(source: string, mjAttrs: string): string {
  // If template already has <mj-attributes> anywhere, don't override —
  // author intent wins. Just inject if absent.
  if (/<mj-attributes\b/i.test(source)) return source

  // Prefer inserting inside existing <mj-head>.
  if (/<mj-head\b[^>]*>/i.test(source)) {
    return source.replace(
      /<mj-head\b[^>]*>/i,
      (m) => `${m}\n  ${mjAttrs}`,
    )
  }
  // Otherwise create an <mj-head> right after <mjml ...>.
  return source.replace(
    /<mjml\b[^>]*>/i,
    (m) => `${m}\n<mj-head>\n  ${mjAttrs}\n</mj-head>`,
  )
}

function composeSource(
  userSource: string,
  mjAttrs: string,
  values: Record<string, unknown>,
  fields: EngineRenderRequest['fields'],
): string {
  const resolved: Record<string, unknown> = Object.create(null)
  for (const f of fields) {
    resolved[f.key] =
      Object.prototype.hasOwnProperty.call(values, f.key)
        ? values[f.key]
        : f.defaultValue
  }
  for (const [k, v] of Object.entries(values)) resolved[k] = v

  return injectBrandAttributes(substitute(userSource, resolved, 'html'), mjAttrs)
}

@Injectable()
export class MjmlEngine implements RenderEngine {
  readonly format: RenderFormat = 'mjml'
  readonly outputs: readonly OutputType[] = ['html']

  constructor(private readonly brandIdentity: BrandIdentityService) {}

  async render(req: EngineRenderRequest): Promise<EngineRenderResult> {
    if (req.output !== 'html') {
      return {
        ok: false,
        errors: [
          {
            severity: 'error',
            message: `MjmlEngine output '${req.output}' not supported (html only).`,
          },
        ],
      }
    }

    try {
      const mjAttrs = this.brandIdentity.buildMjmlAttributes(req.brand)
      const composed = composeSource(
        req.source,
        mjAttrs,
        req.values,
        req.fields,
      )
      // mjml2html is async since MJML 5
      const out: MjmlResult = await mjml2html(composed, {
        validationLevel: 'soft',
        keepComments: false,
        ignoreIncludes: true,
      })

      const fatal = out.errors.filter(
        (e) => !/^warning/i.test(e.message ?? ''),
      )
      if (fatal.length > 0) {
        return {
          ok: false,
          errors: fatal.map<CompileError>((e) => ({
            severity: 'error',
            message: e.message,
            line: e.line,
          })),
        }
      }

      const warnings: CompileError[] = out.errors.map((e) => ({
        severity: 'warning',
        message: e.message,
        line: e.line,
      }))

      return {
        ok: true,
        bytes: new TextEncoder().encode(out.html),
        mime: 'text/html; charset=utf-8',
        ...(warnings.length ? { warnings } : {}),
      }
    } catch (err) {
      if (err instanceof TemplateValueError) return { ok: false, errors: [{ severity: 'error', message: err.message, file: 'fields' }] }
      return {
        ok: false,
        errors: [
          {
            severity: 'error',
            message: `mjml compile threw: ${
              err instanceof Error ? err.message : String(err)
            }`,
          },
        ],
      }
    }
  }
}
