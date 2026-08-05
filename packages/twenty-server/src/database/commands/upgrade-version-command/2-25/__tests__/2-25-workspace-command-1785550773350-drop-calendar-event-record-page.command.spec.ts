import {
  STANDARD_OBJECTS,
  STANDARD_PAGE_LAYOUT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-shared/metadata';

import { type WorkspaceIteratorService } from 'src/database/commands/command-runners/workspace-iterator.service';
import { DropCalendarEventRecordPageCommand } from 'src/database/commands/upgrade-version-command/2-25/2-25-workspace-command-1785550773350-drop-calendar-event-record-page.command';
import { type ApplicationService } from 'src/engine/core-modules/application/application.service';
import { type WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';
import { type WorkspaceMigrationValidateBuildAndRunService } from 'src/engine/workspace-manager/workspace-migration/services/workspace-migration-validate-build-and-run-service';

const WORKSPACE_ID = '20202020-0000-4000-8000-000000000001';
const STANDARD_APPLICATION = {
  universalIdentifier: '20202020-0000-4000-8000-000000000002',
};
const APP_OWNED_LAYOUT_ID = '20202020-0000-4000-8000-000000000003';
const APP_OWNED_VIEW_ID = '20202020-0000-4000-8000-000000000004';

const recordPageView =
  STANDARD_OBJECTS.calendarEvent.views.calendarEventRecordPageFields;
const recordPageLayout =
  STANDARD_PAGE_LAYOUT_UNIVERSAL_IDENTIFIERS.calendarEventRecordPage;

const buildMap = (universalIdentifiers: string[]) => ({
  byUniversalIdentifier: Object.fromEntries(
    universalIdentifiers.map((universalIdentifier) => [
      universalIdentifier,
      { universalIdentifier },
    ]),
  ),
});

describe('DropCalendarEventRecordPageCommand', () => {
  let command: DropCalendarEventRecordPageCommand;
  let getOrRecomputeMock: jest.Mock;
  let validateBuildAndRunLegacyWorkspaceMigrationMock: jest.Mock;

  beforeEach(() => {
    getOrRecomputeMock = jest.fn();
    validateBuildAndRunLegacyWorkspaceMigrationMock = jest
      .fn()
      .mockResolvedValue({ status: 'success' });

    command = new DropCalendarEventRecordPageCommand(
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

  it('drops only the reverted standard metadata and leaves app-owned Calendar Event pages alone', async () => {
    getOrRecomputeMock.mockResolvedValue({
      flatViewMaps: buildMap([
        recordPageView.universalIdentifier,
        APP_OWNED_VIEW_ID,
      ]),
      flatViewFieldGroupMaps: buildMap(
        Object.values(recordPageView.viewFieldGroups).map(
          ({ universalIdentifier }) => universalIdentifier,
        ),
      ),
      flatViewFieldMaps: buildMap(
        Object.values(recordPageView.viewFields).map(
          ({ universalIdentifier }) => universalIdentifier,
        ),
      ),
      flatPageLayoutMaps: buildMap([
        recordPageLayout.universalIdentifier,
        APP_OWNED_LAYOUT_ID,
      ]),
      flatPageLayoutTabMaps: buildMap(
        Object.values(recordPageLayout.tabs).map(
          ({ universalIdentifier }) => universalIdentifier,
        ),
      ),
      flatPageLayoutWidgetMaps: buildMap(
        Object.values(recordPageLayout.tabs).flatMap(({ widgets }) =>
          Object.values(widgets).map(
            ({ universalIdentifier }) => universalIdentifier,
          ),
        ),
      ),
    });

    await command.runOnWorkspace({
      workspaceId: WORKSPACE_ID,
      options: {},
      index: 0,
      total: 1,
    });

    const operations =
      validateBuildAndRunLegacyWorkspaceMigrationMock.mock.calls[0][0]
        .allFlatEntityOperationByMetadataName;

    expect(operations.view.flatEntityToDelete).toEqual([
      expect.objectContaining({
        universalIdentifier: recordPageView.universalIdentifier,
      }),
    ]);
    expect(operations.pageLayout.flatEntityToDelete).toEqual([
      expect.objectContaining({
        universalIdentifier: recordPageLayout.universalIdentifier,
      }),
    ]);
    expect(operations.view.flatEntityToDelete).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ universalIdentifier: APP_OWNED_VIEW_ID }),
      ]),
    );
    expect(operations.pageLayout.flatEntityToDelete).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ universalIdentifier: APP_OWNED_LAYOUT_ID }),
      ]),
    );
  });

  it('is a no-op when a workspace has already removed the reverted standard page', async () => {
    getOrRecomputeMock.mockResolvedValue({
      flatViewMaps: buildMap([APP_OWNED_VIEW_ID]),
      flatViewFieldGroupMaps: buildMap([]),
      flatViewFieldMaps: buildMap([]),
      flatPageLayoutMaps: buildMap([APP_OWNED_LAYOUT_ID]),
      flatPageLayoutTabMaps: buildMap([]),
      flatPageLayoutWidgetMaps: buildMap([]),
    });

    await command.runOnWorkspace({
      workspaceId: WORKSPACE_ID,
      options: {},
      index: 0,
      total: 1,
    });

    expect(
      validateBuildAndRunLegacyWorkspaceMigrationMock,
    ).not.toHaveBeenCalled();
  });
});
