import { Injectable } from '@nestjs/common';

import {
  AllMetadataName,
  STANDARD_OBJECTS,
  WorkspaceMigrationV2ExceptionCode,
} from 'twenty-shared/metadata';
import { FieldMetadataType } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';

import { LoggerService } from 'src/engine/core-modules/logger/logger.service';
import { PhoneSearchMetadataGateService } from 'src/engine/core-modules/phone-search-index/services/phone-search-metadata-gate.service';
import { PhoneSearchFieldLifecycleCoordinatorService } from 'src/engine/core-modules/phone-search-index/services/phone-search-field-lifecycle-coordinator.service';
import { type PhoneSearchLifecycleDelta } from 'src/engine/core-modules/phone-search-index/types/phone-search-lifecycle-delta.type';
import { WORKSPACE_MIGRATION_ACTION_COUNT_BUCKET_BOUNDARIES } from 'src/engine/core-modules/metrics/constants/workspace-migration-action-count-bucket-boundaries.constant';
import { WORKSPACE_MIGRATION_DURATION_MS_BUCKET_BOUNDARIES } from 'src/engine/core-modules/metrics/constants/workspace-migration-duration-ms-bucket-boundaries.constant';
import { MetricsService } from 'src/engine/core-modules/metrics/metrics.service';
import { MetricsKeys } from 'src/engine/core-modules/metrics/types/metrics-keys.type';
import { TwentyConfigService } from 'src/engine/core-modules/twenty-config/twenty-config.service';
import { AllFlatEntityOperationRecordByMetadataName } from 'src/engine/metadata-modules/flat-entity/types/all-flat-entity-operation-record-by-metadata-name.type';
import { AllFlatEntityOperationByMetadataName } from 'src/engine/metadata-modules/flat-entity/types/flat-entity-to-create-delete-update.type';
import { getFlatEntityMapsExceptionContext } from 'src/engine/metadata-modules/flat-entity/utils/get-flat-entity-maps-exception-context.util';
import { transpileFlatEntityOperationArrayToRecord } from 'src/engine/metadata-modules/flat-entity/utils/transpile-flat-entity-operation-array-to-record.util';
import { MetadataSideEffectEngineService } from 'src/engine/metadata-modules/metadata-side-effect/services/metadata-side-effect-engine.service';
import { MetadataEventEmitter } from 'src/engine/subscriptions/metadata-event/metadata-event-emitter';
import { WorkspaceMigrationV2Exception } from 'src/engine/workspace-manager/workspace-migration.exception';
import {
  enrichCreateWorkspaceMigrationActionsWithIds,
  IdByUniversalIdentifierByMetadataName,
} from 'src/engine/workspace-manager/workspace-migration/services/utils/enrich-create-workspace-migration-action-with-ids.util';
import { WorkspaceMigrationBuildOrchestratorService } from 'src/engine/workspace-manager/workspace-migration/services/workspace-migration-build-orchestrator.service';
import {
  FlatEntityMapsBundle,
  WorkspaceMigrationFlatEntityMapsService,
} from 'src/engine/workspace-manager/workspace-migration/services/workspace-migration-flat-entity-maps.service';
import {
  WorkspaceMigrationOrchestratorBuildArgs,
  WorkspaceMigrationOrchestratorFailedResult,
  WorkspaceMigrationOrchestratorSuccessfulResult,
} from 'src/engine/workspace-manager/workspace-migration/types/workspace-migration-orchestrator.type';
import { WorkspaceMigrationRunnerService } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/services/workspace-migration-runner.service';

type ValidateBuildAndRunWorkspaceMigrationFromMatriceArgs = {
  workspaceId: string;
  allFlatEntityOperationByMetadataName: AllFlatEntityOperationByMetadataName;
  isSystemBuild?: boolean;
  applicationUniversalIdentifier: string;
  dryRun?: boolean;
};

type ValidateBuildAndRunWorkspaceMigrationFromRecordArgs = {
  workspaceId: string;
  allFlatEntityOperationRecordByMetadataName: AllFlatEntityOperationRecordByMetadataName;
  isSystemBuild?: boolean;
  applicationUniversalIdentifier: string;
  dryRun?: boolean;
};

type ValidateBuildAndRunWorkspaceMigrationFromRecordInternalArgs =
  ValidateBuildAndRunWorkspaceMigrationFromRecordArgs & {
    // Skips the metadata side-effect engine (expandWithSideEffects) and applies the
    // matrix literally. Only the deprecated legacy path sets this to true.
    skipSideEffectExpandEngine: boolean;
  };

type ComputeAndRunWorkspaceMigrationFromResolvedOperationsArgs = {
  workspaceId: string;
  allFlatEntityOperationRecordByMetadataName: AllFlatEntityOperationRecordByMetadataName;
  isSystemBuild: boolean;
  applicationUniversalIdentifier: string;
  dryRun?: boolean;
} & FlatEntityMapsBundle;

@Injectable()
export class WorkspaceMigrationValidateBuildAndRunService {
  private readonly isDebugEnabled: boolean;

  constructor(
    private readonly workspaceMigrationRunnerService: WorkspaceMigrationRunnerService,
    private readonly workspaceMigrationBuildOrchestratorService: WorkspaceMigrationBuildOrchestratorService,
    private readonly workspaceMigrationFlatEntityMapsService: WorkspaceMigrationFlatEntityMapsService,
    private readonly metadataEventEmitter: MetadataEventEmitter,
    private readonly metadataSideEffectEngineService: MetadataSideEffectEngineService,
    private readonly metricsService: MetricsService,
    private readonly logger: LoggerService,
    twentyConfigService: TwentyConfigService,
    private readonly phoneSearchMetadataGateService?: PhoneSearchMetadataGateService,
    private readonly phoneSearchFieldLifecycleCoordinatorService?: PhoneSearchFieldLifecycleCoordinatorService,
  ) {
    const logLevels = twentyConfigService.get('LOG_LEVELS');

    this.isDebugEnabled = logLevels.includes('debug');
  }

  public async validateBuildAndRunWorkspaceMigrationFromTo(
    args: WorkspaceMigrationOrchestratorBuildArgs & {
      idByUniversalIdentifierByMetadataName?: IdByUniversalIdentifierByMetadataName;
      dryRun?: boolean;
      phoneLifecycleDelta?: PhoneSearchLifecycleDelta;
      phoneMetadataGate?: { objectMetadataId: string };
    },
  ): Promise<
    | WorkspaceMigrationOrchestratorFailedResult
    | (WorkspaceMigrationOrchestratorSuccessfulResult & {
        hasSchemaMetadataChanged: boolean;
      })
  > {
    const {
      idByUniversalIdentifierByMetadataName,
      dryRun,
      phoneLifecycleDelta,
      phoneMetadataGate,
      ...buildArgs
    } = args;

    const buildStart = performance.now();
    const validateAndBuildResult =
      await this.workspaceMigrationBuildOrchestratorService
        .buildWorkspaceMigration(buildArgs)
        .catch((error) => {
          this.metricsService.recordHistogram({
            key: MetricsKeys.WorkspaceMigrationBuildDurationMs,
            value: performance.now() - buildStart,
            unit: 'ms',
            attributes: { status: 'error' },
            bucketBoundaries: WORKSPACE_MIGRATION_DURATION_MS_BUCKET_BOUNDARIES,
          });

          this.logger.error(
            error,
            WorkspaceMigrationValidateBuildAndRunService.name,
          );
          throw new WorkspaceMigrationV2Exception(
            error.message,
            WorkspaceMigrationV2ExceptionCode.BUILDER_INTERNAL_SERVER_ERROR,
            { context: getFlatEntityMapsExceptionContext(error) },
          );
        });
    const buildMs = performance.now() - buildStart;

    this.metricsService.recordHistogram({
      key: MetricsKeys.WorkspaceMigrationBuildDurationMs,
      value: buildMs,
      unit: 'ms',
      attributes: { status: validateAndBuildResult.status },
      bucketBoundaries: WORKSPACE_MIGRATION_DURATION_MS_BUCKET_BOUNDARIES,
    });

    this.logger.perf(
      `[install-perf] buildWorkspaceMigration took ${buildMs.toFixed(1)}ms (status=${validateAndBuildResult.status})`,
      WorkspaceMigrationValidateBuildAndRunService.name,
    );

    if (validateAndBuildResult.status === 'fail') {
      if (this.isDebugEnabled) {
        this.logger.debug?.(
          JSON.stringify(validateAndBuildResult, null, 2),
          WorkspaceMigrationValidateBuildAndRunService.name,
        );
      }

      return validateAndBuildResult;
    }

    const workspaceMigration = enrichCreateWorkspaceMigrationActionsWithIds({
      idByUniversalIdentifierByMetadataName:
        idByUniversalIdentifierByMetadataName ?? {},
      workspaceMigration: validateAndBuildResult.workspaceMigration,
    });
    const createdFieldIdByUniversalIdentifier = new Map(
      workspaceMigration.actions
        .filter(
          (action) =>
            action.type === 'create' && action.metadataName === 'fieldMetadata',
        )
        .map((action) => [action.flatEntity.universalIdentifier, action.id]),
    );
    const resolvedPhoneLifecycleDelta = phoneLifecycleDelta
      ? {
          ...phoneLifecycleDelta,
          created: phoneLifecycleDelta.created.map((field) => {
            if (!field.universalIdentifier) {
              throw new Error(
                'Created phone field is missing its universal identifier',
              );
            }
            const fieldMetadataId =
              field.id ??
              createdFieldIdByUniversalIdentifier.get(
                field.universalIdentifier,
              );

            if (!isDefined(fieldMetadataId)) {
              throw new Error(
                `Unable to resolve created phone field ${field.universalIdentifier}`,
              );
            }

            return { ...field, id: fieldMetadataId };
          }),
        }
      : undefined;

    if (dryRun === true || workspaceMigration.actions.length === 0) {
      return {
        status: 'success',
        workspaceMigration,
        hasSchemaMetadataChanged: false,
      };
    }

    const actionCountsByTypeAndMetadataName: Record<string, number> = {};

    for (const action of workspaceMigration.actions) {
      const key = `${action.type}:${action.metadataName}`;

      actionCountsByTypeAndMetadataName[key] =
        (actionCountsByTypeAndMetadataName[key] ?? 0) + 1;
    }

    this.logger.perf(
      `[install-perf] validateBuildAndRunWorkspaceMigrationFromTo running ${workspaceMigration.actions.length} actions: ${JSON.stringify(actionCountsByTypeAndMetadataName)}`,
      WorkspaceMigrationValidateBuildAndRunService.name,
    );

    this.metricsService.recordHistogram({
      key: MetricsKeys.WorkspaceMigrationActionCount,
      value: workspaceMigration.actions.length,
      bucketBoundaries: WORKSPACE_MIGRATION_ACTION_COUNT_BUCKET_BOUNDARIES,
    });

    const runStart = performance.now();
    let phoneOperationIds: string[] = [];
    const { hasSchemaMetadataChanged, metadataEvents } =
      await this.workspaceMigrationRunnerService.run({
        workspaceId: args.workspaceId,
        workspaceMigration,
        beforeActions: phoneMetadataGate
          ? async (queryRunner) => {
              await this.phoneSearchMetadataGateService?.assertAvailable({
                workspaceId: args.workspaceId,
                objectMetadataId: phoneMetadataGate.objectMetadataId,
                manager: queryRunner.manager,
              });
            }
          : undefined,
        beforeCommit: resolvedPhoneLifecycleDelta
          ? async (queryRunner) => {
              phoneOperationIds =
                (await this.phoneSearchFieldLifecycleCoordinatorService?.afterMigration(
                  {
                    workspaceId: args.workspaceId,
                    ...resolvedPhoneLifecycleDelta,
                    manager: queryRunner.manager,
                    enqueue: false,
                  },
                )) ?? [];
            }
          : undefined,
      });
    const runMs = performance.now() - runStart;

    this.logger.perf(
      `[install-perf] workspaceMigrationRunnerService.run took ${runMs.toFixed(1)}ms for ${workspaceMigration.actions.length} actions`,
      WorkspaceMigrationValidateBuildAndRunService.name,
    );

    // Queue delivery happens only after the same transaction has committed.
    // The reconciler is the durable fallback if Redis enqueue fails.
    await this.phoneSearchFieldLifecycleCoordinatorService?.enqueue(
      phoneOperationIds,
    );

    this.metadataEventEmitter.emitMetadataEvents({
      metadataEvents: metadataEvents,
      workspaceId: args.workspaceId,
    });

    return {
      status: 'success',
      workspaceMigration,
      hasSchemaMetadataChanged,
    };
  }

  public async validateBuildAndRunWorkspaceMigration({
    allFlatEntityOperationByMetadataName,
    workspaceId,
    isSystemBuild = false,
    applicationUniversalIdentifier,
    dryRun,
  }: ValidateBuildAndRunWorkspaceMigrationFromMatriceArgs): Promise<
    | WorkspaceMigrationOrchestratorFailedResult
    | (WorkspaceMigrationOrchestratorSuccessfulResult & {
        hasSchemaMetadataChanged: boolean;
      })
  > {
    return await this.validateBuildAndRunWorkspaceMigrationFromRecord({
      allFlatEntityOperationRecordByMetadataName:
        transpileFlatEntityOperationArrayToRecord(
          allFlatEntityOperationByMetadataName,
        ),
      workspaceId,
      isSystemBuild,
      applicationUniversalIdentifier,
      dryRun,
    });
  }

  public async validateBuildAndRunWorkspaceMigrationFromRecord(
    args: ValidateBuildAndRunWorkspaceMigrationFromRecordArgs,
  ): Promise<
    | WorkspaceMigrationOrchestratorFailedResult
    | (WorkspaceMigrationOrchestratorSuccessfulResult & {
        hasSchemaMetadataChanged: boolean;
      })
  > {
    return await this.validateBuildAndRunWorkspaceMigrationFromRecordInternal({
      ...args,
      skipSideEffectExpandEngine: false,
    });
  }

  /**
   * @deprecated Legacy path for upgrade commands authored before the metadata
   * side-effect engine landed in v2.19. These commands declare their operation
   * matrix literally and must not flow through expandWithSideEffects, which
   * would inject engine-owned companions and collide on reserved identifiers.
   * See packages/twenty-server/docs/UPGRADE_COMMANDS.md.
   */
  public async validateBuildAndRunLegacyWorkspaceMigration({
    allFlatEntityOperationByMetadataName,
    workspaceId,
    isSystemBuild = false,
    applicationUniversalIdentifier,
    dryRun,
  }: ValidateBuildAndRunWorkspaceMigrationFromMatriceArgs): Promise<
    | WorkspaceMigrationOrchestratorFailedResult
    | (WorkspaceMigrationOrchestratorSuccessfulResult & {
        hasSchemaMetadataChanged: boolean;
      })
  > {
    return await this.validateBuildAndRunWorkspaceMigrationFromRecordInternal({
      allFlatEntityOperationRecordByMetadataName:
        transpileFlatEntityOperationArrayToRecord(
          allFlatEntityOperationByMetadataName,
        ),
      workspaceId,
      isSystemBuild,
      applicationUniversalIdentifier,
      dryRun,
      skipSideEffectExpandEngine: true,
    });
  }

  private async validateBuildAndRunWorkspaceMigrationFromRecordInternal({
    allFlatEntityOperationRecordByMetadataName,
    workspaceId,
    isSystemBuild = false,
    applicationUniversalIdentifier,
    dryRun,
    skipSideEffectExpandEngine,
  }: ValidateBuildAndRunWorkspaceMigrationFromRecordInternalArgs): Promise<
    | WorkspaceMigrationOrchestratorFailedResult
    | (WorkspaceMigrationOrchestratorSuccessfulResult & {
        hasSchemaMetadataChanged: boolean;
      })
  > {
    const callerMetadataNames = Object.keys(
      allFlatEntityOperationRecordByMetadataName,
    ) as AllMetadataName[];

    const {
      flatApplicationMaps,
      allRelatedFlatEntityMaps,
      allMetadataNameCacheToCompute,
    } =
      await this.workspaceMigrationFlatEntityMapsService.getOrRecomputeAllRelatedFlatEntityMaps(
        {
          workspaceId,
          callerMetadataNames,
        },
      );

    let resolvedFlatEntityOperationRecordByMetadataName =
      allFlatEntityOperationRecordByMetadataName;

    if (!skipSideEffectExpandEngine) {
      const sideEffectExpansionResult =
        this.metadataSideEffectEngineService.expandWithSideEffects({
          allFlatEntityOperationRecordByMetadataName,
          sideEffectRelatedFlatEntityMaps: allRelatedFlatEntityMaps,
          context: {
            buildOptions: { isSystemBuild, applicationUniversalIdentifier },
          },
        });

      if (sideEffectExpansionResult.status === 'fail') {
        return sideEffectExpansionResult;
      }

      resolvedFlatEntityOperationRecordByMetadataName =
        sideEffectExpansionResult.allFlatEntityOperationRecordByMetadataName;
    }

    return await this.computeAndRunWorkspaceMigrationFromResolvedOperations({
      allFlatEntityOperationRecordByMetadataName:
        resolvedFlatEntityOperationRecordByMetadataName,
      workspaceId,
      isSystemBuild,
      applicationUniversalIdentifier,
      dryRun,
      flatApplicationMaps,
      allRelatedFlatEntityMaps,
      allMetadataNameCacheToCompute,
    });
  }

  private async computeAndRunWorkspaceMigrationFromResolvedOperations({
    allFlatEntityOperationRecordByMetadataName,
    workspaceId,
    isSystemBuild,
    applicationUniversalIdentifier,
    dryRun,
    flatApplicationMaps,
    allRelatedFlatEntityMaps,
    allMetadataNameCacheToCompute,
  }: ComputeAndRunWorkspaceMigrationFromResolvedOperationsArgs): Promise<
    | WorkspaceMigrationOrchestratorFailedResult
    | (WorkspaceMigrationOrchestratorSuccessfulResult & {
        hasSchemaMetadataChanged: boolean;
      })
  > {
    const fieldOperations =
      allFlatEntityOperationRecordByMetadataName.fieldMetadata;
    const objectOperations =
      allFlatEntityOperationRecordByMetadataName.objectMetadata;
    const fieldsToCreate = Object.values(
      fieldOperations?.flatEntityToCreate ?? {},
    ).filter(isDefined);
    const fieldsToDelete = Object.values(
      fieldOperations?.flatEntityToDelete ?? {},
    ).filter(isDefined);
    const fieldsToUpdate = Object.values(
      fieldOperations?.flatEntityToUpdate ?? {},
    ).filter(isDefined);
    const objectsToCreate = Object.values(
      objectOperations?.flatEntityToCreate ?? {},
    ).filter(isDefined);
    const objectsToDelete = Object.values(
      objectOperations?.flatEntityToDelete ?? {},
    ).filter(isDefined);
    const objectsToUpdate = Object.values(
      objectOperations?.flatEntityToUpdate ?? {},
    ).filter(isDefined);
    const person =
      allRelatedFlatEntityMaps.flatObjectMetadataMaps?.byUniversalIdentifier[
        STANDARD_OBJECTS.person.universalIdentifier
      ];
    const hasPhoneFieldOperation =
      fieldOperations &&
      [...fieldsToCreate, ...fieldsToDelete, ...fieldsToUpdate].some(
        (field) =>
          field.objectMetadataUniversalIdentifier ===
            person?.universalIdentifier &&
          field.type === FieldMetadataType.PHONES,
      );
    const hasPersonObjectOperation =
      objectOperations &&
      [...objectsToCreate, ...objectsToDelete, ...objectsToUpdate].some(
        (object) =>
          object.universalIdentifier ===
          STANDARD_OBJECTS.person.universalIdentifier,
      );
    const {
      fromToAllFlatEntityMaps,
      inferDeletionFromMissingEntities,
      dependencyAllFlatEntityMaps,
      additionalCacheDataMaps,
      idByUniversalIdentifierByMetadataName,
    } =
      this.workspaceMigrationFlatEntityMapsService.computeFromToAllFlatEntityMapsAndBuildOptions(
        {
          allFlatEntityOperationRecordByMetadataName,
          applicationUniversalIdentifier,
          flatApplicationMaps,
          allRelatedFlatEntityMaps,
          allMetadataNameCacheToCompute,
        },
      );

    return await this.validateBuildAndRunWorkspaceMigrationFromTo({
      buildOptions: {
        isSystemBuild,
        inferDeletionFromMissingEntities,
        applicationUniversalIdentifier,
      },
      fromToAllFlatEntityMaps,
      workspaceId,
      dependencyAllFlatEntityMaps,
      additionalCacheDataMaps,
      idByUniversalIdentifierByMetadataName,
      dryRun,
      phoneMetadataGate:
        person && (hasPhoneFieldOperation || hasPersonObjectOperation)
          ? { objectMetadataId: person.id }
          : undefined,
      phoneLifecycleDelta: person
        ? {
            objectMetadataId: person.id,
            created: fieldsToCreate,
            updated: fieldsToUpdate.map((field) => ({
              ...field,
              before:
                allRelatedFlatEntityMaps.flatFieldMetadataMaps
                  ?.byUniversalIdentifier[field.universalIdentifier],
            })),
            deleted: fieldsToDelete,
          }
        : undefined,
    });
  }
}
