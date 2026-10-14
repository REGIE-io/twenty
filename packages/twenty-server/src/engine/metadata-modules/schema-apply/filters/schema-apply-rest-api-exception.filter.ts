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
import { FieldMetadataException } from 'src/engine/metadata-modules/field-metadata/field-metadata.exception';
import { fieldMetadataExceptionCodeToHttpStatus } from 'src/engine/metadata-modules/field-metadata/utils/field-metadata-exception-code-to-http-status.util';
import { FlatEntityMapsException } from 'src/engine/metadata-modules/flat-entity/exceptions/flat-entity-maps.exception';
import { flatEntityMapsExceptionCodeToHttpStatus } from 'src/engine/metadata-modules/flat-entity/utils/flat-entity-maps-exception-code-to-http-status.util';
import { IndexMetadataException } from 'src/engine/metadata-modules/index-metadata/index-field-metadata.exception';
import { indexMetadataExceptionCodeToHttpStatus } from 'src/engine/metadata-modules/index-metadata/utils/index-metadata-exception-code-to-http-status.util';
import { ObjectMetadataException } from 'src/engine/metadata-modules/object-metadata/object-metadata.exception';
import { objectMetadataExceptionCodeToHttpStatus } from 'src/engine/metadata-modules/object-metadata/utils/object-metadata-exception-code-to-http-status.util';
import { SchemaApplyException } from 'src/engine/metadata-modules/schema-apply/schema-apply.exception';
import { schemaApplyExceptionCodeToHttpStatus } from 'src/engine/metadata-modules/schema-apply/utils/schema-apply-exception-code-to-http-status.util';
import { InvalidMetadataException } from 'src/engine/metadata-modules/utils/exceptions/invalid-metadata.exception';
import { WorkspaceMigrationBuilderException } from 'src/engine/workspace-manager/workspace-migration/exceptions/workspace-migration-builder-exception';
import { workspaceMigrationBuilderRestApiExceptionHandler } from 'src/engine/workspace-manager/workspace-migration/interceptors/utils/workspace-migration-builder-rest-api-exception-handler.util';

type CaughtException =
  | SchemaApplyException
  | ObjectMetadataException
  | FieldMetadataException
  | IndexMetadataException
  | InvalidMetadataException
  | FlatEntityMapsException
  | WorkspaceMigrationBuilderException;

@Injectable()
@Catch(
  SchemaApplyException,
  ObjectMetadataException,
  FieldMetadataException,
  IndexMetadataException,
  InvalidMetadataException,
  FlatEntityMapsException,
  WorkspaceMigrationBuilderException,
)
export class SchemaApplyRestApiExceptionFilter implements ExceptionFilter {
  constructor(
    private readonly httpExceptionHandlerService: HttpExceptionHandlerService,
    private readonly i18nService: I18nService,
  ) {}

  catch(exception: CaughtException, host: ArgumentsHost) {
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
      this.toHttpStatus(exception),
    );
  }

  private toHttpStatus(
    exception: Exclude<CaughtException, WorkspaceMigrationBuilderException>,
  ): number {
    if (exception instanceof SchemaApplyException) {
      return schemaApplyExceptionCodeToHttpStatus(exception.code);
    }

    if (exception instanceof ObjectMetadataException) {
      return objectMetadataExceptionCodeToHttpStatus(exception.code);
    }

    if (exception instanceof FieldMetadataException) {
      return fieldMetadataExceptionCodeToHttpStatus(exception.code);
    }

    if (exception instanceof IndexMetadataException) {
      return indexMetadataExceptionCodeToHttpStatus(exception.code);
    }

    if (exception instanceof FlatEntityMapsException) {
      return flatEntityMapsExceptionCodeToHttpStatus(exception.code);
    }

    return 400;
  }
}
