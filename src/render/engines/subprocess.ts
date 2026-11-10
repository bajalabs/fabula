/* The environment every engine process gets: nothing of the service's own (no key, no token), a UTF-8 locale, and
   a proxy that answers nothing for every scheme, so an engine that would fetch from the network (a Typst package not
   in the cache, a remote image in Pandoc, Quarto or WeasyPrint) fails at once instead of reaching out. A tool that
   ignores proxy variables is not held by this; the container's network policy is the hard line (see SECURITY.md). */

export const DEAD_PROXY = 'http://127.0.0.1:9'

export function engineEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME ?? '/tmp',
    TMPDIR: process.env.TMPDIR,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    http_proxy: DEAD_PROXY,
    https_proxy: DEAD_PROXY,
    all_proxy: DEAD_PROXY,
    HTTP_PROXY: DEAD_PROXY,
    HTTPS_PROXY: DEAD_PROXY,
    ALL_PROXY: DEAD_PROXY,
    no_proxy: '',
    NO_PROXY: '',
    TYPST_PACKAGE_CACHE_PATH: process.env.TYPST_PACKAGE_CACHE_PATH,
  }
  for (const [k, v] of Object.entries(extra)) env[k] = v
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k]
  return env
}
