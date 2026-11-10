import { Module } from '@nestjs/common'
import { RenderController } from './render.controller.js'
import { OrchestratorService } from './orchestrator.service.js'
import { BrandIdentityService } from './brand/brand-identity.service.js'
import { BrandAssetsService } from './brand/brand-assets.service.js'
import { DataParserService } from './data-parser.service.js'
import { DataValidatorService } from './data-validator.service.js'
import { TypstEngine } from './engines/typst.engine.js'
import { PandocEngine } from './engines/pandoc.engine.js'
import { QuartoEngine } from './engines/quarto.engine.js'
import { WeasyPrintEngine } from './engines/weasyprint.engine.js'
import { MjmlEngine } from './engines/mjml.engine.js'
import { ChromiumEngine } from './engines/chromium.engine.js'
import { PagePreviewService } from './page-preview.service.js'
import { TemplateRegistryService } from './template-registry.service.js'
import { RenderCallbackService } from './render-callback.service.js'

@Module({
  controllers: [RenderController],
  providers: [
    OrchestratorService,
    BrandIdentityService,
    BrandAssetsService,
    PagePreviewService,
    TemplateRegistryService,
    RenderCallbackService,
    DataParserService,
    DataValidatorService,
    TypstEngine,
    PandocEngine,
    QuartoEngine,
    WeasyPrintEngine,
    MjmlEngine,
    ChromiumEngine,
  ],
  exports: [OrchestratorService],
})
export class RenderModule {}
