/* Word and PowerPoint per brand: the brand's Office theme, and scripts/office-theme.py writing it into a reference
   document. The script is run for real with the system's python3 on a small zip built here: a [Content_Types].xml, a
   theme part shaped like Pandoc's (accent1, hlink, major and minor Latin fonts with a panose) and one other part,
   which must come back byte for byte. */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { brandIdentitySchema } from '../src/contracts/index.js'
import { brandOfficeTheme } from '../src/render/brand/brand-identity.service.js'

const LEGACY = { brandName: 'B', displayName: 'Acme',
  primaryColor: '#0e7c66', secondaryColor: '#abc', fontBody: 'Noto Sans', fontHeading: 'Noto Serif',
}

describe('brandOfficeTheme', () => {
  it('takes the legacy colours, six digits, upper case, without #', () => {
    const t = brandOfficeTheme(brandIdentitySchema.parse(LEGACY))
    expect(t.colors).toMatchObject({ accent1: '0E7C66', accent2: 'AABBCC', accent3: '2D6A8E', hlink: '2D6A8E' })
    expect(t.fonts).toEqual({ major: 'Noto Serif', minor: 'Noto Sans' })
  })

  it("takes the record's tokens and fonts over the legacy fields", () => {
    const t = brandOfficeTheme(brandIdentitySchema.parse({
      ...LEGACY,
      colors: [
        { token: 'primary', hex: '#123456', mode: 'light' },
        { token: 'accent-2', hex: '#D9822B', mode: 'light' },
        { token: 'neutral-dark', hex: '#1A202C', mode: 'light' },
        { token: 'primary', hex: '#FFFFFF', mode: 'dark' },
      ],
      fonts: [{ role: 'heading', family: 'Alfa Slab One', format: 'ttf', url: 'https://x.example/a.ttf', sha256: 'a'.repeat(64) }],
    }))
    expect(t.colors).toMatchObject({ accent1: '123456', accent4: 'D9822B', dk2: '1A202C' })
    expect(t.fonts.major).toBe('Alfa Slab One')
  })
})

describe('scripts/office-theme.py', () => {
  const script = resolve(process.cwd(), 'scripts', 'office-theme.py')
  const dir = mkdtempSync(join(tmpdir(), 'fabula-office-spec-'))
  const THEME = '<a:theme xmlns:a="x"><a:themeElements><a:clrScheme name="O"><a:accent1>\n<a:srgbClr val="156082"/>\n</a:accent1>'
    + '<a:hlink><a:srgbClr val="467886"/></a:hlink></a:clrScheme><a:fontScheme name="O"><a:majorFont>\n'
    + '<a:latin typeface="Aptos Display" panose="02110004020202020204"/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/>'
    + '</a:minorFont></a:fontScheme></a:themeElements></a:theme>'
  const py = (code: string) => execFileSync('python3', ['-c', code], { cwd: dir }).toString()

  it('rewrites the theme part, keeps every other part as it was, [Content_Types].xml first', () => {
    writeFileSync(join(dir, 'theme1.xml'), THEME)
    py(`import zipfile
z=zipfile.ZipFile('in.docx','w',zipfile.ZIP_DEFLATED)
z.writestr('[Content_Types].xml','<Types/>')
z.write('theme1.xml','word/theme/theme1.xml')
z.writestr('word/document.xml','<doc>unchanged</doc>')
z.close()`)
    writeFileSync(join(dir, 'theme.json'), JSON.stringify({ colors: { accent1: '0E7C66', hlink: '2D6A8E' }, fonts: { major: 'Alfa "Slab" & One', minor: 'Noto Sans' } }))
    execFileSync('python3', [script, 'in.docx', 'out.docx', 'theme.json'], { cwd: dir })
    const out = JSON.parse(py(`import zipfile,json
z=zipfile.ZipFile('out.docx')
print(json.dumps({'names': z.namelist(), 'theme': z.read('word/theme/theme1.xml').decode(), 'doc': z.read('word/document.xml').decode()}))`))
    expect(out.names).toEqual(['[Content_Types].xml', 'word/theme/theme1.xml', 'word/document.xml'])
    expect(out.doc).toBe('<doc>unchanged</doc>')
    expect(out.theme).toContain('<a:accent1><a:srgbClr val="0E7C66"/></a:accent1>')
    expect(out.theme).toContain('<a:hlink><a:srgbClr val="2D6A8E"/></a:hlink>')
    expect(out.theme).toContain('<a:latin typeface="Alfa &quot;Slab&quot; &amp; One"/>')
    expect(out.theme).not.toContain('panose')
    expect(out.theme).toContain('<a:latin typeface="Noto Sans"/>')
  })

  it('refuses a colour that is not six hex digits and a slot it does not know', () => {
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ colors: { accent1: 'red' } }))
    expect(() => execFileSync('python3', [script, 'in.docx', 'x.docx', 'bad.json'], { cwd: dir, stdio: 'pipe' })).toThrow()
    writeFileSync(join(dir, 'bad2.json'), JSON.stringify({ colors: { accent9: '000000' } }))
    expect(() => execFileSync('python3', [script, 'in.docx', 'x.docx', 'bad2.json'], { cwd: dir, stdio: 'pipe' })).toThrow()
    expect(readFileSync(join(dir, 'out.docx')).length).toBeGreaterThan(0)
  })
})
