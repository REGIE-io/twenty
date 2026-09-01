import { Injectable } from '@nestjs/common';
import { STANDARD_OBJECTS } from 'twenty-shared/metadata';
import { FieldMetadataType } from 'twenty-shared/types';

import { PhoneSearchFieldLifecycleService } from 'src/engine/core-modules/phone-search-index/services/phone-search-field-lifecycle.service';
import { PhoneSearchMetadataGateService } from 'src/engine/core-modules/phone-search-index/services/phone-search-metadata-gate.service';
import { InjectMessageQueue } from 'src/engine/core-modules/message-queue/decorators/message-queue.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { MessageQueueService } from 'src/engine/core-modules/message-queue/services/message-queue.service';
import { PhoneSearchIndexJob } from 'src/engine/core-modules/phone-search-index/jobs/phone-search-index.job';
import { type EntityManager } from 'typeorm';

@Injectable()
export class PhoneSearchFieldLifecycleCoordinatorService {
  constructor(
    private readonly lifecycle: PhoneSearchFieldLifecycleService,
    @InjectMessageQueue(MessageQueue.phoneSearchIndexQueue)
    private readonly queue: MessageQueueService,
    private readonly metadataGate?: PhoneSearchMetadataGateService,
  ) {}

  async enqueue(operationIds: string[]): Promise<void> {
    await Promise.all(
      operationIds.map((operationId) =>
        this.queue.add(PhoneSearchIndexJob.name, { operationId }),
      ),
    );
  }

  async afterMigration({
    workspaceId,
    objectMetadataId,
    created,
    updated,
    deleted,
    manager,
    enqueue,
  }: {
    workspaceId: string;
    objectMetadataId: string;
    created: any[];
    updated: any[];
    deleted: any[];
    manager?: EntityManager;
    enqueue?: boolean;
  }): Promise<string[]> {
    // Current services are present while historical workspace commands replay.
    // Do not let a historical PHONES metadata delta query 2.32 core tables.
    if (
      this.metadataGate &&
      !(await this.metadataGate.isInfrastructureAvailable(manager))
    )
      return [];
    const operationIds: string[] = [];
    for (const field of created) {
      if (
        field.type === FieldMetadataType.PHONES &&
        field.objectMetadataUniversalIdentifier ===
          STANDARD_OBJECTS.person.universalIdentifier
      ) {
        const operationId = await this.lifecycle.create({
          workspaceId,
          objectMetadataId,
          fieldMetadataId: field.id,
          fieldUniversalIdentifier: field.universalIdentifier,
          physicalFieldName: field.name,
          isActive: field.isActive,
          manager,
        });
        // The operation is durable before this enqueue. If Redis is down, the
        // reconciler safely delivers it later without exposing an unbuilt field.
        if (operationId) operationIds.push(operationId);
      }
    }
    for (const field of updated) {
      if (
        field.type === FieldMetadataType.PHONES &&
        field.objectMetadataUniversalIdentifier ===
          STANDARD_OBJECTS.person.universalIdentifier
      ) {
        const before = field.before;
        if (!before || before.name !== field.name)
          await this.lifecycle.rename({
            workspaceId,
            objectMetadataId,
            fieldMetadataId: field.id,
            physicalFieldName: field.name,
            manager,
          });
        if (!before || before.isActive !== field.isActive)
          await this.lifecycle.setActive({
            workspaceId,
            objectMetadataId,
            fieldMetadataId: field.id,
            isActive: field.isActive,
            manager,
          });
      }
    }
    for (const field of deleted) {
      if (
        field.type === FieldMetadataType.PHONES &&
        field.objectMetadataUniversalIdentifier ===
          STANDARD_OBJECTS.person.universalIdentifier
      ) {
        const operationId = await this.lifecycle.markDeleting({
          workspaceId,
          objectMetadataId,
          fieldMetadataId: field.id,
          manager,
        });
        if (operationId) operationIds.push(operationId);
      }
    }
    const distinctOperationIds = [...new Set(operationIds)];

    if (enqueue !== false) await this.enqueue(distinctOperationIds);

    return distinctOperationIds;
  }
}
