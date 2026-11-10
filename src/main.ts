/* Fabula: validate the environment, build the app, listen on $HOST:$PORT. */

import { Logger as PinoLogger } from 'nestjs-pino'
import { validateEnv } from './config/env.js'

async function bootstrap(): Promise<void> {
  // Checked before the app is built, for the body limit the adapter needs; ConfigModule checks it again
  const env = validateEnv(process.env)
  const { createApp } = await import('./app.js')
  const app = await createApp(env)
  await app.listen(env.PORT, env.HOST)
  app.get(PinoLogger).log(`fabula listening on ${env.HOST}:${env.PORT}`, 'Bootstrap')
}

bootstrap().catch((err) => {
  console.error('[fabula] bootstrap failed', err instanceof Error ? err.message : err)
  process.exit(1)
})
