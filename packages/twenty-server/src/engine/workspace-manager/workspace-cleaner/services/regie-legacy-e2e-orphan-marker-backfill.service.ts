import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { type Repository } from 'typeorm';

import {
  REGIE_E2E_WORKSPACE_MARKER_KEY,
  REGIE_E2E_WORKSPACE_SLUG_PREFIX,
  REGIE_LEGACY_E2E_ORPHAN_MARKER_KEY,
  REGIE_LEGACY_E2E_ORPHAN_MARKER_KIND,
  REGIE_LEGACY_E2E_ORPHAN_MARKER_SOURCE,
  type RegieLegacyE2eOrphanMarker,
} from 'src/engine/core-modules/auth/constants/regie-e2e-workspace-marker.constant';
import {
  KeyValuePairEntity,
  KeyValuePairType,
} from 'src/engine/core-modules/key-value-pair/key-value-pair.entity';
import { WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';

type BackfillOptions = {
  apply: boolean;
  createdBefore: string;
  expectedCount?: number;
  expectedSha256?: string;
};

type Candidate = {
  workspaceId: string;
  workspaceSlug: string;
  createdAt: string;
  quarantinedAt: string;
};

export type RegieLegacyE2eOrphanMarkerBackfillResult = {
  applied: boolean;
  createdBefore: string;
  authorizedAt: string | null;
  sha256: string;
  count: number;
  candidates: Candidate[];
};

@Injectable()
export class RegieLegacyE2eOrphanMarkerBackfillService {
  constructor(
    @InjectRepository(WorkspaceEntity)
    private readonly workspaceRepository: Repository<WorkspaceEntity>,
    @InjectRepository(KeyValuePairEntity)
    private readonly markerRepository: Repository<KeyValuePairEntity>,
  ) {}

  async run({
    apply,
    createdBefore,
    expectedCount,
    expectedSha256,
  }: BackfillOptions): Promise<RegieLegacyE2eOrphanMarkerBackfillResult> {
    const cutoff = new Date(createdBefore);

    if (Number.isNaN(cutoff.getTime())) {
      throw new Error('--created-before must be a valid ISO timestamp');
    }

    const candidates = await this.findCandidates(cutoff);
    const sha256 = this.fingerprint(candidates);

    if (apply) {
      this.assertReviewedCandidateSet(
        candidates.length,
        sha256,
        expectedCount,
        expectedSha256,
      );
    }

    const authorizedAt = apply ? new Date() : null;

    if (authorizedAt) {
      await this.markerRepository.manager.transaction(async (manager) => {
        const repository = manager.getRepository(KeyValuePairEntity);

        for (let offset = 0; offset < candidates.length; offset += 100) {
          const batch = candidates.slice(offset, offset + 100);

          await repository.insert(
            batch.map((candidate) => ({
              key: REGIE_LEGACY_E2E_ORPHAN_MARKER_KEY,
              type: KeyValuePairType.USER_VARIABLE,
              workspaceId: candidate.workspaceId,
              userId: null,
              applicationId: null,
              value: {
                ephemeral: true,
                kind: REGIE_LEGACY_E2E_ORPHAN_MARKER_KIND,
                workspaceId: candidate.workspaceId,
                workspaceSlug: candidate.workspaceSlug,
                authorizedAt: authorizedAt.toISOString(),
                source: REGIE_LEGACY_E2E_ORPHAN_MARKER_SOURCE,
              } as RegieLegacyE2eOrphanMarker as unknown as JSON,
            })),
          );
        }
      });
    }

    return {
      applied: apply,
      createdBefore: cutoff.toISOString(),
      authorizedAt: authorizedAt?.toISOString() ?? null,
      sha256,
      count: candidates.length,
      candidates,
    };
  }

  private async findCandidates(cutoff: Date): Promise<Candidate[]> {
    const workspaces = await this.workspaceRepository
      .createQueryBuilder('workspace')
      .withDeleted()
      .where('workspace.deletedAt IS NOT NULL')
      .andWhere('workspace."deletionRequestedAt" IS NULL')
      .andWhere('workspace.subdomain LIKE :slugPrefix', {
        slugPrefix: `${REGIE_E2E_WORKSPACE_SLUG_PREFIX}%`,
      })
      .andWhere('workspace.createdAt < :cutoff', { cutoff })
      .andWhere(
        `NOT EXISTS (
          SELECT 1
          FROM core."keyValuePair" marker
          WHERE marker."workspaceId" = workspace.id
            AND marker.key IN (:...markerKeys)
        )`,
        {
          markerKeys: [
            REGIE_E2E_WORKSPACE_MARKER_KEY,
            REGIE_LEGACY_E2E_ORPHAN_MARKER_KEY,
          ],
        },
      )
      .orderBy('workspace.id', 'ASC')
      .getMany();

    return workspaces.map((workspace) => ({
      workspaceId: workspace.id,
      workspaceSlug: workspace.subdomain,
      createdAt: workspace.createdAt.toISOString(),
      quarantinedAt: workspace.deletedAt!.toISOString(),
    }));
  }

  private fingerprint(candidates: Candidate[]): string {
    const canonical = candidates
      .map(
        ({ workspaceId, workspaceSlug }) => `${workspaceId}\t${workspaceSlug}`,
      )
      .join('\n');

    return createHash('sha256').update(canonical).digest('hex');
  }

  private assertReviewedCandidateSet(
    count: number,
    sha256: string,
    expectedCount?: number,
    expectedSha256?: string,
  ): void {
    if (!Number.isSafeInteger(expectedCount) || expectedCount! < 0) {
      throw new Error('--expected-count is required in apply mode');
    }

    if (!/^[a-f0-9]{64}$/i.test(expectedSha256 ?? '')) {
      throw new Error('--expected-sha256 is required in apply mode');
    }

    if (count !== expectedCount || sha256 !== expectedSha256?.toLowerCase()) {
      throw new Error(
        `Candidate set changed: actual count=${count} sha256=${sha256}`,
      );
    }
  }
}
