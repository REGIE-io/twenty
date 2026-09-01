import { Command } from 'nest-commander';
import { STANDARD_OBJECTS } from 'twenty-shared/metadata';
import { FieldMetadataType } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';

import { ProvisionedWorkspaceCommandRunner } from 'src/database/commands/command-runners/provisioned-workspace.command-runner';
import { WorkspaceIteratorService } from 'src/database/commands/command-runners/workspace-iterator.service';
import { type RunOnWorkspaceArgs } from 'src/database/commands/command-runners/workspace.command-runner';
import { ApplicationService } from 'src/engine/core-modules/application/application.service';
import { RegisteredWorkspaceCommand } from 'src/engine/core-modules/upgrade/decorators/registered-workspace-command.decorator';
import { buildFlatSearchFieldMetadataForField } from 'src/engine/metadata-modules/flat-search-field-metadata/utils/build-flat-search-field-metadata-for-field.util';
import { type FlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/types/flat-field-metadata.type';
import { type FlatIndexMetadata } from 'src/engine/metadata-modules/flat-index-metadata/types/flat-index-metadata.type';
import { type FlatSearchFieldMetadata } from 'src/engine/metadata-modules/flat-search-field-metadata/types/flat-search-field-metadata.type';
import { WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';
import { computeTwentyStandardApplicationAllFlatEntityMaps } from 'src/engine/workspace-manager/twenty-standard-application/utils/twenty-standard-application-all-flat-entity-maps.constant';
import { WorkspaceMigrationValidateBuildAndRunService } from 'src/engine/workspace-manager/workspace-migration/services/workspace-migration-validate-build-and-run-service';

@RegisteredWorkspaceCommand('2.32.0', 1786800001000)
@Command({
  name: 'upgrade:2-32:add-person-phone-search-vector',
  description:
    'Add the indexed Person-only phone search vector and include existing active custom phone fields.',
})
export class AddPersonPhoneSearchVectorCommand extends ProvisionedWorkspaceCommandRunner {
  constructor(
    protected readonly workspaceIteratorService: WorkspaceIteratorService,
    private readonly applicationService: ApplicationService,
    private readonly workspaceCacheService: WorkspaceCacheService,
    private readonly workspaceMigrationValidateBuildAndRunService: WorkspaceMigrationValidateBuildAndRunService,
  ) {
    super(workspaceIteratorService);
  }

  override async runOnWorkspace({
    workspaceId,
    options,
  }: RunOnWorkspaceArgs): Promise<void> {
    const {
      flatObjectMetadataMaps,
      flatFieldMetadataMaps,
      flatIndexMaps,
      flatSearchFieldMetadataMaps,
    } = await this.workspaceCacheService.getOrRecompute(workspaceId, [
      'flatObjectMetadataMaps',
      'flatFieldMetadataMaps',
      'flatIndexMaps',
      'flatSearchFieldMetadataMaps',
    ]);
    const person =
      flatObjectMetadataMaps.byUniversalIdentifier[
        STANDARD_OBJECTS.person.universalIdentifier
      ];
    if (!isDefined(person)) return;
    const { twentyStandardFlatApplication } =
      await this.applicationService.findWorkspaceTwentyStandardAndCustomApplicationOrThrow(
        { workspaceId },
      );
    const { allFlatEntityMaps: standard } =
      computeTwentyStandardApplicationAllFlatEntityMaps({
        now: new Date().toISOString(),
        workspaceId,
        twentyStandardApplicationId: twentyStandardFlatApplication.id,
      });
    const vectorId =
      STANDARD_OBJECTS.person.fields.phoneSearchVector.universalIdentifier;
    const indexId =
      STANDARD_OBJECTS.person.indexes.phoneSearchVectorGinIndex
        .universalIdentifier;
    const vector = standard.flatFieldMetadataMaps.byUniversalIdentifier[
      vectorId
    ] as FlatFieldMetadata | undefined;
    const index = standard.flatIndexMaps.byUniversalIdentifier[indexId] as
      | FlatIndexMetadata
      | undefined;
    if (!isDefined(vector) || !isDefined(index))
      throw new Error('Standard Person phone search metadata is missing');
    const fieldsToCreate = isDefined(
      flatFieldMetadataMaps.byUniversalIdentifier[vectorId],
    )
      ? []
      : [vector];
    const indexesToCreate = isDefined(
      flatIndexMaps.byUniversalIdentifier[indexId],
    )
      ? []
      : [index];
    const phoneFields = Object.values(
      flatFieldMetadataMaps.byUniversalIdentifier,
    )
      .filter(
        (field): field is FlatFieldMetadata =>
          isDefined(field) &&
          field.objectMetadataUniversalIdentifier ===
            person.universalIdentifier &&
          field.type === FieldMetadataType.PHONES &&
          field.isActive,
      );
    const searchFieldsToCreate: FlatSearchFieldMetadata[] = phoneFields.flatMap(
      (field) => {
        const desired = buildFlatSearchFieldMetadataForField({
          flatObjectMetadata: person,
          flatFieldMetadata: field,
          tsVectorFlatFieldMetadata: vector,
          position: 0,
          useTargetAwareIdentifier: true,
        });
        return isDefined(
          flatSearchFieldMetadataMaps.byUniversalIdentifier[
            desired.universalIdentifier
          ],
        )
          ? []
          : [desired];
      },
    );
    if (
      !fieldsToCreate.length &&
      !indexesToCreate.length &&
      !searchFieldsToCreate.length
    )
      return;
    if (options.dryRun) return;
    const result =
      await this.workspaceMigrationValidateBuildAndRunService.validateBuildAndRunLegacyWorkspaceMigration(
        {
          isSystemBuild: true,
          workspaceId,
          applicationUniversalIdentifier:
            twentyStandardFlatApplication.universalIdentifier,
          allFlatEntityOperationByMetadataName: {
            fieldMetadata: {
              flatEntityToCreate: fieldsToCreate,
              flatEntityToDelete: [],
              flatEntityToUpdate: [],
            },
            index: {
              flatEntityToCreate: indexesToCreate,
              flatEntityToDelete: [],
              flatEntityToUpdate: [],
            },
            searchFieldMetadata: {
              flatEntityToCreate: searchFieldsToCreate,
              flatEntityToDelete: [],
              flatEntityToUpdate: [],
            },
          },
        },
      );
    if (result.status === 'fail')
      throw new Error(
        `Failed to provision Person phone search vector: ${JSON.stringify(result)}`,
      );
  }
}
