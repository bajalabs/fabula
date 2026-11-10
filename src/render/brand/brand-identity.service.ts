/* BrandIdentityService: the brand, per engine. buildTypst() writes _shared/brand.typ (every #let name a template
   can use), buildHtml() the WeasyPrint stylesheet, buildMjmlAttributes() the MJML defaults, buildQuartoBrand() the
   project's _brand.yml.

   The brand's lists (colour tokens, font files, logo files, legal blocks) win over the simple fields where both say
   the same thing (a `primary` token over primaryColor, a `heading` font over fontHeading). Every caller string
   reaching Typst goes through toTypstLiteral, every one reaching CSS through cssString, so a quote or a backslash
   cannot break out. */

import { Injectable } from '@nestjs/common'
import YAML from 'yaml'
import type {
  BrandFontRole,
  BrandIdentity,
  BrandLegal,
  BrandLegalKind,
  BrandLogo,
  BrandLogoVariant,
} from '../../contracts/index.js'
import { WHITE, luminance, meets, mix, pickText } from '../../util/contrast.js'
import { toTypstLiteral } from '../../util/typst-literal.js'
import { NO_BRAND_ASSETS, type BrandAssets, type PlacedLogo } from './brand-assets.service.js'

const FALLBACK_PRIMARY = '#1B2A4A'
const FALLBACK_SECONDARY = '#C5973B'
const FALLBACK_ACCENT = '#2D6A8E'

const FONT_ROLES: readonly BrandFontRole[] = ['heading', 'body', 'mono', 'display', 'accent']

const CSS_FONT_FORMAT: Record<string, string> = {
  woff2: 'woff2',
  woff: 'woff',
  ttf: 'truetype',
  otf: 'opentype',
}

// ── Resolution shared by every engine ──────────────────────────────

/** Tokens of one mode in record order; the first entry of a token wins. */
export function brandColorTokens(
  brand: BrandIdentity,
  mode: 'light' | 'dark',
): Map<string, string> {
  const out = new Map<string, string>()
  for (const c of brand.colors ?? []) {
    if (c.mode === mode && !out.has(c.token)) out.set(c.token, c.hex.toUpperCase())
  }
  return out
}

/** Font families by role: the record's first font of a role, the
 *  legacy fontHeading / fontBody for those two when the record has none. */
export function brandFamilies(brand: BrandIdentity): Partial<Record<BrandFontRole, string>> & {
  heading: string
  body: string
} {
  const byRole: Partial<Record<BrandFontRole, string>> = {}
  for (const f of brand.fonts ?? []) {
    if (!byRole[f.role]) byRole[f.role] = f.family
  }
  return {
    ...byRole,
    heading: byRole.heading ?? brand.fontHeading,
    body: byRole.body ?? brand.fontBody,
  }
}

/** Legal blocks for one locale: the request's `locale` when given,
 *  else the first block's. Per kind, an exact locale match first, then
 *  the same language (es-MX for es); never another language. */
export function brandLegalFor(brand: BrandIdentity): {
  locale: string | null
  blocks: Map<BrandLegalKind, BrandLegal>
} {
  const legal = brand.legal ?? []
  const locale = brand.locale ?? legal[0]?.locale ?? null
  const blocks = new Map<BrandLegalKind, BrandLegal>()
  if (!locale) return { locale, blocks }
  const lang = locale.split('-')[0].toLowerCase()
  const exact = legal.filter((l) => l.locale.toLowerCase() === locale.toLowerCase())
  const sameLang = legal.filter((l) => l.locale.split('-')[0].toLowerCase() === lang)
  for (const l of [...exact, ...sameLang]) {
    if (!blocks.has(l.kind)) blocks.set(l.kind, l)
  }
  return { locale, blocks }
}

/** A caller's colour as Typst takes it, else the fallback. */
function typstHex(c: string | null | undefined, fb: string): string {
  const v = (c ?? '').trim()
  return /^#[0-9a-fA-F]{3,8}$/.test(v) ? v : fb
}

/** The three legacy colour slots, from the light tokens first. */
function resolveBrandColors(brand: BrandIdentity, legacy: (c: string | null | undefined, fb: string) => string) {
  const light = brandColorTokens(brand, 'light')
  return {
    primary: light.get('primary') ?? legacy(brand.primaryColor, FALLBACK_PRIMARY),
    secondary: light.get('secondary') ?? legacy(brand.secondaryColor, FALLBACK_SECONDARY),
    accent: light.get('accent') ?? legacy(brand.accentColor ?? null, FALLBACK_ACCENT),
  }
}

/** A slot of the record's light colours: the first of `names`, else the first colour of `role` that is not an `on-` token. */
function findColor(brand: BrandIdentity, names: readonly string[], role?: string) {
  const light = (brand.colors ?? []).filter((c) => c.mode === 'light')
  for (const name of names) {
    const hit = light.find((c) => c.token === name)
    if (hit) return hit
  }
  return role ? light.find((c) => c.role === role && !c.token.startsWith('on-')) : undefined
}

/** Text on a brand fill: the brand's `on-<token>`, else `on-<slot>`, when it reaches 4.5:1 on the fill;
 *  else the better of black and white. */
export function brandOnColor(brand: BrandIdentity, slot: 'primary' | 'accent', fill: string): string {
  const own = findColor(brand, [slot], slot)
  const names = [...(own ? [`on-${own.token}`] : []), `on-${slot}`]
  return pickText(fill, findColor(brand, names)?.hex)
}

/** The body text, its quieter tone and the pale panel behind cards. Named by the brand's colour tokens, or made
 *  from the brand's colours; the text stays at 4.5:1 on both the page and the panel. */
export function brandSurfaces(brand: BrandIdentity, primary: string): { ink: string; muted: string; tint: string; heading: string } {
  const paper = findColor(brand, ['background', 'bg', 'paper', 'canvas', 'page'], 'background')?.hex ?? WHITE
  const tint = findColor(brand, ['tint', 'surface', 'card', 'panel'])?.hex ?? mix(primary, WHITE, 0.92)
  const ink = pickText(paper, findColor(brand, ['foreground', 'fg', 'text', 'ink'], 'foreground')?.hex ?? '#1A202C')
  const safeInk = meets(ink, tint) ? ink : pickText(tint, ink)
  const muted = findColor(brand, ['muted-foreground', 'text-muted', 'muted'])?.hex ?? mix(safeInk, paper, 0.3)
  return {
    ink: safeInk,
    muted: meets(muted, paper) && meets(muted, tint) ? muted : safeInk,
    tint,
    // Titles are the primary colour, unless it is too pale to read on the page or the panel
    heading: meets(primary, paper) && meets(primary, tint) ? primary : safeInk,
  }
}

/** The logo a band of the primary colour needs: light text on the band means the logo made for dark backgrounds. */
export function brandPrimaryLogoMode(brand: BrandIdentity): 'light' | 'dark' {
  const { primary } = resolveBrandColors(brand, typstHex)
  return luminance(brandOnColor(brand, 'primary', primary)) > 0.5 ? 'dark' : 'light'
}

/** Word's and PowerPoint's theme for a brand: the accents from its colours, the heading and body families as
 *  the theme's major and minor Latin typefaces. Six hex digits without '#', as the theme part wants them. */
export function brandOfficeTheme(brand: BrandIdentity): {
  colors: Record<string, string>
  fonts: { major: string; minor: string }
} {
  const six = (c: string | null | undefined, fb: string): string => {
    const v = (c ?? '').trim()
    if (/^#[0-9a-fA-F]{6}$/.test(v)) return v
    if (/^#[0-9a-fA-F]{3}$/.test(v)) return `#${v.slice(1).split('').map((x) => x + x).join('')}`
    return fb
  }
  const { primary, secondary, accent } = resolveBrandColors(brand, six)
  const light = brandColorTokens(brand, 'light')
  const colors: Record<string, string> = { accent1: primary, accent2: secondary, accent3: accent, hlink: accent }
  const extra: Array<[string, string]> = [['accent4', 'accent-2'], ['accent5', 'accent-3'], ['accent6', 'accent-4'], ['dk2', 'neutral-dark'], ['lt2', 'neutral-light']]
  for (const [slot, token] of extra) {
    const v = light.get(token)
    if (v) colors[slot] = v
  }
  const families = brandFamilies(brand)
  return {
    colors: Object.fromEntries(Object.entries(colors).map(([k, v]) => [k, v.replace('#', '').toUpperCase()])),
    fonts: { major: families.heading, minor: families.body },
  }
}

function hasBrandRecord(brand: BrandIdentity): boolean {
  return Boolean(brand.colors?.length || brand.fonts?.length || brand.logos?.length)
}

// ── Escaping ───────────────────────────────────────────────────────

/** A CSS string literal, quotes included. Escapes the quote, the
 *  backslash, line breaks and angle brackets (the sheet sits inside a
 *  <style> element, so `</style>` must not survive). */
export function cssString(s: string): string {
  const body = s
    .replace(/[\u0000-\u0008\u000B\u000E-\u001F\u007F]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r\n|[\n\r\f]/g, '\\A ')
    .replace(/</g, '\\3C ')
    .replace(/>/g, '\\3E ')
  return `"${body}"`
}

/** A caller colour for CSS: hex, rgb()/hsl() or a name pass; anything
 *  that could close the declaration falls back. */
function cssColor(c: string | null | undefined, fb: string): string {
  const v = (c ?? '').trim()
  return v && /^[#a-zA-Z0-9(),.%\s-]+$/.test(v) ? v : fb
}

/** An XML attribute value (MJML), without the quotes. */
function xmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** A Typst dictionary literal with string keys; values are Typst code. */
function typstDict(entries: ReadonlyArray<readonly [string, string]>): string {
  if (entries.length === 0) return '(:)'
  return '(\n' + entries.map(([k, v]) => `  ${toTypstLiteral(k)}: ${v},`).join('\n') + '\n)'
}

/** Logo picked for a slot: the first variant in `variants` that has a
 *  file in `mode`. */
function findLogo(
  logos: readonly PlacedLogo[],
  variants: readonly BrandLogoVariant[],
  mode: BrandLogo['mode'],
): PlacedLogo | undefined {
  for (const v of variants) {
    const hit = logos.find((l) => l.logo.variant === v && l.logo.mode === mode)
    if (hit) return hit
  }
  return undefined
}

@Injectable()
export class BrandIdentityService {
  buildTypst(brand: BrandIdentity, assets: BrandAssets = NO_BRAND_ASSETS): string {
    const { primary, secondary, accent } = resolveBrandColors(brand, typstHex)
    const rgb = (h: string) => `rgb(${toTypstLiteral(h)})`
    const surfaces = brandSurfaces(brand, primary)
    const colorsLight = Array.from(brandColorTokens(brand, 'light'), ([k, v]) => [k, rgb(v)] as const)
    const colorsDark = Array.from(brandColorTokens(brand, 'dark'), ([k, v]) => [k, rgb(v)] as const)

    const families = brandFamilies(brand)
    const fontsByRole = FONT_ROLES.flatMap((r) => {
      const fam = families[r]
      return fam ? [[r, toTypstLiteral(fam)] as const] : []
    })

    const company = {
      name: brand.companyLegalName ?? brand.displayName,
      short: brand.brandName,
      'tax-id': brand.companyTaxId ?? '',
      address: brand.companyAddress ?? '',
      email: brand.companyEmail ?? '',
      phone: brand.companyPhone ?? '',
      website: brand.companyWebsite ?? '',
    }

    const legal = brandLegalFor(brand)
    const legalText = Array.from(legal.blocks, ([k, l]) => [k, toTypstLiteral(l.markdown)] as const)
    const legalTitles = Array.from(legal.blocks, ([k, l]) => [k, toTypstLiteral(l.title ?? '')] as const)

    // Root-anchored ("/_shared/…") so the path resolves the same from
    // brand.typ, from the template, and from Pandoc's or Quarto's
    // intermediate .typ in the work directory.
    const logoPaths = assets.logos.map(
      (l) => [`${l.logo.variant}/${l.logo.mode}`, toTypstLiteral(`/${l.path}`)] as const,
    )

    return `// ═══════════════════════════════════════════════════════
// Brand identity, generated by Fabula from the request's brand at render time
// ═══════════════════════════════════════════════════════

#let brand-primary   = ${rgb(primary)}
#let brand-secondary = ${rgb(secondary)}
#let brand-accent    = ${rgb(accent)}
#let brand-steel     = rgb("#4A5568")
#let brand-dim       = rgb("#718096")
#let brand-border    = rgb("#CBD5E0")
#let brand-light     = rgb("#F7F8FA")

// Text on the brand's fills, at 4.5:1 or better; the body text, its quieter tone, the pale panel
#let brand-on-primary = ${rgb(brandOnColor(brand, 'primary', primary))}
#let brand-on-accent  = ${rgb(brandOnColor(brand, 'accent', accent))}
#let brand-ink        = ${rgb(surfaces.ink)}
#let brand-muted      = ${rgb(surfaces.muted)}
#let brand-tint       = ${rgb(surfaces.tint)}
#let brand-heading    = ${rgb(surfaces.heading)}
// The logo mode for a band of brand-primary: light text on it means the logo for dark backgrounds
#let brand-primary-logo-mode = ${toTypstLiteral(brandPrimaryLogoMode(brand))}

// Colour tokens from the brand record, keys as given (light, dark)
#let brand-colors      = ${typstDict(colorsLight)}
#let brand-colors-dark = ${typstDict(colorsDark)}

#let font-heading = ${toTypstLiteral(families.heading)}
#let font-body    = ${toTypstLiteral(families.body)}
#let font-mono    = ${toTypstLiteral(families.mono ?? 'Source Code Pro')}
#let brand-fonts  = ${typstDict(fontsByRole)}

#let company = ${toTypstLiteral(company)}

#let brand-tagline = ${toTypstLiteral(brand.tagline ?? null)}
#let brand-locale  = ${toTypstLiteral(legal.locale)}

// Legal blocks for brand-locale: kind → Markdown text, kind → title
#let brand-legal        = ${typstDict(legalText)}
#let brand-legal-titles = ${typstDict(legalTitles)}

// ── Logos (files Fabula placed in _shared/logos) ─────────────
// brand-logo(variant: "mark", mode: "dark", height: 12mm) → image or none
#let brand-logos = ${typstDict(logoPaths)}
#let brand-logo(variant: "primary", mode: "light", ..args) = {
  let path = brand-logos.at(variant + "/" + mode, default: none)
  if path == none { none } else { image(path, ..args) }
}

// ── Money formatter (integer cents → "$1,234.56") ──────────
#let money(cents) = {
  let int-part = calc.floor(cents / 100)
  let frac = calc.rem(cents, 100)
  let sign = if cents < 0 { "-" } else { "" }
  let abs-int = calc.abs(int-part)
  let s = str(abs-int)
  let grouped = ""
  let i = 0
  for ch in s.clusters().rev() {
    if i > 0 and calc.rem(i, 3) == 0 { grouped = "," + grouped }
    grouped = ch + grouped
    i += 1
  }
  sign + "$" + grouped + "." + (if frac < 10 { "0" + str(frac) } else { str(frac) })
}

// ── Page chrome ─────────────────────────────────────────────
#let brand-page(doc) = {
  set page(paper: "a4", margin: (x: 2cm, y: 2cm))
  set text(font: font-body, size: 10pt, fill: rgb("#1A202C"))
  set par(justify: true, leading: 0.65em)
  show heading.where(level: 1): it => {
    set text(font: font-heading, size: 16pt, weight: "bold", fill: brand-primary)
    block(below: 10pt, it.body)
  }
  show heading.where(level: 2): it => {
    set text(font: font-heading, size: 12pt, weight: "bold", fill: brand-accent)
    block(above: 14pt, below: 6pt, it.body)
  }
  set page(header: context {
    if counter(page).get().first() > 1 [
      #set text(size: 8pt, fill: brand-steel)
      #grid(columns: (1fr, auto), [#company.short], [#counter(page).display()])
      #line(length: 100%, stroke: 0.5pt + brand-border)
    ]
  })
  set page(footer: context [
    #set text(size: 7pt, fill: brand-dim)
    #line(length: 100%, stroke: 0.5pt + brand-border)
    #grid(columns: (1fr, 1fr, auto),
      [#company.name],
      align(center)[#company.at("tax-id")],
      align(right)[#counter(page).display("1 / 1", both: true)])
  ])
  doc
}

#let brand-title(text-content) = {
  align(center)[
    #text(font: font-heading, size: 20pt, weight: "bold", fill: brand-primary)[#text-content]
  ]
  v(6pt)
  align(center)[
    #text(size: 9pt, fill: brand-dim, style: "italic")[#company.name]
  ]
  v(16pt)
}
`
  }

  /**
   * CSS custom properties + print-ready paged-media defaults for
   * WeasyPrintEngine. Templates author their HTML against these
   * variables, so the stylesheet is the sole brand surface.
   *
   * The record adds `--brand-<token>` for each light token (a token
   * named like a fixed variable replaces it), `--brand-dark-<token>`
   * for each dark one — plain variables, never a prefers-color-scheme
   * query, so print stays light — an @font-face per placed font, and
   * `--brand-logo` / `.brand-logo` (primary, light) plus one variable
   * and class per placed logo.
   */
  buildHtml(brand: BrandIdentity, assets: BrandAssets = NO_BRAND_ASSETS): string {
    const { primary, secondary, accent } = resolveBrandColors(brand, cssColor)
    const families = brandFamilies(brand)

    const vars = new Map<string, string>([
      ['--brand-primary', primary],
      ['--brand-secondary', secondary],
      ['--brand-accent', accent],
      ['--brand-text', '#1A202C'],
      ['--brand-steel', '#4A5568'],
      ['--brand-dim', '#718096'],
      ['--brand-border', '#CBD5E0'],
      ['--brand-light', '#F7F8FA'],
      ['--font-body', `${cssString(families.body)}, sans-serif`],
      ['--font-heading', `${cssString(families.heading)}, sans-serif`],
    ])
    if (families.mono) vars.set('--font-mono', `${cssString(families.mono)}, monospace`)
    if (families.display) vars.set('--font-display', `${cssString(families.display)}, sans-serif`)
    if (families.accent) vars.set('--font-accent', `${cssString(families.accent)}, sans-serif`)
    for (const [token, hex] of brandColorTokens(brand, 'light')) vars.set(`--brand-${token}`, hex)
    for (const [token, hex] of brandColorTokens(brand, 'dark')) vars.set(`--brand-dark-${token}`, hex)
    if (brand.tagline) vars.set('--brand-tagline', cssString(brand.tagline))

    const primaryLogo = findLogo(assets.logos, ['primary'], 'light')
    if (primaryLogo) vars.set('--brand-logo', `url(${cssString(primaryLogo.path)})`)
    for (const l of assets.logos) {
      vars.set(`--brand-logo-${l.logo.variant}-${l.logo.mode}`, `url(${cssString(l.path)})`)
    }

    const rootBody = Array.from(vars, ([k, v]) => `  ${`${k}:`.padEnd(Math.max(19, k.length + 2))}${v};`).join('\n')

    const fontFaces = assets.fonts
      .map(
        ({ font, path }) => `@font-face {
  font-family: ${cssString(font.family)};
  src: url(${cssString(path)}) format("${CSS_FONT_FORMAT[font.format]}");
  font-weight: ${font.weight};
  font-style: ${font.style};
}
`,
      )
      .join('\n')

    const logoClass = (name: string, l: PlacedLogo) => {
      // 12 mm tall by default; the width follows the file's ratio when known
      const ratio = l.logo.widthPx && l.logo.heightPx ? l.logo.widthPx / l.logo.heightPx : 3
      return `.${name} {
  display: inline-block;
  height: 12mm;
  width: ${Math.round(12 * ratio * 100) / 100}mm;
  background-image: url(${cssString(l.path)});
  background-repeat: no-repeat;
  background-position: left center;
  background-size: contain;
}
`
    }
    const logoClasses = [
      ...(primaryLogo ? [logoClass('brand-logo', primaryLogo)] : []),
      ...assets.logos.map((l) => logoClass(`brand-logo-${l.logo.variant}-${l.logo.mode}`, l)),
    ].join('\n')

    return `${fontFaces ? fontFaces + '\n' : ''}:root {
${rootBody}
}

/* Paged-media (WeasyPrint honours these; browser preview ignores) */
@page {
  size: A4;
  margin: 20mm;
  @bottom-left  { content: ${cssString(brand.companyLegalName ?? brand.displayName)}; color: var(--brand-dim); font-size: 8pt; }
  @bottom-right { content: counter(page) " / " counter(pages);          color: var(--brand-dim); font-size: 8pt; }
}

html, body { font-family: var(--font-body); color: var(--brand-text); font-size: 11pt; line-height: 1.55; }
h1, h2, h3, h4 { font-family: var(--font-heading); color: var(--brand-primary); }
h1 { font-size: 22pt; margin: 0 0 8pt; }
h2 { font-size: 16pt; margin: 16pt 0 6pt; color: var(--brand-accent); }
a  { color: var(--brand-accent); }
hr { border: 0; border-top: 0.5pt solid var(--brand-border); margin: 12pt 0; }
table { width: 100%; border-collapse: collapse; font-size: 10pt; }
table th, table td { padding: 6pt 8pt; border-bottom: 0.5pt solid var(--brand-border); }
table th { text-align: left; color: var(--brand-steel); font-weight: 600; }
.brand-primary   { color: var(--brand-primary); }
.brand-secondary { color: var(--brand-secondary); }
.brand-accent    { color: var(--brand-accent); }
${logoClasses ? '\n' + logoClasses : ''}`
  }

  /**
   * MJML <mj-attributes> block — brand defaults every template can
   * inherit via mj-all + per-component attributes. Authors drop this
   * inside <mj-head> via an include the MjmlEngine injects. Email
   * clients cannot load Fabula's files, so only families and colours
   * from the record reach it.
   */
  buildMjmlAttributes(brand: BrandIdentity): string {
    const legacy = (c: string | null | undefined, fb: string) => c || fb
    const { primary, accent } = resolveBrandColors(brand, legacy)
    const families = brandFamilies(brand)
    const body = xmlAttr(families.body)
    const heading = xmlAttr(families.heading)
    return `<mj-attributes>
  <mj-all font-family="${body}, Arial, sans-serif" color="#1A202C" />
  <mj-text font-size="14px" line-height="22px" />
  <mj-class name="heading" font-family="${heading}, Arial, sans-serif" color="${xmlAttr(primary)}" font-weight="700" font-size="22px" />
  <mj-class name="subheading" font-family="${heading}, Arial, sans-serif" color="${xmlAttr(accent)}" font-weight="600" font-size="16px" />
  <mj-class name="dim" color="#718096" font-size="12px" />
  <mj-button background-color="${xmlAttr(accent)}" color="#FFFFFF" border-radius="4px" />
  <mj-divider border-color="#CBD5E0" border-width="1px" />
</mj-attributes>`
  }

  /**
   * Quarto's _brand.yml (brand.yml schema) for the project directory,
   * or null when the request carries no colours, fonts or logos — the
   * project then renders exactly as before.
   *
   *   color.palette     every light token; dark ones as <token>-dark
   *   color.<theme>     primary/secondary/tertiary from the resolved
   *                     slots, the other theme names from same-named tokens
   *   typography.fonts  `source: file` per family with placed files,
   *                     `source: system` for a family without (no lookup)
   *   logo              images <variant>-<mode>; small ← mark,
   *                     medium ← horizontal, large ← primary (light/dark)
   */
  buildQuartoBrand(brand: BrandIdentity, assets: BrandAssets = NO_BRAND_ASSETS): string | null {
    if (!hasBrandRecord(brand)) return null
    const light = brandColorTokens(brand, 'light')
    const dark = brandColorTokens(brand, 'dark')
    const hex = (c: string | null | undefined, fb: string) =>
      /^#[0-9a-fA-F]{6}$/.test((c ?? '').trim()) ? (c ?? '').trim().toUpperCase() : fb
    const { primary, secondary, accent } = resolveBrandColors(brand, hex)

    const palette: Record<string, string> = {}
    for (const [k, v] of light) palette[k] = v
    for (const [k, v] of dark) if (!(`${k}-dark` in palette)) palette[`${k}-dark`] = v

    const color: Record<string, unknown> = { palette, primary, secondary, tertiary: accent }
    for (const name of ['foreground', 'background', 'success', 'info', 'warning', 'danger', 'light', 'dark']) {
      const v = light.get(name)
      if (v) color[name] = v
    }

    const meta: Record<string, unknown> = {
      name: { full: brand.companyLegalName ?? brand.displayName, short: brand.brandName },
    }
    if (brand.companyWebsite && /^https?:\/\//i.test(brand.companyWebsite)) meta.link = brand.companyWebsite

    const families = brandFamilies(brand)
    const filesByFamily = new Map<string, Array<{ path: string; weight: number; style: string }>>()
    for (const { font, path } of assets.fonts) {
      const list = filesByFamily.get(font.family) ?? []
      list.push({ path, weight: font.weight, style: font.style })
      filesByFamily.set(font.family, list)
    }
    const fonts: Array<Record<string, unknown>> = Array.from(filesByFamily, ([family, files]) => ({
      family,
      source: 'file',
      files,
    }))
    for (const family of new Set([families.body, families.heading, families.mono].filter(Boolean) as string[])) {
      if (!filesByFamily.has(family)) fonts.push({ family, source: 'system' })
    }
    const typography: Record<string, unknown> = {
      fonts,
      base: { family: families.body },
      headings: { family: families.heading, color: primary },
    }
    if (families.mono) typography.monospace = { family: families.mono }

    const doc: Record<string, unknown> = { meta, color, typography }

    const usable = assets.logos.filter((l) => l.logo.format !== 'pdf')
    if (usable.length) {
      const images: Record<string, string> = {}
      for (const l of usable) images[`${l.logo.variant}-${l.logo.mode}`] = l.path
      const slot = (variants: readonly BrandLogoVariant[]) => {
        const lightLogo = findLogo(usable, variants, 'light')
        const darkLogo = findLogo(usable, variants, 'dark')
        const name = (l: PlacedLogo) => `${l.logo.variant}-${l.logo.mode}`
        if (lightLogo && darkLogo) return { light: name(lightLogo), dark: name(darkLogo) }
        const only = lightLogo ?? darkLogo
        return only ? name(only) : undefined
      }
      const logo: Record<string, unknown> = { images }
      const small = slot(['mark', 'primary'])
      const medium = slot(['horizontal', 'primary', 'wordmark'])
      const large = slot(['primary', 'stacked', 'horizontal'])
      if (small) logo.small = small
      if (medium) logo.medium = medium
      if (large) logo.large = large
      doc.logo = logo
    }

    return '# Generated by Fabula from the brand record at render time\n' + YAML.stringify(doc)
  }
}
