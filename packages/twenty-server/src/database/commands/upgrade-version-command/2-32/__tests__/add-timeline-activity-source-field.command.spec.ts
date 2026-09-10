import { STANDARD_OBJECTS } from 'twenty-shared/metadata';

import { type WorkspaceIteratorService } from 'src/database/commands/command-runners/workspace-iterator.service';
import { AddTimelineActivitySourceFieldCommand } from 'src/database/commands/upgrade-version-command/2-32/2-32-workspace-command-1786900001000-add-timeline-activity-source-field.command';
import { type ApplicationService } from 'src/engine/core-modules/application/application.service';
import { type WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';
import { computeTwentyStandardApplicationAllFlatEntityMaps } from 'src/engine/workspace-manager/twenty-standard-application/utils/twenty-standard-application-all-flat-entity-maps.constant';
import { type WorkspaceMigrationValidateBuildAndRunService } from 'src/engine/workspace-manager/workspace-migration/services/workspace-migration-validate-build-and-run-service';

jest.mock(
  'src/engine/workspace-manager/twenty-standard-application/utils/twenty-standard-application-all-flat-entity-maps.constant',
);

const computeTwentyStandardApplicationAllFlatEntityMapsMock =
  computeTwentyStandardApplicationAllFlatEntityMaps as jest.Mock;

const WORKSPACE_ID = '20202020-0000-0000-0000-000000000001';
const TIMELINE_ACTIVITY_OBJECT_ID = '20202020-0000-0000-0000-000000000002';
const STANDARD_APPLICATION = {
  id: '20202020-0000-0000-0000-0000000000aa',
  universalIdentifier: '20202020-0000-0000-0000-0000000000bb',
};

const TIMELINE_ACTIVITY_UNIVERSAL_IDENTIFIER =
  STANDARD_OBJECTS.timelineActivity.universalIdentifier;
const SOURCE_FIELD_UNIVERSAL_IDENTIFIER =
  STANDARD_OBJECTS.timelineActivity.fields.source.universalIdentifier;

const STANDARD_SOURCE_FIELD = {
  universalIdentifier: SOURCE_FIELD_UNIVERSAL_IDENTIFIER,
  name: 'source',
  viewFieldIds: ['should-be-cleared'],
  viewFieldUniversalIdentifiers: ['should-be-cleared'],
};

const buildByUniversalIdentifierMap = <
  TFlatEntity extends { universalIdentifier: string },
>(
  flatEntities: TFlatEntity[],
) => ({
  byUniversalIdentifier: Object.fromEntries(
    flatEntities.map((flatEntity) => [
      flatEntity.universalIdentifier,
      flatEntity,
    ]),
  ),
});

describe('AddTimelineActivitySourceFieldCommand', () => {
  let command: AddTimelineActivitySourceFieldCommand;
  let getOrRecomputeMock: jest.Mock;
  let validateBuildAndRunLegacyWorkspaceMigrationMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    getOrRecomputeMock = jest.fn();
    validateBuildAndRunLegacyWorkspaceMigrationMock = jest
      .fn()
      .mockResolvedValue({ status: 'success' });

    computeTwentyStandardApplicationAllFlatEntityMapsMock.mockReturnValue({
      allFlatEntityMaps: {
        flatFieldMetadataMaps: buildByUniversalIdentifierMap([
          STANDARD_SOURCE_FIELD,
        ]),
      },
    });

    command = new AddTimelineActivitySourceFieldCommand(
      {} as WorkspaceIteratorService,
      {
        findWorkspaceTwentyStandardAndCustomApplicationOrThrow: jest
          .fn()
          .mockResolvedValue({
            twentyStandardFlatApplication: STANDARD_APPLICATION,
          }),
      } as unknown as ApplicationService,
      {
        getOrRecompute: getOrRecomputeMock,
      } as unknown as WorkspaceCacheService,
      {
        validateBuildAndRunLegacyWorkspaceMigration:
          validateBuildAndRunLegacyWorkspaceMigrationMock,
      } as unknown as WorkspaceMigrationValidateBuildAndRunService,
    );
  });

  const runOnWorkspace = (dryRun = false) =>
    command.runOnWorkspace({
      workspaceId: WORKSPACE_ID,
      options: { dryRun },
      index: 0,
      total: 1,
    });

  const mockWorkspaceCache = ({
    objectExists = true,
    fieldExists = false,
  }: {
    objectExists?: boolean;
    fieldExists?: boolean;
  }) => {
    getOrRecomputeMock.mockResolvedValue({
      flatObjectMetadataMaps: buildByUniversalIdentifierMap(
        objectExists
          ? [
              {
                id: TIMELINE_ACTIVITY_OBJECT_ID,
                universalIdentifier: TIMELINE_ACTIVITY_UNIVERSAL_IDENTIFIER,
              },
            ]
          : [],
      ),
      flatFieldMetadataMaps: buildByUniversalIdentifierMap(
        fieldExists ? [STANDARD_SOURCE_FIELD] : [],
      ),
    });
  };

  it('creates the source field from the standard definition when it is missing', async () => {
    mockWorkspaceCache({});

    await runOnWorkspace();

    const [payload] =
      validateBuildAndRunLegacyWorkspaceMigrationMock.mock.calls[0];

    expect(payload.workspaceId).toBe(WORKSPACE_ID);
    expect(payload.isSystemBuild).toBe(true);
    expect(payload.applicationUniversalIdentifier).toBe(
      STANDARD_APPLICATION.universalIdentifier,
    );
    expect(
      payload.allFlatEntityOperationByMetadataName.fieldMetadata
        .flatEntityToCreate,
    ).toEqual([
      expect.objectContaining({
        universalIdentifier: SOURCE_FIELD_UNIVERSAL_IDENTIFIER,
        name: 'source',
        // View bindings belong to the workspace, not the standard definition.
        viewFieldIds: [],
        viewFieldUniversalIdentifiers: [],
      }),
    ]);
  });

  it('is idempotent when the source field already exists', async () => {
    mockWorkspaceCache({ fieldExists: true });

    await runOnWorkspace();

    expect(
      validateBuildAndRunLegacyWorkspaceMigrationMock,
    ).not.toHaveBeenCalled();
  });

  it('does not write metadata in dry-run mode', async () => {
    mockWorkspaceCache({});

    await runOnWorkspace(true);

    expect(
      validateBuildAndRunLegacyWorkspaceMigrationMock,
    ).not.toHaveBeenCalled();
  });

  it('skips workspaces without a timelineActivity object', async () => {
    mockWorkspaceCache({ objectExists: false });

    await runOnWorkspace();

    expect(
      validateBuildAndRunLegacyWorkspaceMigrationMock,
    ).not.toHaveBeenCalled();
  });

  it('throws when the standard definition is missing the field', async () => {
    mockWorkspaceCache({});
    computeTwentyStandardApplicationAllFlatEntityMapsMock.mockReturnValue({
      allFlatEntityMaps: {
        flatFieldMetadataMaps: buildByUniversalIdentifierMap([]),
      },
    });

    await expect(runOnWorkspace()).rejects.toThrow(
      'Standard application is missing timelineActivity field source',
    );
  });

  it('throws when the migration fails', async () => {
    mockWorkspaceCache({});
    validateBuildAndRunLegacyWorkspaceMigrationMock.mockResolvedValue({
      status: 'fail',
      errors: [],
    });

    await expect(runOnWorkspace()).rejects.toThrow(
      `Failed to add source field for workspace ${WORKSPACE_ID}`,
    );
  });
});
