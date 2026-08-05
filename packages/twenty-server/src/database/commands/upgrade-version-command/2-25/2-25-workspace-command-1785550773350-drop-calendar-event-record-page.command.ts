import { Command } from 'nest-commander';

import {
  STANDARD_OBJECTS,
  STANDARD_PAGE_LAYOUT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-shared/metadata';
import { isDefined } from 'twenty-shared/utils';

import { ProvisionedWorkspaceCommandRunner } from 'src/database/commands/command-runners/provisioned-workspace.command-runner';
import { WorkspaceIteratorService } from 'src/database/commands/command-runners/workspace-iterator.service';
import { type RunOnWorkspaceArgs } from 'src/database/commands/command-runners/workspace.command-runner';
import { ApplicationService } from 'src/engine/core-modules/application/application.service';
import { RegisteredWorkspaceCommand } from 'src/engine/core-modules/upgrade/decorators/registered-workspace-command.decorator';
import { WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';
import { WorkspaceMigrationValidateBuildAndRunService } from 'src/engine/workspace-manager/workspace-migration/services/workspace-migration-validate-build-and-run-service';

const RECORD_PAGE_VIEW =
  STANDARD_OBJECTS.calendarEvent.views.calendarEventRecordPageFields;
const RECORD_PAGE_LAYOUT =
  STANDARD_PAGE_LAYOUT_UNIVERSAL_IDENTIFIERS.calendarEventRecordPage;

const recordPageViewFieldUniversalIdentifiers = Object.values(
  RECORD_PAGE_VIEW.viewFields,
).map(({ universalIdentifier }) => universalIdentifier);
const recordPageViewFieldGroupUniversalIdentifiers = Object.values(
  RECORD_PAGE_VIEW.viewFieldGroups,
).map(({ universalIdentifier }) => universalIdentifier);
const recordPageLayoutTabUniversalIdentifiers = Object.values(
  RECORD_PAGE_LAYOUT.tabs,
).map(({ universalIdentifier }) => universalIdentifier);
const recordPageLayoutWidgetUniversalIdentifiers = Object.values(
  RECORD_PAGE_LAYOUT.tabs,
).flatMap(({ widgets }) =>
  Object.values(widgets).map(({ universalIdentifier }) => universalIdentifier),
);

@RegisteredWorkspaceCommand('2.25.0', 1785550773350)
@Command({
  name: 'upgrade:2-25:drop-calendar-event-record-page',
  description:
    'Remove the reverted Calendar Event record page metadata from existing workspaces',
})
export class DropCalendarEventRecordPageCommand extends ProvisionedWorkspaceCommandRunner {
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
    const isDryRun = options.dryRun ?? false;
    const {
      flatPageLayoutMaps,
      flatPageLayoutTabMaps,
      flatPageLayoutWidgetMaps,
      flatViewMaps,
      flatViewFieldGroupMaps,
      flatViewFieldMaps,
    } = await this.workspaceCacheService.getOrRecompute(workspaceId, [
      'flatPageLayoutMaps',
      'flatPageLayoutTabMaps',
      'flatPageLayoutWidgetMaps',
      'flatViewMaps',
      'flatViewFieldGroupMaps',
      'flatViewFieldMaps',
    ]);

    const byUniversalIdentifier = <T>(
      maps: { byUniversalIdentifier: Record<string, T | undefined> },
      universalIdentifiers: string[],
    ): T[] =>
      universalIdentifiers
        .map((universalIdentifier) => maps.byUniversalIdentifier[universalIdentifier])
        .filter(isDefined);

    const views = byUniversalIdentifier(flatViewMaps, [
      RECORD_PAGE_VIEW.universalIdentifier,
    ]);
    const viewFieldGroups = byUniversalIdentifier(
      flatViewFieldGroupMaps,
      recordPageViewFieldGroupUniversalIdentifiers,
    );
    const viewFields = byUniversalIdentifier(
      flatViewFieldMaps,
      recordPageViewFieldUniversalIdentifiers,
    );
    const pageLayouts = byUniversalIdentifier(flatPageLayoutMaps, [
      RECORD_PAGE_LAYOUT.universalIdentifier,
    ]);
    const pageLayoutTabs = byUniversalIdentifier(
      flatPageLayoutTabMaps,
      recordPageLayoutTabUniversalIdentifiers,
    );
    const pageLayoutWidgets = byUniversalIdentifier(
      flatPageLayoutWidgetMaps,
      recordPageLayoutWidgetUniversalIdentifiers,
    );

    const total =
      views.length +
      viewFieldGroups.length +
      viewFields.length +
      pageLayouts.length +
      pageLayoutTabs.length +
      pageLayoutWidgets.length;

    if (total === 0) {
      this.logger.log(
        `Calendar Event record page metadata already absent for workspace ${workspaceId}`,
      );

      return;
    }

    this.logger.log(
      `${isDryRun ? '[DRY RUN] ' : ''}Deleting ${total} reverted Calendar Event record page metadata item(s) for workspace ${workspaceId}`,
    );

    if (isDryRun) {
      return;
    }

    const { twentyStandardFlatApplication } =
      await this.applicationService.findWorkspaceTwentyStandardAndCustomApplicationOrThrow(
        { workspaceId },
      );
    const result =
      await this.workspaceMigrationValidateBuildAndRunService.validateBuildAndRunLegacyWorkspaceMigration(
        {
          isSystemBuild: true,
          workspaceId,
          applicationUniversalIdentifier:
            twentyStandardFlatApplication.universalIdentifier,
          allFlatEntityOperationByMetadataName: {
            viewField: { flatEntityToCreate: [], flatEntityToDelete: viewFields, flatEntityToUpdate: [] },
            viewFieldGroup: { flatEntityToCreate: [], flatEntityToDelete: viewFieldGroups, flatEntityToUpdate: [] },
            view: { flatEntityToCreate: [], flatEntityToDelete: views, flatEntityToUpdate: [] },
            pageLayoutWidget: { flatEntityToCreate: [], flatEntityToDelete: pageLayoutWidgets, flatEntityToUpdate: [] },
            pageLayoutTab: { flatEntityToCreate: [], flatEntityToDelete: pageLayoutTabs, flatEntityToUpdate: [] },
            pageLayout: { flatEntityToCreate: [], flatEntityToDelete: pageLayouts, flatEntityToUpdate: [] },
          },
        },
      );

    if (result.status === 'fail') {
      throw new Error(
        `Failed to delete Calendar Event record page metadata for workspace ${workspaceId}: ${JSON.stringify(result, null, 2)}`,
      );
    }
  }
}
