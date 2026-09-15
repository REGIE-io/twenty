import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { type DataSource, type EntityManager } from 'typeorm';

@Injectable()
export class PhoneSearchFieldLifecycleService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async create({
    workspaceId,
    objectMetadataId,
    fieldMetadataId,
    fieldUniversalIdentifier,
    physicalFieldName,
    isActive,
    manager: suppliedManager,
  }: {
    workspaceId: string;
    objectMetadataId: string;
    fieldMetadataId: string;
    fieldUniversalIdentifier: string;
    physicalFieldName: string;
    isActive: boolean;
    manager?: EntityManager;
  }): Promise<string | undefined> {
    // A new field has no projection yet.  In particular, never mark it READY
    // merely because its metadata transaction committed: that would make an
    // empty lookup a false negative until a later record write happened.
    const execute = async (manager: EntityManager) => {
      const [pendingAddFieldOperation] = await manager.query<
        Array<{ id: string; generation: string }>
      >(
        `SELECT id, generation
           FROM core."phoneSearchIndexOperation"
          WHERE "workspaceId" = $1 AND "objectMetadataId" = $2
            AND kind = 'ADD_FIELD' AND status = 'PENDING'
          FOR UPDATE`,
        [workspaceId, objectMetadataId],
      );
      let generation = Number(pendingAddFieldOperation?.generation);

      if (!pendingAddFieldOperation) {
        const [generationRow] = await manager.query<
          Array<{ generation: string }>
        >(
          `SELECT COALESCE(MAX(GREATEST(COALESCE("activeProjectionGeneration", 0), COALESCE("buildingProjectionGeneration", 0))), 0) + 1 AS generation
             FROM core."phoneSearchFieldState"
            WHERE "workspaceId" = $1 AND "objectMetadataId" = $2`,
          [workspaceId, objectMetadataId],
        );

        generation = Number(generationRow?.generation ?? 1);
      }
      const inserted = await manager.query<Array<{ fieldMetadataId: string }>>(
        `INSERT INTO core."phoneSearchFieldState" ("workspaceId", "objectMetadataId", "fieldMetadataId", "fieldUniversalIdentifier", "physicalFieldName", "syncStatus", "isQueryEnabled", "buildingProjectionGeneration", "configurationGeneration")
         VALUES ($1,$2,$3,$4,$5,'INDEXING',$6,$7,1)
         ON CONFLICT ("workspaceId","objectMetadataId","fieldMetadataId") DO NOTHING
         RETURNING "fieldMetadataId"`,
        [
          workspaceId,
          objectMetadataId,
          fieldMetadataId,
          fieldUniversalIdentifier,
          physicalFieldName,
          isActive,
          generation,
        ],
      );
      if (!inserted.length) return undefined;

      if (pendingAddFieldOperation) {
        await manager.query(
          `UPDATE core."phoneSearchIndexOperation"
              SET "fieldMetadataIds" = "fieldMetadataIds" || $2::jsonb,
                  "updatedAt" = now()
            WHERE id = $1`,
          [pendingAddFieldOperation.id, JSON.stringify([fieldMetadataId])],
        );

        return pendingAddFieldOperation.id;
      }

      const [operation] = await manager.query<Array<{ id: string }>>(
        `INSERT INTO core."phoneSearchIndexOperation" ("workspaceId","objectMetadataId",kind,status,generation,"fieldMetadataIds")
         VALUES ($1,$2,'ADD_FIELD','PENDING',$3,$4::jsonb)
         RETURNING id`,
        [
          workspaceId,
          objectMetadataId,
          generation,
          JSON.stringify([fieldMetadataId]),
        ],
      );
      return operation?.id;
    };
    return suppliedManager
      ? execute(suppliedManager)
      : this.dataSource.transaction(execute);
  }

  async rename({
    workspaceId,
    objectMetadataId,
    fieldMetadataId,
    physicalFieldName,
    manager,
  }: {
    workspaceId: string;
    objectMetadataId: string;
    fieldMetadataId: string;
    physicalFieldName: string;
    manager?: EntityManager;
  }): Promise<void> {
    await (manager ?? this.dataSource).query(
      `UPDATE core."phoneSearchFieldState" SET "physicalFieldName" = $4, "configurationGeneration" = "configurationGeneration" + 1, "updatedAt" = now() WHERE "workspaceId" = $1 AND "objectMetadataId" = $2 AND "fieldMetadataId" = $3`,
      [workspaceId, objectMetadataId, fieldMetadataId, physicalFieldName],
    );
  }

  async setActive({
    workspaceId,
    objectMetadataId,
    fieldMetadataId,
    isActive,
    manager,
  }: {
    workspaceId: string;
    objectMetadataId: string;
    fieldMetadataId: string;
    isActive: boolean;
    manager?: EntityManager;
  }): Promise<void> {
    await (manager ?? this.dataSource).query(
      `UPDATE core."phoneSearchFieldState" SET "isQueryEnabled" = $4 AND "activeProjectionGeneration" IS NOT NULL, "updatedAt" = now() WHERE "workspaceId" = $1 AND "objectMetadataId" = $2 AND "fieldMetadataId" = $3`,
      [workspaceId, objectMetadataId, fieldMetadataId, isActive],
    );
  }

  async markDeleting({
    workspaceId,
    objectMetadataId,
    fieldMetadataId,
    manager: suppliedManager,
  }: {
    workspaceId: string;
    objectMetadataId: string;
    fieldMetadataId: string;
    manager?: EntityManager;
  }): Promise<string | undefined> {
    const execute = async (manager: EntityManager) => {
      await manager.query(
        `UPDATE core."phoneSearchFieldState" SET "syncStatus" = 'DELETING', "isQueryEnabled" = false, "updatedAt" = now() WHERE "workspaceId" = $1 AND "objectMetadataId" = $2 AND "fieldMetadataId" = $3`,
        [workspaceId, objectMetadataId, fieldMetadataId],
      );
      const [operation] = await manager.query<Array<{ id: string }>>(
        `INSERT INTO core."phoneSearchIndexOperation" ("workspaceId","objectMetadataId",kind,status,generation,"fieldMetadataIds") VALUES ($1,$2,'PURGE_FIELD','PENDING',0,$3::jsonb) ON CONFLICT DO NOTHING RETURNING id`,
        [workspaceId, objectMetadataId, JSON.stringify([fieldMetadataId])],
      );
      return operation?.id;
    };
    return suppliedManager
      ? execute(suppliedManager)
      : this.dataSource.transaction(execute);
  }
}
