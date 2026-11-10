/* BrandIdentityService: the brand in every engine's prelude.

   Covered: Typst: strings escaped through toTypstLiteral, tokens in brand-colors(-dark) and ahead of the simple
   colours, brand-logo → none when absent, the file's root path when placed, brand-legal for the brand's locale.
   HTML: --brand-<token>, dark tokens as plain variables, @font-face per placed font, the logo variable and class, CSS
   escaping. The on-colours and surfaces the document templates draw with: the brand's own when they reach 4.5:1.
   MJML: the primary token where the primary colour went. Quarto: the _brand.yml for a sample brand, null without one.

   Pure string generation: no engine binary, no network. */

import { describe, expect, it } from 'vitest'
import YAML from 'yaml'
import {
  brandIdentitySchema,
  type BrandIdentity,
} from '../src/contracts/index.js'
import { contrast } from '../src/util/contrast.js'
import { BrandIdentityService, brandOnColor, brandSurfaces } from '../src/render/brand/brand-identity.service.js'
import type { BrandAssets } from '../src/render/brand/brand-assets.service.js'

const SHA_FONT = '1'.repeat(64)
const SHA_FONT_WOFF = '2'.repeat(64)
const SHA_LOGO = '3'.repeat(64)
const SHA_LOGO_DARK = '4'.repeat(64)

const LEGACY = {
  brandName: 'Acme',
  displayName: 'Acme S.A.',
  primaryColor: '#111111',
  secondaryColor: '#222222',
  fontBody: 'Noto Sans',
  fontHeading: 'Noto Serif',
}

function brand(extra: Record<string, unknown> = {}): BrandIdentity {
  return brandIdentitySchema.parse({ ...LEGACY, ...extra })
}

const RECORD = brand({
  tagline: 'Baked every morning',
  locale: 'es-MX',
  colors: [
    { token: 'primary', hex: '#0e7c66' },
    { token: 'on-primary', hex: '#FFFFFF' },
    { token: 'accent-2', hex: '#C5973B' },
    { token: 'foreground', hex: '#1A202C' },
    { token: 'primary', hex: '#3FB89F', mode: 'dark' },
  ],
  fonts: [
    {
      role: 'heading',
      family: 'Inter',
      weight: 700,
      format: 'ttf',
      url: 'https://files.example.com/f.ttf',
      sha256: SHA_FONT,
    },
    {
      role: 'body',
      family: 'Source Sans 3',
      weight: 400,
      format: 'woff2',
      url: 'https://files.example.com/f.woff2',
      sha256: SHA_FONT_WOFF,
    },
    {
      role: 'mono',
      family: 'JetBrains Mono',
      format: 'ttf',
      url: 'https://files.example.com/m.ttf',
      sha256: '5'.repeat(64),
    },
  ],
  logos: [
    {
      variant: 'primary',
      mode: 'light',
      format: 'svg',
      url: 'https://files.example.com/l.svg',
      sha256: SHA_LOGO,
      widthPx: 600,
      heightPx: 200,
    },
    {
      variant: 'primary',
      mode: 'dark',
      format: 'png',
      url: 'https://files.example.com/d.png',
      sha256: SHA_LOGO_DARK,
    },
  ],
  legal: [
    { market: 'US', locale: 'en-US', kind: 'footer', title: 'Footer', markdown: 'Made in Springfield.' },
    { market: 'MX', locale: 'es-MX', kind: 'footer', title: 'Pie', markdown: '**Acme** · "Springfield"\nMain St.' },
    { market: 'MX', locale: 'es', kind: 'privacy', title: 'Aviso', markdown: 'Aviso de privacidad.' },
    { market: 'US', locale: 'en-US', kind: 'terms', title: 'Terms', markdown: 'Terms.' },
  ],
})

/** What BrandAssetsService.place() returns for RECORD (no network). */
const ASSETS: BrandAssets = {
  fonts: [
    { font: RECORD.fonts![0], path: `_shared/fonts/${SHA_FONT}.ttf` },
    { font: RECORD.fonts![1], path: `_shared/fonts/${SHA_FONT_WOFF}.woff2` },
  ],
  logos: [
    { logo: RECORD.logos![0], path: '_shared/logos/primary-light.svg' },
    { logo: RECORD.logos![1], path: '_shared/logos/primary-dark.png' },
  ],
  fontDir: '/tmp/work/_shared/fonts',
}

const svc = new BrandIdentityService()

/** The value of one `#let name = …` line of the Typst prelude. */
function typstLet(typ: string, name: string): string | undefined {
  const m = typ.match(new RegExp(`^#let ${name}\\s*= (.*)$`, 'm'))
  return m?.[1]
}

describe('text on a brand fill ', () => {
  const colors = (...c: Array<[string, string, string?]>) => ({ colors: c.map(([token, hex, role]) => ({ token, hex, role })) })

  it('takes the brand’s on-<token>, then on-<slot>', () => {
    const named = brand(colors(['teal', '#0F5C6B', 'primary'], ['on-teal', '#FFFDF8', 'foreground']))
    expect(brandOnColor(named, 'primary', '#0F5C6B')).toBe('#FFFDF8')
    const slot = brand(colors(['accent', '#143D55'], ['on-accent', '#FFFDF8']))
    expect(brandOnColor(slot, 'accent', '#143D55')).toBe('#FFFDF8')
  })

  it('never takes an on-colour under 4.5:1: the better of black and white stands in', () => {
    const weak = brand(colors(['accent', '#C4572E', 'accent'], ['on-accent', '#FFFFFF']))
    expect(contrast('#FFFFFF', '#C4572E')).toBeLessThan(4.5)
    expect(brandOnColor(weak, 'accent', '#C4572E')).toBe('#000000')
  })

  it('needs no on-colour: a light accent gets black, a dark one white', () => {
    expect(brandOnColor(brand(), 'accent', '#F2C94C')).toBe('#000000')
    expect(brandOnColor(brand(), 'primary', '#143D55')).toBe('#FFFFFF')
  })

  it('is what brand.typ gives, with the logo for that band', () => {
    const light = svc.buildTypst(brand({ primaryColor: '#F2C94C', accentColor: '#143D55' }))
    expect(typstLet(light, 'brand-on-primary')).toBe('rgb("#000000")')
    expect(typstLet(light, 'brand-on-accent')).toBe('rgb("#FFFFFF")')
    expect(typstLet(light, 'brand-primary-logo-mode')).toBe('"light"')
    expect(typstLet(svc.buildTypst(brand({ primaryColor: '#143D55' })), 'brand-primary-logo-mode')).toBe('"dark"')
  })

  it('draws the body text and its quiet tone at 4.5:1 on the page and on the panel', () => {
    const s = brandSurfaces(brand(), '#143D55')
    for (const c of [s.ink, s.muted]) {
      expect(contrast(c, s.tint)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(c, '#FFFFFF')).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('draws titles in the primary colour only where it can be read', () => {
    expect(brandSurfaces(brand(), '#143D55').heading).toBe('#143D55')
    const pale = brandSurfaces(brand(), '#F2C94C')
    expect(pale.heading).toBe(pale.ink)
    expect(typstLet(svc.buildTypst(brand({ primaryColor: '#F2C94C' })), 'brand-heading')).toBe(`rgb("${pale.ink}")`)
  })

  it('takes the record’s own surfaces, and drops a quiet tone too pale to read', () => {
    const named = brand(colors(['tint', '#F4ECDF'], ['ink', '#132A30'], ['muted', '#4E6166'], ['paper', '#FFFDF8']))
    expect(brandSurfaces(named, '#0F5C6B')).toEqual({ ink: '#132A30', muted: '#4E6166', tint: '#F4ECDF', heading: '#0F5C6B' })
    const pale = brand(colors(['ink', '#132A30'], ['muted', '#B0B8BC']))
    expect(brandSurfaces(pale, '#0F5C6B').muted).toBe('#132A30')
  })
})

describe('BrandIdentityService.buildTypst', () => {
  it('keeps every legacy #let name templates use', () => {
    const typ = svc.buildTypst(brand())
    for (const name of [
      'brand-primary',
      'brand-secondary',
      'brand-accent',
      'brand-steel',
      'brand-dim',
      'brand-border',
      'brand-light',
      'font-heading',
      'font-body',
      'font-mono',
      'company',
    ]) {
      expect(typstLet(typ, name), name).toBeDefined()
    }
    expect(typ).toContain('#let money(cents) = {')
    expect(typ).toContain('#let brand-page(doc) = {')
    expect(typ).toContain('#let brand-title(text-content) = {')
    expect(typstLet(typ, 'brand-primary')).toBe('rgb("#111111")')
    expect(typstLet(typ, 'font-heading')).toBe('"Noto Serif"')
  })

  it('escapes a font family carrying a quote and a backslash', () => {
    const typ = svc.buildTypst(brand({ fontHeading: 'Evil "Font\\', fontBody: 'x" + eval("1") + "' }))
    expect(typstLet(typ, 'font-heading')).toBe('"Evil \\"Font\\\\"')
    expect(typstLet(typ, 'font-body')).toBe('"x\\" + eval(\\"1\\") + \\""')
    // No raw interpolation left: each line is one complete string literal
    expect(typ).not.toContain('"Evil "Font')
  })

  it('puts tokens in brand-colors and lets them override the legacy colours', () => {
    const typ = svc.buildTypst(RECORD)
    expect(typ).toContain('"primary": rgb("#0E7C66"),')
    expect(typ).toContain('"on-primary": rgb("#FFFFFF"),')
    expect(typ).toContain('"accent-2": rgb("#C5973B"),')
    expect(typ).toMatch(/#let brand-colors-dark = \(\n {2}"primary": rgb\("#3FB89F"\),\n\)/)
    expect(typstLet(typ, 'brand-primary')).toBe('rgb("#0E7C66")') // token beats primaryColor
    expect(typstLet(typ, 'brand-secondary')).toBe('rgb("#222222")') // no token → legacy
    expect(typstLet(typ, 'brand-accent')).toBe('rgb("#2D6A8E")') // neither → fallback
  })

  it('emits empty dictionaries and none for a legacy brand', () => {
    const typ = svc.buildTypst(brand())
    expect(typstLet(typ, 'brand-colors')).toBe('(:)')
    expect(typstLet(typ, 'brand-colors-dark')).toBe('(:)')
    expect(typstLet(typ, 'brand-legal')).toBe('(:)')
    expect(typstLet(typ, 'brand-logos')).toBe('(:)')
    expect(typstLet(typ, 'brand-tagline')).toBe('none')
  })

  it('brand-logo is none for a missing logo and the placed file otherwise', () => {
    const none = svc.buildTypst(RECORD) // record without placed assets
    expect(typstLet(none, 'brand-logos')).toBe('(:)')
    expect(none).toContain('if path == none { none } else { image(path, ..args) }')

    const typ = svc.buildTypst(RECORD, ASSETS)
    expect(typ).toContain('"primary/light": "/_shared/logos/primary-light.svg",')
    expect(typ).toContain('"primary/dark": "/_shared/logos/primary-dark.png",')
    expect(typ).not.toContain('"mark/light"')
    expect(typ).toContain('#let brand-logo(variant: "primary", mode: "light", ..args) = {')
  })

  it('takes fonts by role from the record, legacy fields for the rest', () => {
    const typ = svc.buildTypst(RECORD)
    expect(typstLet(typ, 'font-heading')).toBe('"Inter"')
    expect(typstLet(typ, 'font-body')).toBe('"Source Sans 3"')
    expect(typstLet(typ, 'font-mono')).toBe('"JetBrains Mono"')
    expect(typstLet(svc.buildTypst(brand()), 'font-mono')).toBe('"Source Code Pro"')
  })

  it('carries the legal blocks of the brand locale, tagline and locale', () => {
    const typ = svc.buildTypst(RECORD)
    expect(typstLet(typ, 'brand-locale')).toBe('"es-MX"')
    expect(typstLet(typ, 'brand-tagline')).toBe('"Baked every morning"')
    expect(typ).toContain('"footer": "**Acme** · \\"Springfield\\"\\nMain St.",')
    expect(typ).toContain('"privacy": "Aviso de privacidad.",') // es block for es-MX
    expect(typ).not.toContain('Made in Springfield.') // the en-US footer
    expect(typ).not.toContain('"terms"') // no Spanish terms → absent, not English
    expect(typ).toContain('"footer": "Pie",')
  })

  it('falls back to the first legal block locale when the request has none', () => {
    const typ = svc.buildTypst({ ...RECORD, locale: undefined })
    expect(typstLet(typ, 'brand-locale')).toBe('"en-US"')
    expect(typ).toContain('"footer": "Made in Springfield.",')
    expect(typ).toContain('"terms": "Terms.",')
  })
})

describe('BrandIdentityService.buildHtml', () => {
  it('keeps the legacy stylesheet for a legacy brand', () => {
    const css = svc.buildHtml(brand({ accentColor: '#333333' }))
    expect(css.startsWith(':root {\n  --brand-primary:   #111111;\n')).toBe(true)
    expect(css).toContain('  --brand-accent:    #333333;\n')
    expect(css).toContain('  --font-body:       "Noto Sans", sans-serif;\n')
    expect(css).toContain('@bottom-left  { content: "Acme S.A.";')
    expect(css).not.toContain('@font-face')
    expect(css).not.toContain('brand-logo')
    expect(css.endsWith('.brand-accent    { color: var(--brand-accent); }\n')).toBe(true)
  })

  it('emits a variable per light token and dark ones without a media query', () => {
    const css = svc.buildHtml(RECORD, ASSETS)
    expect(css).toContain('--brand-primary:   #0E7C66;')
    expect(css).toContain('--brand-on-primary: #FFFFFF;')
    expect(css).toContain('--brand-accent-2:  #C5973B;')
    expect(css).toContain('--brand-dark-primary: #3FB89F;')
    expect(css).not.toContain('prefers-color-scheme')
    expect(css.match(/--brand-primary:/g)).toHaveLength(1)
  })

  it('emits @font-face for each placed font with its format', () => {
    const css = svc.buildHtml(RECORD, ASSETS)
    expect(css).toContain(`@font-face {
  font-family: "Inter";
  src: url("_shared/fonts/${SHA_FONT}.ttf") format("truetype");
  font-weight: 700;
  font-style: normal;
}`)
    expect(css).toContain(`src: url("_shared/fonts/${SHA_FONT_WOFF}.woff2") format("woff2");`)
    expect(css).toContain('--font-heading:    "Inter", sans-serif;')
    expect(css).toContain('--font-mono:       "JetBrains Mono", monospace;')
  })

  it('exposes the primary logo as a variable and a class', () => {
    const css = svc.buildHtml(RECORD, ASSETS)
    expect(css).toContain('--brand-logo:      url("_shared/logos/primary-light.svg");')
    expect(css).toContain('--brand-logo-primary-dark: url("_shared/logos/primary-dark.png");')
    expect(css).toMatch(/\.brand-logo \{[^}]*width: 36mm;[^}]*background-image: url\("_shared\/logos\/primary-light\.svg"\);/)
    expect(css).toContain('.brand-logo-primary-dark {')
  })

  it('escapes strings placed in CSS quotes', () => {
    const css = svc.buildHtml(
      brand({ fontBody: 'Bad"</style><script>x\\', companyLegalName: 'A "B" </style>' }),
    )
    expect(css).toContain('--font-body:       "Bad\\"\\3C /style\\3E \\3C script\\3E x\\\\", sans-serif;')
    expect(css).toContain('content: "A \\"B\\" \\3C /style\\3E ";')
    expect(css).not.toContain('</style>')
  })

  it('refuses a legacy colour that would close the declaration', () => {
    const css = svc.buildHtml(brand({ primaryColor: 'red; } body { display: none' }))
    expect(css).toContain('--brand-primary:   #1B2A4A;')
    expect(css).not.toContain('display: none')
  })
})

describe('BrandIdentityService.buildMjmlAttributes', () => {
  it('uses the primary light token where the primary colour went', () => {
    const mj = svc.buildMjmlAttributes(RECORD)
    expect(mj).toContain('<mj-class name="heading" font-family="Inter, Arial, sans-serif" color="#0E7C66"')
    expect(svc.buildMjmlAttributes(brand())).toContain('color="#111111"')
  })

  it('escapes attribute values', () => {
    const mj = svc.buildMjmlAttributes(brand({ fontBody: 'A" onload="x' }))
    expect(mj).toContain('font-family="A&quot; onload=&quot;x, Arial, sans-serif"')
  })
})

describe('BrandIdentityService.buildQuartoBrand', () => {
  it('is null for a brand without colours, fonts or logos', () => {
    expect(svc.buildQuartoBrand(brand())).toBeNull()
    expect(svc.buildQuartoBrand(brand({ tagline: 'x', legal: RECORD.legal }))).toBeNull()
  })

  it('writes a brand.yml from the record', () => {
    const yml = svc.buildQuartoBrand(RECORD, ASSETS)
    expect(yml).not.toBeNull()
    expect(yml!.startsWith('# Generated by Fabula')).toBe(true)
    expect(YAML.parse(yml!)).toEqual({
      meta: { name: { full: 'Acme S.A.', short: 'Acme' } },
      color: {
        palette: {
          primary: '#0E7C66',
          'on-primary': '#FFFFFF',
          'accent-2': '#C5973B',
          foreground: '#1A202C',
          'primary-dark': '#3FB89F',
        },
        primary: '#0E7C66',
        secondary: '#222222',
        tertiary: '#2D6A8E',
        foreground: '#1A202C',
      },
      typography: {
        fonts: [
          {
            family: 'Inter',
            source: 'file',
            files: [{ path: `_shared/fonts/${SHA_FONT}.ttf`, weight: 700, style: 'normal' }],
          },
          {
            family: 'Source Sans 3',
            source: 'file',
            files: [{ path: `_shared/fonts/${SHA_FONT_WOFF}.woff2`, weight: 400, style: 'normal' }],
          },
          { family: 'JetBrains Mono', source: 'system' },
        ],
        base: { family: 'Source Sans 3' },
        headings: { family: 'Inter', color: '#0E7C66' },
        monospace: { family: 'JetBrains Mono' },
      },
      logo: {
        images: {
          'primary-light': '_shared/logos/primary-light.svg',
          'primary-dark': '_shared/logos/primary-dark.png',
        },
        small: { light: 'primary-light', dark: 'primary-dark' },
        medium: { light: 'primary-light', dark: 'primary-dark' },
        large: { light: 'primary-light', dark: 'primary-dark' },
      },
    })
  })

  it('quotes names YAML would otherwise misread', () => {
    const yml = svc.buildQuartoBrand(
      brand({ fontBody: 'yes', displayName: 'Acme: #1', colors: [{ token: 'primary', hex: '#000000' }] }),
    )
    const doc = YAML.parse(yml!)
    expect(doc.typography.base.family).toBe('yes')
    expect(doc.meta.name.full).toBe('Acme: #1')
  })
})
