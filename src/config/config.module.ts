import { Global, Module } from '@nestjs/common'
import { ConfigModule as NestConfigModule, ConfigService } from '@nestjs/config'
import { validateEnv } from './env.js'

@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      expandVariables: true,
      validate: validateEnv,
    }),
  ],
  providers: [ConfigService],
  exports: [NestConfigModule, ConfigService],
})
export class ConfigModule {}
