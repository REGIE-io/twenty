import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { type Repository } from 'typeorm';

import {
  REGIE_E2E_ORGANIZATION_ID_PREFIX,
  REGIE_E2E_WORKSPACE_MARKER_KEY,
  REGIE_E2E_WORKSPACE_SLUG_PREFIX,
  type RegieE2eWorkspaceMarker,
} from 'src/engine/core-modules/auth/constants/regie-e2e-workspace-marker.constant';
import {
  KeyValuePairEntity,
  KeyValuePairType,
} from 'src/engine/core-modules/key-value-pair/key-value-pair.entity';
import { WorkspaceService } from 'src/engine/core-modules/workspace/services/workspace.service';

export type RegieE2eWorkspaceQuarantineBackfillMode = 'all' | 'limited';

export type RegieE2eWorkspaceQuarantineBackfillResult = {
  mode: RegieE2eWorkspaceQuarantineBackfillMode;
  applied: boolean;
  requestedOrganizationIds: string[];
  unresolvedOrganizationIds: string[];
  candidates: Array<{
    organizationId: string;
    workspaceId: string;
    workspaceSlug: string;
  }>;
  alreadyQuarantined: Array<{
    organizationId: string;
    workspaceId: string;
    workspaceSlug: string;
    quarantinedAt: string;
  }>;
  quarantinedWorkspaceIds: string[];
  counts: {
    requested: number;
    unresolved: number;
    candidates: number;
    alreadyQuarantined: number;
    quarantined: number;
  };
};

type BackfillOptions = {
  mode: RegieE2eWorkspaceQuarantineBackfillMode;
  apply: boolean;
  organizationIds?: string[];
};

@Injectable()
export class RegieE2eWorkspaceQuarantineBackfillWorkspaceService {
  constructor(
    @InjectRepository(KeyValuePairEntity)
    private readonly markerRepository: Repository<KeyValuePairEntity>,
    private readonly workspaceService: WorkspaceService,
  ) {}

  async run({
    mode,
    apply,
    organizationIds = [],
  }: BackfillOptions): Promise<RegieE2eWorkspaceQuarantineBackfillResult> {
    const requestedOrganizationIds = [
      ...new Set(organizationIds.map((id) => id.trim()).filter(Boolean)),
    ].sort();

    this.assertOptions(mode, requestedOrganizationIds);

    const markerRows = await this.findSafeMarkerRows(
      mode === 'limited' ? requestedOrganizationIds : undefined,
    );
    const matchingIds = new Set(
      markerRows.map(
        (row) =>
          (row.value as unknown as RegieE2eWorkspaceMarker).organizationId,
      ),
    );
    const unresolvedOrganizationIds = requestedOrganizationIds.filter(
      (id) => !matchingIds.has(id),
    );

    if (apply && unresolvedOrganizationIds.length > 0) {
      throw new Error(
        `Refusing partial apply: no single safe workspace matched organization IDs: ${unresolvedOrganizationIds.join(', ')}`,
      );
    }

    const candidates: RegieE2eWorkspaceQuarantineBackfillResult['candidates'] =
      [];
    const alreadyQuarantined: RegieE2eWorkspaceQuarantineBackfillResult['alreadyQuarantined'] =
      [];

    for (const markerRow of markerRows) {
      const marker = markerRow.value as unknown as RegieE2eWorkspaceMarker;
      const identity = {
        organizationId: marker.organizationId,
        workspaceId: markerRow.workspace.id,
        workspaceSlug: markerRow.workspace.subdomain,
      };

      if (markerRow.workspace.deletedAt) {
        alreadyQuarantined.push({
          ...identity,
          quarantinedAt: markerRow.workspace.deletedAt.toISOString(),
        });
      } else {
        candidates.push(identity);
      }
    }

    const quarantinedWorkspaceIds: string[] = [];

    if (apply) {
      for (const candidate of candidates) {
        await this.workspaceService.deleteWorkspace(
          candidate.workspaceId,
          true,
        );
        quarantinedWorkspaceIds.push(candidate.workspaceId);
      }
    }

    return {
      mode,
      applied: apply,
      requestedOrganizationIds,
      unresolvedOrganizationIds,
      candidates,
      alreadyQuarantined,
      quarantinedWorkspaceIds,
      counts: {
        requested: requestedOrganizationIds.length,
        unresolved: unresolvedOrganizationIds.length,
        candidates: candidates.length,
        alreadyQuarantined: alreadyQuarantined.length,
        quarantined: quarantinedWorkspaceIds.length,
      },
    };
  }

  private assertOptions(
    mode: RegieE2eWorkspaceQuarantineBackfillMode,
    organizationIds: string[],
  ): void {
    if (mode === 'all' && organizationIds.length > 0) {
      throw new Error('--all cannot be combined with --organization-ids');
    }

    if (mode === 'limited' && organizationIds.length === 0) {
      throw new Error(
        'Limited mode requires at least one --organization-ids value',
      );
    }

    const invalidIds = organizationIds.filter(
      (id) => !id.startsWith(REGIE_E2E_ORGANIZATION_ID_PREFIX),
    );

    if (invalidIds.length > 0) {
      throw new Error(
        `Every organization ID must start with ${REGIE_E2E_ORGANIZATION_ID_PREFIX}: ${invalidIds.join(', ')}`,
      );
    }
  }

  private async findSafeMarkerRows(
    organizationIds?: string[],
  ): Promise<KeyValuePairEntity[]> {
    const query = this.markerRepository
      .createQueryBuilder('marker')
      .withDeleted()
      .innerJoinAndSelect('marker.workspace', 'workspace')
      .where('marker.key = :key', { key: REGIE_E2E_WORKSPACE_MARKER_KEY })
      .andWhere('marker.type = :type', {
        type: KeyValuePairType.USER_VARIABLE,
      })
      .andWhere("marker.value ->> 'ephemeral' = 'true'")
      .andWhere(
        "marker.value ->> 'organizationId' LIKE 'org\\_e2e\\_%' ESCAPE '\\'",
      )
      .andWhere("marker.value ->> 'workspaceSlug' = workspace.subdomain")
      .andWhere("workspace.subdomain LIKE 'org-e2e-%'")
      .orderBy("marker.value ->> 'organizationId'", 'ASC')
      .addOrderBy('workspace.id', 'ASC');

    if (organizationIds !== undefined) {
      query.andWhere(
        "marker.value ->> 'organizationId' IN (:...organizationIds)",
        { organizationIds },
      );
    }

    const rows = (await query.getMany()).filter((row) => this.isSafe(row));
    const duplicateOrganizationIds = rows
      .map(
        (row) =>
          (row.value as unknown as RegieE2eWorkspaceMarker).organizationId,
      )
      .filter((id, index, ids) => ids.indexOf(id) !== index);

    if (duplicateOrganizationIds.length > 0) {
      throw new Error(
        `Refusing ambiguous marker matches for organization IDs: ${[
          ...new Set(duplicateOrganizationIds),
        ].join(', ')}`,
      );
    }

    return rows;
  }

  private isSafe(markerRow: KeyValuePairEntity): boolean {
    const marker = markerRow.value as unknown as RegieE2eWorkspaceMarker | null;
    const subdomain = markerRow.workspace.subdomain;

    return (
      marker?.ephemeral === true &&
      typeof marker.organizationId === 'string' &&
      marker.organizationId.startsWith(REGIE_E2E_ORGANIZATION_ID_PREFIX) &&
      marker.workspaceSlug === subdomain &&
      subdomain.startsWith(REGIE_E2E_WORKSPACE_SLUG_PREFIX)
    );
  }
}
