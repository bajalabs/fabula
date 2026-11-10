/* brandIdentitySchema: the simple shape and the full one validate; hex is upper-cased and defaults filled; https
   only, lower-case 64-hex sha256, #RRGGBB hex; the list limits (64 colours, 24 fonts, 16 logos, 32 legal blocks); the
   render request carries the brand through. */

import { describe, expect, it } from 'vitest'
import {
  BRAND_LIMITS,
  brandIdentitySchema,
  renderRequestSchema,
} from '../src/contracts/index.js'

const SHA = 'a'.repeat(64)

/** The simple shape: names, three colours, two fonts, the company lines. */
const LEGACY = {
  brandName: 'Acme',
  displayName: 'Acme S.A.',
  primaryColor: '#1B2A4A',
  secondaryColor: '#C5973B',
  accentColor: '#2D6A8E',
  fontBody: 'Noto Sans',
  fontHeading: 'Noto Serif',
  companyLegalName: 'Acme Bakery LLC',
  companyTaxId: '00-0000000',
  companyAddress: null,
  companyEmail: 'hello@example.com',
  companyPhone: null,
  companyWebsite: 'https://example.com',
}

const RECORD = {
  ...LEGACY,
  tagline: 'Baked every morning',
  locale: 'es-MX',
  colors: [
    { token: 'primary', hex: '#0e7c66', role: 'brand', mode: 'light' },
    { token: 'on-primary', hex: '#FFFFFF', mode: 'light' },
    { token: 'accent-2', hex: '#C5973B' },
    { token: 'primary', hex: '#3FB89F', mode: 'dark' },
  ],
  fonts: [
    {
      role: 'heading',
      family: 'Inter',
      weight: 700,
      style: 'normal',
      format: 'woff2',
      url: 'https://files.example.com/fonts/inter-700.woff2?X-Amz-Signature=abc',
      sha256: SHA,
    },
  ],
  logos: [
    {
      variant: 'primary',
      mode: 'light',
      format: 'svg',
      url: 'https://files.example.com/logos/primary.svg?X-Amz-Signature=abc',
      sha256: SHA,
      widthPx: 600,
      heightPx: 200,
      clearSpaceRatio: 0.25,
      minWidthPx: 80,
      backgroundHex: '#ffffff',
    },
  ],
  legal: [
    {
      market: 'MX',
      locale: 'es-MX',
      kind: 'footer',
      title: 'Pie',
      markdown: '**Acme** · Springfield',
    },
  ],
}

describe('brandIdentitySchema', () => {
  it('accepts the legacy shape unchanged', () => {
    expect(brandIdentitySchema.parse(LEGACY)).toEqual(LEGACY)
  })

  it('needs no field at all: an empty brand renders with neutral colours and the Noto fonts', () => {
    expect(brandIdentitySchema.parse({})).toEqual({ brandName: '', displayName: '', fontBody: 'Noto Sans', fontHeading: 'Noto Sans' })
  })

  it('accepts the full brand record and normalises it', () => {
    const parsed = brandIdentitySchema.parse(RECORD)
    expect(parsed.colors?.[0]?.hex).toBe('#0E7C66')
    expect(parsed.colors?.[2]?.mode).toBe('light') // default
    expect(parsed.logos?.[0]?.backgroundHex).toBe('#FFFFFF')
    expect(parsed.fonts?.[0]?.family).toBe('Inter')
    expect(parsed.legal?.[0]?.kind).toBe('footer')
  })

  it('fills font weight and style, and logo mode, when absent', () => {
    const { weight: _w, style: _s, ...font } = RECORD.fonts[0]
    const { mode: _m, ...logo } = RECORD.logos[0]
    const parsed = brandIdentitySchema.parse({ ...LEGACY, fonts: [font], logos: [logo] })
    expect(parsed.fonts?.[0]).toMatchObject({ weight: 400, style: 'normal' })
    expect(parsed.logos?.[0]?.mode).toBe('light')
  })

  it('rejects an http asset URL', () => {
    const bad = {
      ...RECORD,
      fonts: [{ ...RECORD.fonts[0], url: 'http://files.example.com/fonts/inter.woff2' }],
    }
    expect(brandIdentitySchema.safeParse(bad).success).toBe(false)
    const badLogo = {
      ...RECORD,
      logos: [{ ...RECORD.logos[0], url: 'file:///etc/passwd' }],
    }
    expect(brandIdentitySchema.safeParse(badLogo).success).toBe(false)
  })

  it('rejects a sha256 that is short, upper-case or not hex', () => {
    for (const sha256 of ['a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64)]) {
      const bad = { ...RECORD, logos: [{ ...RECORD.logos[0], sha256 }] }
      expect(brandIdentitySchema.safeParse(bad).success).toBe(false)
    }
  })

  it('rejects a colour that is not #RRGGBB', () => {
    for (const hex of ['#12345', '#1234567', 'red', '0E7C66', '#GGGGGG']) {
      const bad = { ...RECORD, colors: [{ token: 'primary', hex }] }
      expect(brandIdentitySchema.safeParse(bad).success).toBe(false)
    }
  })

  it('rejects a token that could not be a CSS or Typst key', () => {
    for (const token of ['', '1st', 'on primary', 'x"y', 'a;b']) {
      const bad = { ...RECORD, colors: [{ token, hex: '#000000' }] }
      expect(brandIdentitySchema.safeParse(bad).success).toBe(false)
    }
  })

  it('caps the arrays', () => {
    const colors = Array.from({ length: BRAND_LIMITS.colors + 1 }, (_, i) => ({
      token: `c${i}`,
      hex: '#000000',
    }))
    expect(brandIdentitySchema.safeParse({ ...LEGACY, colors }).success).toBe(false)
    expect(
      brandIdentitySchema.safeParse({ ...LEGACY, colors: colors.slice(0, BRAND_LIMITS.colors) })
        .success,
    ).toBe(true)
    const logos = Array.from({ length: BRAND_LIMITS.logos + 1 }, () => RECORD.logos[0])
    expect(brandIdentitySchema.safeParse({ ...LEGACY, logos }).success).toBe(false)
  })

  it('travels inside a render request', () => {
    const req = renderRequestSchema.parse({ format: 'typst', source: '= Hello', brand: RECORD })
    expect(req.brand.colors).toHaveLength(4)
    expect(req.brand.tagline).toBe('Baked every morning')
  })
})
