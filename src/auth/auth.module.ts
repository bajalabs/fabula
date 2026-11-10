import { Global, Module } from '@nestjs/common'
import { CallerRegistry } from './callers.js'
import { AuthGuard } from './auth.guard.js'

/** The guard is registered for every route in AppModule; @Public() opts a route out. */
@Global()
@Module({
  providers: [CallerRegistry, AuthGuard],
  exports: [CallerRegistry, AuthGuard],
})
export class AuthModule {}
