import { randomUUID } from 'crypto';

import { ConflictException, NotFoundException } from '@nestjs/common';

import { type UpdateWorkspaceMemberProfileInput } from 'src/engine/core-modules/workspace/internal/types/internal-workspace-member-provisioning.type';
import {
  createProfilePostgresFixture,
  type ProfileTestMember,
} from 'test/fixtures/workspace-member-profile-postgres.fixture';
import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';

jest.useRealTimers();

// Never fall back to PG_DATABASE_URL or a loaded .env. This suite creates and
// drops only random workspace schemas in an explicitly named disposable DB.
const databaseUrl = process.env.TWENTY_MEMBER_PROFILE_TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

const deferred = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });

  return { promise, resolve };
};

describePostgres.each([false, true])(
  'workspace member profile PostgreSQL contracts (ORM v2: %s)',
  (isOrmV2Enabled) => {
    let fixture: Awaited<ReturnType<typeof createProfilePostgresFixture>>;
    let workspaceId: string;
    let otherWorkspaceId: string;
    let firstMember: ProfileTestMember;
    let secondMember: ProfileTestMember;

    const update = (
      overrides: Partial<UpdateWorkspaceMemberProfileInput> = {},
    ) =>
      fixture.service.updateWorkspaceMemberProfile({
        workspaceId,
        workspaceMemberId: firstMember.id,
        email: 'updated@example.com',
        firstName: 'Updated',
        lastName: 'Profile',
        profilePolicy: 'provider',
        ...overrides,
      });

    beforeAll(async () => {
      fixture = await createProfilePostgresFixture(
        databaseUrl as string,
        isOrmV2Enabled,
      );
      [workspaceId, otherWorkspaceId] = fixture.workspaceIds;
    });

    beforeEach(async () => {
      fixture.hooks.afterUpdate = undefined;
      fixture.hooks.beforeLock = undefined;
      fixture.forbidCoreAccess.mockClear();

      for (const currentWorkspaceId of fixture.workspaceIds) {
        await fixture.repository(currentWorkspaceId).clear();
      }

      firstMember = {
        id: randomUUID(),
        userId: randomUUID(),
        userEmail: 'first@example.com',
        name: { firstName: 'First', lastName: 'Original' },
        deletedAt: null,
      };
      secondMember = {
        id: randomUUID(),
        userId: randomUUID(),
        userEmail: 'second@example.com',
        name: { firstName: 'Second', lastName: 'Original' },
        deletedAt: null,
      };

      await fixture.repository(workspaceId).insert([firstMember, secondMember]);
    });

    afterEach(() => {
      expect(fixture.forbidCoreAccess).not.toHaveBeenCalled();
    });

    afterAll(async () => {
      await fixture?.close();
    });

    it('updates a provider profile without replacing its member or core user identity', async () => {
      await expect(
        update({ email: ' Updated@Example.Com ', firstName: ' Updated ' }),
      ).resolves.toEqual({ workspaceId, workspaceMemberId: firstMember.id });

      expect(
        await fixture
          .repository(workspaceId)
          .findOneByOrFail({ id: firstMember.id }),
      ).toEqual({
        ...firstMember,
        userEmail: 'updated@example.com',
        name: { firstName: 'Updated', lastName: 'Profile' },
      });
      expect(await fixture.repository(workspaceId).count()).toBe(2);
    });

    it.each([false, true])(
      'rejects a case-insensitive email collision before any names change (deleted: %s)',
      async (isDeleted) => {
        await fixture.repository(workspaceId).update(
          { id: secondMember.id },
          {
            userEmail: '  UPDATED@EXAMPLE.COM  ',
            deletedAt: isDeleted ? new Date() : null,
          },
        );

        await expect(update()).rejects.toBeInstanceOf(ConflictException);
        expect(
          await fixture
            .repository(workspaceId)
            .findOneByOrFail({ id: firstMember.id }),
        ).toEqual(firstMember);
      },
    );

    it('allows exactly one concurrent member to claim the same email', async () => {
      const inputs = [
        { workspaceMemberId: firstMember.id, firstName: 'WinnerOne' },
        { workspaceMemberId: secondMember.id, firstName: 'WinnerTwo' },
      ];
      const results = await Promise.allSettled(
        inputs.map((input) => update(input)),
      );

      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      const winnerIndex = results.findIndex(
        (result) => result.status === 'fulfilled',
      );
      const loserIndex = 1 - winnerIndex;
      const loserResult = results[loserIndex];

      expect(loserResult.status).toBe('rejected');

      if (loserResult.status === 'rejected') {
        expect(loserResult.reason).toBeInstanceOf(ConflictException);
        expect(loserResult.reason.getStatus()).toBe(409);
      }

      const seeds = [firstMember, secondMember];
      const repository = fixture.repository(workspaceId);

      expect(
        await repository.findOneByOrFail({ id: seeds[winnerIndex].id }),
      ).toEqual({
        ...seeds[winnerIndex],
        userEmail: 'updated@example.com',
        name: { firstName: inputs[winnerIndex].firstName, lastName: 'Profile' },
      });
      expect(
        await repository.findOneByOrFail({ id: seeds[loserIndex].id }),
      ).toEqual(seeds[loserIndex]);
    });

    it('keeps the first nonempty name when fill_missing requests overlap', async () => {
      await fixture
        .repository(workspaceId)
        .update(
          { id: firstMember.id },
          { name: { firstName: '', lastName: '' } },
        );
      const firstWritten = deferred();
      const secondLockRequested = deferred();
      const releaseFirst = deferred();
      let lockRequests = 0;

      fixture.hooks.beforeLock = () => {
        if (++lockRequests === 2) secondLockRequested.resolve();
      };
      fixture.hooks.afterUpdate = async () => {
        firstWritten.resolve();
        await releaseFirst.promise;
      };

      const firstUpdate = update({
        email: firstMember.userEmail,
        firstName: 'FirstSaved',
        lastName: 'Name',
        profilePolicy: 'fill_missing',
      });

      await firstWritten.promise;
      const secondUpdate = update({
        email: firstMember.userEmail,
        firstName: 'LaterName',
        lastName: 'LaterLastName',
        profilePolicy: 'fill_missing',
      });

      await secondLockRequested.promise;
      releaseFirst.resolve();
      await Promise.all([firstUpdate, secondUpdate]);

      expect(
        await fixture
          .repository(workspaceId)
          .findOneByOrFail({ id: firstMember.id }),
      ).toEqual({
        ...firstMember,
        name: { firstName: 'FirstSaved', lastName: 'Name' },
      });
    });

    it('scopes lookup, collision checks and writes to the requested workspace', async () => {
      const otherMember = {
        ...firstMember,
        id: randomUUID(),
        userEmail: 'updated@example.com',
      };

      await fixture.repository(otherWorkspaceId).insert(otherMember);
      await expect(
        update({ workspaceMemberId: otherMember.id }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await update();

      expect(
        await fixture
          .repository(otherWorkspaceId)
          .findOneByOrFail({ id: otherMember.id }),
      ).toEqual(otherMember);
    });

    it('rolls back all profile fields on failure and succeeds on retry', async () => {
      fixture.hooks.afterUpdate = async () => {
        throw new Error('fail after PostgreSQL update');
      };

      await expect(update()).rejects.toThrow('fail after PostgreSQL update');
      expect(
        await fixture
          .repository(workspaceId)
          .findOneByOrFail({ id: firstMember.id }),
      ).toEqual(firstMember);

      fixture.hooks.afterUpdate = undefined;
      await update();
      expect(
        (
          await fixture
            .repository(workspaceId)
            .findOneByOrFail({ id: firstMember.id })
        ).userEmail,
      ).toBe('updated@example.com');
    });

    it('observes a concurrent non-PATCH member insert before checking email ownership', async () => {
      const runner = fixture.dataSource.createQueryRunner();

      await runner.connect();
      await runner.startTransaction();

      try {
        await runner.manager
          .getRepository(fixture.repository(workspaceId).target)
          .insert({
            id: randomUUID(),
            userId: randomUUID(),
            userEmail: 'UPDATED@EXAMPLE.COM',
            name: { firstName: 'Concurrent', lastName: 'Member' },
          });
        const lockRequested = deferred();

        fixture.hooks.beforeLock = lockRequested.resolve;
        const pendingUpdate = update();
        const outcome =
          expect(pendingUpdate).rejects.toBeInstanceOf(ConflictException);

        await lockRequested.promise;
        await runner.commitTransaction();
        await outcome;
        expect(
          await fixture
            .repository(workspaceId)
            .findOneByOrFail({ id: firstMember.id }),
        ).toEqual(firstMember);
      } finally {
        if (runner.isTransactionActive) await runner.rollbackTransaction();
        await runner.release();
      }
    });

    it('times out safely on a busy member table while another workspace remains writable', async () => {
      await fixture.repository(otherWorkspaceId).insert(firstMember);
      const runner = fixture.dataSource.createQueryRunner();

      await runner.connect();
      await runner.startTransaction();
      await runner.query(
        `LOCK TABLE "${getWorkspaceSchemaName(workspaceId)}"."workspaceMember" IN ROW EXCLUSIVE MODE`,
      );

      try {
        const pendingUpdate = update();
        const outcome = expect(pendingUpdate).rejects.toMatchObject({
          driverError: { code: '55P03' },
        });

        await update({ workspaceId: otherWorkspaceId });
        await outcome;
        expect(
          await fixture
            .repository(workspaceId)
            .findOneByOrFail({ id: firstMember.id }),
        ).toEqual(firstMember);
      } finally {
        await runner.rollbackTransaction();
        await runner.release();
      }

      await update();
      expect(
        (
          await fixture
            .repository(workspaceId)
            .findOneByOrFail({ id: firstMember.id })
        ).userEmail,
      ).toBe('updated@example.com');
    }, 15000);
  },
);
