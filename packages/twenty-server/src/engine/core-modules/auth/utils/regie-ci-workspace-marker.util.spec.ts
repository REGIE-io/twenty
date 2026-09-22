import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { InternalWorkspaceProvisioningDto } from 'src/engine/core-modules/auth/dto/internal-workspace-provisioning.dto';
import {
  isValidRegieCiWorkspaceMarker,
  isRegieCiWorkspaceOwner,
  sameRegieCiWorkspaceOwner,
} from 'src/engine/core-modules/auth/utils/regie-ci-workspace-marker.util';

describe('CI workspace ownership', () => {
  const ciOwner = {
    repository: 'REGIE-io/go',
    runId: '123',
    runAttempt: 1,
    job: 'crm-api-records',
  };
  const marker = {
    ephemeral: true as const,
    organizationId: 'org_e2e_run_1',
    workspaceSlug: 'org-e2e-run-1',
    owner: 'go-crm-ci' as const,
    ciOwner,
    issuedAt: '2026-09-22T12:00:00.000Z',
    expiresAt: '2026-09-22T13:00:00.000Z',
  };

  it('requires the complete owner and fixed server lease on the exact ephemeral workspace', () => {
    expect(isValidRegieCiWorkspaceMarker(marker, marker.workspaceSlug)).toBe(
      true,
    );
    for (const invalid of [
      { ...marker, organizationId: 'org_customer' },
      { ...marker, workspaceSlug: 'org-e2e-other' },
      { ...marker, expiresAt: 'invalid' },
      { ...marker, expiresAt: '2026-09-22T14:00:00.000Z' },
      { ...marker, issuedAt: undefined },
      { ...marker, ciOwner: { ...ciOwner, runAttempt: 0 } },
      { ...marker, ciOwner: { ...ciOwner, repository: 'arbitrary' } },
      { ...marker, ciOwner: undefined },
    ]) {
      expect(isValidRegieCiWorkspaceMarker(invalid, marker.workspaceSlug)).toBe(
        false,
      );
    }
  });

  it('never conflates another repository, job, run or attempt with the recorded owner', () => {
    expect(sameRegieCiWorkspaceOwner(ciOwner, { ...ciOwner })).toBe(true);
    for (const other of [
      undefined,
      { ...ciOwner, repository: 'other/go' },
      { ...ciOwner, runId: '124' },
      { ...ciOwner, runAttempt: 2 },
      { ...ciOwner, job: 'crm-api-schema' },
    ]) {
      expect(sameRegieCiWorkspaceOwner(ciOwner, other)).toBe(false);
    }
  });

  it.each([
    'CRM API (records)',
    'Provider verification (salesforce, deterministic)',
  ])(
    'accepts the exact workflow display name %s in both the DTO and persisted owner',
    async (job) => {
      const owner = { ...ciOwner, job };
      const payload = {
        name: 'CI',
        slug: marker.workspaceSlug,
        ephemeral: true,
        organizationId: marker.organizationId,
        ciOwner: owner,
      };

      expect(isRegieCiWorkspaceOwner(owner)).toBe(true);
      expect(
        isValidRegieCiWorkspaceMarker(
          { ...marker, ciOwner: owner },
          marker.workspaceSlug,
        ),
      ).toBe(true);
      expect(
        await validate(
          plainToInstance(InternalWorkspaceProvisioningDto, payload),
          { whitelist: true, forbidNonWhitelisted: true },
        ),
      ).toEqual([]);
    },
  );

  it.each([
    'CRM API (records)\n',
    'CRM\nAPI',
    '<bad>',
    'CRM\tAPI',
    'x'.repeat(129),
  ])(
    'rejects invalid job identity %j in both the DTO and persisted owner',
    async (job) => {
      const owner = { ...ciOwner, job };
      const payload = {
        name: 'CI',
        slug: marker.workspaceSlug,
        ephemeral: true,
        organizationId: marker.organizationId,
        ciOwner: owner,
      };

      expect(isRegieCiWorkspaceOwner(owner)).toBe(false);
      expect(
        isValidRegieCiWorkspaceMarker(
          { ...marker, ciOwner: owner },
          marker.workspaceSlug,
        ),
      ).toBe(false);
      expect(
        await validate(
          plainToInstance(InternalWorkspaceProvisioningDto, payload),
          { whitelist: true, forbidNonWhitelisted: true },
        ),
      ).not.toEqual([]);
    },
  );

  it('does not broaden run identifiers when accepting human-readable job names', () => {
    expect(
      isRegieCiWorkspaceOwner({ ...ciOwner, runId: 'CRM API (records)' }),
    ).toBe(false);
    for (const value of [null, undefined, 'marker', [], 123]) {
      expect(isValidRegieCiWorkspaceMarker(value, marker.workspaceSlug)).toBe(
        false,
      );
    }
  });

  it('rejects caller-selected expiry and unknown nested owner fields at the HTTP DTO boundary', async () => {
    const payload = {
      name: 'CI',
      slug: marker.workspaceSlug,
      ephemeral: true,
      organizationId: marker.organizationId,
      ciOwner,
    };
    const options = { whitelist: true, forbidNonWhitelisted: true };

    expect(
      await validate(
        plainToInstance(InternalWorkspaceProvisioningDto, payload),
        options,
      ),
    ).toEqual([]);
    expect(
      await validate(
        plainToInstance(InternalWorkspaceProvisioningDto, {
          ...payload,
          expiresAt: marker.expiresAt,
        }),
        options,
      ),
    ).not.toEqual([]);
    expect(
      await validate(
        plainToInstance(InternalWorkspaceProvisioningDto, {
          ...payload,
          ciOwner: { ...ciOwner, expiry: 999 },
        }),
        options,
      ),
    ).not.toEqual([]);
    expect(
      await validate(
        plainToInstance(InternalWorkspaceProvisioningDto, {
          ...payload,
          ciOwner: { ...ciOwner, runAttempt: '1' },
        }),
        options,
      ),
    ).not.toEqual([]);
  });
});
