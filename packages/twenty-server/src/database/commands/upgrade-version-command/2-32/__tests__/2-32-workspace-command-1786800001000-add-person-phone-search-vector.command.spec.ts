import { STANDARD_OBJECTS } from 'twenty-shared/metadata';
import { FieldMetadataType } from 'twenty-shared/types';

import { type WorkspaceIteratorService } from 'src/database/commands/command-runners/workspace-iterator.service';
import { AddPersonPhoneSearchVectorCommand } from 'src/database/commands/upgrade-version-command/2-32/2-32-workspace-command-1786800001000-add-person-phone-search-vector.command';
import { type ApplicationService } from 'src/engine/core-modules/application/application.service';
import { createEmptyFlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/constant/create-empty-flat-entity-maps.constant';
import { type FlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/types/flat-entity-maps.type';
import { addFlatEntityToFlatEntityMapsOrThrow } from 'src/engine/metadata-modules/flat-entity/utils/add-flat-entity-to-flat-entity-maps-or-throw.util';
import { getFlatFieldMetadataMock } from 'src/engine/metadata-modules/flat-field-metadata/__mocks__/get-flat-field-metadata.mock';
import { type FlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/types/flat-field-metadata.type';
import { type FlatSearchFieldMetadata } from 'src/engine/metadata-modules/flat-search-field-metadata/types/flat-search-field-metadata.type';
import { type WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';
import { computeTwentyStandardApplicationAllFlatEntityMaps } from 'src/engine/workspace-manager/twenty-standard-application/utils/twenty-standard-application-all-flat-entity-maps.constant';
import { type WorkspaceMigrationValidateBuildAndRunService } from 'src/engine/workspace-manager/workspace-migration/services/workspace-migration-validate-build-and-run-service';

const WORKSPACE_ID = '20202020-1111-4111-8111-111111111111';
const APPLICATION_ID = '20202020-2222-4222-8222-222222222222';
const NOW = '2026-09-01T00:00:00.000Z';

describe('AddPersonPhoneSearchVectorCommand', () => {
  const { allFlatEntityMaps: standard } =
    computeTwentyStandardApplicationAllFlatEntityMaps({
      now: NOW,
      workspaceId: WORKSPACE_ID,
      twentyStandardApplicationId: APPLICATION_ID,
    });
  const person =
    standard.flatObjectMetadataMaps.byUniversalIdentifier[
      STANDARD_OBJECTS.person.universalIdentifier
    ]!;
  const vectorUniversalIdentifier =
    STANDARD_OBJECTS.person.fields.phoneSearchVector.universalIdentifier;
  const indexUniversalIdentifier =
    STANDARD_OBJECTS.person.indexes.phoneSearchVectorGinIndex
      .universalIdentifier;

  const buildFieldMaps = ({
    includeVector,
    customFields = [],
  }: {
    includeVector: boolean;
    customFields?: FlatFieldMetadata[];
  }) => {
    let maps = createEmptyFlatEntityMaps() as FlatEntityMaps<FlatFieldMetadata>;

    for (const field of [
      ...Object.values(
        standard.flatFieldMetadataMaps.byUniversalIdentifier,
      ).filter(
        (candidate): candidate is FlatFieldMetadata =>
          candidate !== undefined &&
          (includeVector ||
            candidate.universalIdentifier !== vectorUniversalIdentifier),
      ),
      ...customFields,
    ]) {
      maps = addFlatEntityToFlatEntityMapsOrThrow({
        flatEntity: field,
        flatEntityMaps: maps,
      });
    }

    return maps;
  };

  it('plans standard metadata plus active pre-existing custom phone fields, then becomes idempotent', async () => {
    const activePhone = getFlatFieldMetadataMock({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      universalIdentifier: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      objectMetadataId: person.id,
      objectMetadataUniversalIdentifier: person.universalIdentifier,
      applicationId: APPLICATION_ID,
      applicationUniversalIdentifier: person.applicationUniversalIdentifier,
      name: 'preExistingActivePhones',
      type: FieldMetadataType.PHONES,
      isActive: true,
    });
    const inactivePhone = getFlatFieldMetadataMock({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      universalIdentifier: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      objectMetadataId: person.id,
      objectMetadataUniversalIdentifier: person.universalIdentifier,
      applicationId: APPLICATION_ID,
      applicationUniversalIdentifier: person.applicationUniversalIdentifier,
      name: 'preExistingInactivePhones',
      type: FieldMetadataType.PHONES,
      isActive: false,
    });
    const personWithCustomFields = {
      ...person,
      fieldUniversalIdentifiers: [
        ...person.fieldUniversalIdentifiers.filter(
          (id) => id !== vectorUniversalIdentifier,
        ),
        activePhone.universalIdentifier,
        inactivePhone.universalIdentifier,
      ],
    };
    const before = {
      flatObjectMetadataMaps: {
        ...standard.flatObjectMetadataMaps,
        byUniversalIdentifier: {
          ...standard.flatObjectMetadataMaps.byUniversalIdentifier,
          [person.universalIdentifier]: personWithCustomFields,
        },
      },
      flatFieldMetadataMaps: buildFieldMaps({
        includeVector: false,
        customFields: [activePhone, inactivePhone],
      }),
      flatIndexMaps: {
        ...standard.flatIndexMaps,
        byUniversalIdentifier: Object.fromEntries(
          Object.entries(standard.flatIndexMaps.byUniversalIdentifier).filter(
            ([id]) => id !== indexUniversalIdentifier,
          ),
        ),
      },
      flatSearchFieldMetadataMaps: createEmptyFlatEntityMaps(),
    };
    const validateAndRun = jest.fn().mockResolvedValue({ status: 'success' });
    const getOrRecompute = jest.fn().mockResolvedValue(before);
    const command = new AddPersonPhoneSearchVectorCommand(
      {} as WorkspaceIteratorService,
      {
        findWorkspaceTwentyStandardAndCustomApplicationOrThrow: jest
          .fn()
          .mockResolvedValue({
            twentyStandardFlatApplication: {
              id: APPLICATION_ID,
              universalIdentifier: person.applicationUniversalIdentifier,
            },
          }),
      } as unknown as ApplicationService,
      { getOrRecompute } as unknown as WorkspaceCacheService,
      {
        validateBuildAndRunLegacyWorkspaceMigration: validateAndRun,
      } as unknown as WorkspaceMigrationValidateBuildAndRunService,
    );

    await command.runOnWorkspace({
      workspaceId: WORKSPACE_ID,
      options: { dryRun: false },
      index: 0,
      total: 1,
    });

    const operations =
      validateAndRun.mock.calls[0][0].allFlatEntityOperationByMetadataName;

    expect(operations.fieldMetadata.flatEntityToCreate).toEqual([
      expect.objectContaining({
        universalIdentifier: vectorUniversalIdentifier,
        type: FieldMetadataType.TS_VECTOR,
      }),
    ]);
    expect(operations.index.flatEntityToCreate).toEqual([
      expect.objectContaining({
        universalIdentifier: indexUniversalIdentifier,
      }),
    ]);
    expect(
      operations.searchFieldMetadata.flatEntityToCreate.map(
        (item: { fieldMetadataUniversalIdentifier: string }) =>
          item.fieldMetadataUniversalIdentifier,
      ),
    ).toEqual(
      expect.arrayContaining([
        STANDARD_OBJECTS.person.fields.phones.universalIdentifier,
        activePhone.universalIdentifier,
      ]),
    );
    expect(
      operations.searchFieldMetadata.flatEntityToCreate.map(
        (item: { fieldMetadataUniversalIdentifier: string }) =>
          item.fieldMetadataUniversalIdentifier,
      ),
    ).not.toContain(inactivePhone.universalIdentifier);

    const provisionedSearchFieldMaps = (
      operations.searchFieldMetadata
        .flatEntityToCreate as FlatSearchFieldMetadata[]
    ).reduce(
      (
        maps: FlatEntityMaps<FlatSearchFieldMetadata>,
        item: FlatSearchFieldMetadata,
      ) =>
        addFlatEntityToFlatEntityMapsOrThrow({
          flatEntity: item,
          flatEntityMaps: maps,
        }),
      createEmptyFlatEntityMaps() as FlatEntityMaps<FlatSearchFieldMetadata>,
    );

    getOrRecompute.mockResolvedValue({
      ...before,
      flatFieldMetadataMaps: buildFieldMaps({
        includeVector: true,
        customFields: [activePhone, inactivePhone],
      }),
      flatIndexMaps: standard.flatIndexMaps,
      flatSearchFieldMetadataMaps: provisionedSearchFieldMaps,
    });

    await command.runOnWorkspace({
      workspaceId: WORKSPACE_ID,
      options: { dryRun: false },
      index: 0,
      total: 1,
    });

    expect(validateAndRun).toHaveBeenCalledTimes(1);
  });
});
