import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
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
import { WorkspaceService } from 'src/engine/core-modules/workspace/services/workspace.service';

type BackfillOptions = {
  apply: boolean;
  createdBefore: string;
  maxCandidates: number;
  expectedCount?: number;
  expectedSha256?: string;
};

type Candidate = {
  workspaceId: string;
  workspaceSlug: string;
  createdAt: string;
};

const MAX_CANDIDATES_PER_RUN = 100;

export type RegieLegacyE2eOrphanQuarantineBackfillResult = {
  applied: boolean;
  createdBefore: string;
  maxCandidates: number;
  sha256: string;
  count: number;
  quarantined: number;
  marked: number;
  candidates: Candidate[];
};

@Injectable()
export class RegieLegacyE2eOrphanQuarantineBackfillWorkspaceService {
  private readonly logger = new Logger(
    RegieLegacyE2eOrphanQuarantineBackfillWorkspaceService.name,
  );

  constructor(
    @InjectRepository(WorkspaceEntity)
    private readonly workspaceRepository: Repository<WorkspaceEntity>,
    @InjectRepository(KeyValuePairEntity)
    private readonly markerRepository: Repository<KeyValuePairEntity>,
    private readonly workspaceService: WorkspaceService,
  ) {}

  async run({
    apply,
    createdBefore,
    maxCandidates,
    expectedCount,
    expectedSha256,
  }: BackfillOptions): Promise<RegieLegacyE2eOrphanQuarantineBackfillResult> {
    const cutoff = new Date(createdBefore);

    if (Number.isNaN(cutoff.getTime())) {
      throw new Error('--created-before must be a valid ISO timestamp');
    }
    if (
      !Number.isSafeInteger(maxCandidates) ||
      maxCandidates < 1 ||
      maxCandidates > MAX_CANDIDATES_PER_RUN
    ) {
      throw new Error(
        `--max-candidates must be an integer between 1 and ${MAX_CANDIDATES_PER_RUN}`,
      );
    }

    const candidates = await this.findCandidates(cutoff, maxCandidates);
    const sha256 = this.fingerprint(candidates);

    if (apply) {
      this.assertReviewedCandidateSet(
        candidates.length,
        sha256,
        expectedCount,
        expectedSha256,
      );
    }

    let quarantined = 0;
    let marked = 0;

    if (apply) {
      for (const candidate of candidates) {
        await this.workspaceService.deleteWorkspace(
          candidate.workspaceId,
          true,
        );
        quarantined += 1;

        const authorizedAt = new Date();

        await this.markerRepository.insert({
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
        });
        marked += 1;

        if (marked % 25 === 0 || marked === candidates.length) {
          this.logger.log(
            `Quarantined and marked ${marked}/${candidates.length} reviewed legacy E2E orphans`,
          );
        }
      }
    }

    return {
      applied: apply,
      createdBefore: cutoff.toISOString(),
      maxCandidates,
      sha256,
      count: candidates.length,
      quarantined,
      marked,
      candidates,
    };
  }

  private async findCandidates(
    cutoff: Date,
    maxCandidates: number,
  ): Promise<Candidate[]> {
    const workspaces = await this.workspaceRepository
      .createQueryBuilder('workspace')
      .withDeleted()
      .where('workspace.deletedAt IS NULL')
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
      .take(maxCandidates)
      .getMany();

    return workspaces.map((workspace) => ({
      workspaceId: workspace.id,
      workspaceSlug: workspace.subdomain,
      createdAt: workspace.createdAt.toISOString(),
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
