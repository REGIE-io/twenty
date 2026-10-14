import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  Injectable,
} from '@nestjs/common';

import { type Response } from 'express';
import { SOURCE_LOCALE } from 'twenty-shared/translations';

import { HttpExceptionHandlerService } from 'src/engine/core-modules/exception-handler/http-exception-handler.service';
import { I18nService } from 'src/engine/core-modules/i18n/i18n.service';
import { IndexMetadataException } from 'src/engine/metadata-modules/index-metadata/index-field-metadata.exception';
import { indexMetadataExceptionCodeToHttpStatus } from 'src/engine/metadata-modules/index-metadata/utils/index-metadata-exception-code-to-http-status.util';
import { WorkspaceMigrationBuilderException } from 'src/engine/workspace-manager/workspace-migration/exceptions/workspace-migration-builder-exception';
import { workspaceMigrationBuilderRestApiExceptionHandler } from 'src/engine/workspace-manager/workspace-migration/interceptors/utils/workspace-migration-builder-rest-api-exception-handler.util';

@Injectable()
@Catch(IndexMetadataException, WorkspaceMigrationBuilderException)
export class IndexMetadataRestApiExceptionFilter implements ExceptionFilter {
  constructor(
    private readonly httpExceptionHandlerService: HttpExceptionHandlerService,
    private readonly i18nService: I18nService,
  ) {}

  catch(
    exception: IndexMetadataException | WorkspaceMigrationBuilderException,
    host: ArgumentsHost,
  ) {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof WorkspaceMigrationBuilderException) {
      return workspaceMigrationBuilderRestApiExceptionHandler({
        exception,
        response,
        i18n: this.i18nService.getI18nInstance(SOURCE_LOCALE),
      });
    }

    return this.httpExceptionHandlerService.handleError(
      exception,
      response,
      indexMetadataExceptionCodeToHttpStatus(exception.code),
    );
  }
}
