import { useCallback, useEffect, useMemo } from 'react';

import { useListenToObjectRecordOperationBrowserEvent } from '@/browser-event/hooks/useListenToObjectRecordOperationBrowserEvent';
import { useObjectMetadataItem } from '@/object-metadata/hooks/useObjectMetadataItem';
import { useListenToEventsForQuery } from '@/sse-db-event/hooks/useListenToEventsForQuery';

const SHARED_HISTORY_REFRESH_MS = 30_000;

type UseSubscribeTimelineToParticipantChangesParams = {
  queryId: string;
  participantObjectNameSingular: string;
  relatedPersonIds: string[];
  refetch: () => void;
};

export const useSubscribeTimelineToParticipantChanges = ({
  queryId,
  participantObjectNameSingular,
  relatedPersonIds,
  refetch,
}: UseSubscribeTimelineToParticipantChangesParams) => {
  const { objectMetadataItem: participantMetadata } = useObjectMetadataItem({
    objectNameSingular: participantObjectNameSingular,
  });

  const { objectMetadataItem: personMetadata } = useObjectMetadataItem({
    objectNameSingular: 'person',
  });
  const hasRelatedPersonIds = relatedPersonIds.length > 0;

  const operationSignature = useMemo(
    () => ({
      objectNameSingular: participantObjectNameSingular,
      variables: { filter: { personId: { in: relatedPersonIds } } },
    }),
    [participantObjectNameSingular, relatedPersonIds],
  );

  useListenToEventsForQuery({
    queryId,
    operationSignature,
    skip: !hasRelatedPersonIds,
  });

  // Ambiguous participants have no personId. Refresh through the authorized read
  // without broadening the participant event subscription to other mailboxes.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) refetch();
    }, SHARED_HISTORY_REFRESH_MS);

    return () => window.clearInterval(timer);
  }, [queryId, refetch]);

  const handleParticipantOperation = useCallback(() => {
    if (!hasRelatedPersonIds) {
      return;
    }

    refetch();
  }, [hasRelatedPersonIds, refetch]);

  useListenToEventsForQuery({
    queryId: `${queryId}-people`,
    operationSignature: {
      objectNameSingular: 'person',
      variables: { filter: { id: { in: relatedPersonIds } } },
    },
    skip: !hasRelatedPersonIds,
  });

  useListenToObjectRecordOperationBrowserEvent({
    onObjectRecordOperationBrowserEvent: handleParticipantOperation,
    objectMetadataItemId: personMetadata?.id,
  });

  useListenToObjectRecordOperationBrowserEvent({
    onObjectRecordOperationBrowserEvent: handleParticipantOperation,
    objectMetadataItemId: participantMetadata?.id,
  });
};
