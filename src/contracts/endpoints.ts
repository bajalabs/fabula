/* The HTTP paths, in one place for the controllers and for any client. */

export const RENDER_ENDPOINTS = {
  health:       '/health',
  render:       '/render',
  preview:      '/preview',
  parseData:    '/data/parse',
  validateData: '/data/validate',
  templates:    '/templates',
} as const

export type RenderEndpoint = keyof typeof RENDER_ENDPOINTS
