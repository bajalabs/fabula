/* WCAG contrast for the colours Fabula draws text on: the brand's own text colour when it reaches 4.5:1, else the
   better of black and white. */

export const BLACK = '#000000'
export const WHITE = '#FFFFFF'
export const MIN_BODY = 4.5

function channels(hex: string): [number, number, number] {
  let h = hex.replace('#', '')
  if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split('').map((c) => c + c).join('')
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number]
}

/** WCAG relative luminance, 0 to 1. Any alpha is ignored. */
export function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrast(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** Rounded down, so a 4.499 never passes as 4.5. */
const floor2 = (n: number): number => Math.floor(n * 100 + 1e-9) / 100

export const meets = (a: string, b: string, minimum = MIN_BODY): boolean => floor2(contrast(a, b)) >= minimum

/** The text colour for `fill`: `candidate` when it meets the minimum, else the better of black and white. */
export function pickText(fill: string, candidate: string | null | undefined): string {
  if (candidate && meets(candidate, fill)) return candidate
  return contrast(WHITE, fill) >= contrast(BLACK, fill) ? WHITE : BLACK
}

/** `t` of the way from `a` to `b`, in sRGB (0 = a, 1 = b). */
export function mix(a: string, b: string, t: number): string {
  const x = channels(a)
  const y = channels(b)
  return `#${x.map((c, i) => Math.round(c + (y[i] - c) * t).toString(16).padStart(2, '0')).join('').toUpperCase()}`
}
