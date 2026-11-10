/* DataParserService: CSV, JSON, YAML or TOML to records (csv-parse, yaml, smol-toml, JSON.parse). */

import { Injectable } from '@nestjs/common'
import { parse as parseCsvSync } from 'csv-parse/sync'
import YAML from 'yaml'
import { parse as parseToml } from 'smol-toml'
import type {
  ParseDataRequest,
  ParseDataResponse,
} from '../contracts/index.js'

@Injectable()
export class DataParserService {
  parse(req: ParseDataRequest): ParseDataResponse {
    switch (req.sourceFormat) {
      case 'json':
        return this.parseJson(req.content)
      case 'yaml':
        return this.parseYaml(req.content)
      case 'toml':
        return this.parseToml(req.content)
      case 'csv':
        return this.parseCsv(req.content)
      case 'manual':
      default:
        return { mode: 'single', records: [] }
    }
  }

  private parseJson(content: string): ParseDataResponse {
    const parsed = JSON.parse(content)
    if (Array.isArray(parsed)) {
      const records = parsed.filter(
        (r): r is Record<string, unknown> =>
          r != null && typeof r === 'object' && !Array.isArray(r),
      )
      return { mode: 'batch', records }
    }
    if (parsed != null && typeof parsed === 'object') {
      return { mode: 'single', records: [parsed as Record<string, unknown>] }
    }
    // scalar JSON → wrap as one record under `value`
    return { mode: 'single', records: [{ value: parsed }] }
  }

  private parseYaml(content: string): ParseDataResponse {
    const parsed = YAML.parse(content)
    if (Array.isArray(parsed)) {
      return {
        mode: 'batch',
        records: parsed.filter(
          (r): r is Record<string, unknown> =>
            r != null && typeof r === 'object' && !Array.isArray(r),
        ),
      }
    }
    if (parsed != null && typeof parsed === 'object') {
      return { mode: 'single', records: [parsed as Record<string, unknown>] }
    }
    return { mode: 'single', records: [{ value: parsed }] }
  }

  private parseToml(content: string): ParseDataResponse {
    const parsed = parseToml(content)
    // TOML always yields an object at the root.
    return {
      mode: 'single',
      records: [parsed as Record<string, unknown>],
    }
  }

  private parseCsv(content: string): ParseDataResponse {
    const rows = parseCsvSync(content, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      cast: (value, ctx) => {
        if (ctx.header) return value
        if (value === '') return null
        // numeric coercion — integers and floats
        if (/^-?\d+$/.test(value)) return parseInt(value, 10)
        if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value)
        // booleans
        if (/^(true|false)$/i.test(value)) return value.toLowerCase() === 'true'
        return value
      },
    }) as Record<string, unknown>[]

    const fields = rows.length > 0 ? Object.keys(rows[0]) : []
    return {
      mode: 'batch',
      records: rows,
      fields,
    }
  }
}
