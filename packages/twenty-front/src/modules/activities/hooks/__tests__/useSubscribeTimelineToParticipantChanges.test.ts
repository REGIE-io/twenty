import { act, renderHook } from '@testing-library/react';
import { useSubscribeTimelineToParticipantChanges } from '@/activities/hooks/useSubscribeTimelineToParticipantChanges';
import { useListenToEventsForQuery } from '@/sse-db-event/hooks/useListenToEventsForQuery';

jest.mock('@/object-metadata/hooks/useObjectMetadataItem', () => ({
  useObjectMetadataItem: () => ({ objectMetadataItem: { id: 'metadata' } }),
}));
jest.mock('@/sse-db-event/hooks/useListenToEventsForQuery', () => ({
  useListenToEventsForQuery: jest.fn(),
}));
jest.mock(
  '@/browser-event/hooks/useListenToObjectRecordOperationBrowserEvent',
  () => ({ useListenToObjectRecordOperationBrowserEvent: jest.fn() }),
);

test('keeps mailbox event subscriptions scoped and refreshes ambiguous history with cleanup', () => {
  jest.useFakeTimers();
  const visibility = jest
    .spyOn(document, 'hidden', 'get')
    .mockReturnValue(false);
  const refetch = jest.fn();
  const { unmount } = renderHook(() =>
    useSubscribeTimelineToParticipantChanges({
      queryId: 'timeline',
      participantObjectNameSingular: 'messageParticipant',
      relatedPersonIds: ['person-a'],
      refetch,
    }),
  );
  expect(useListenToEventsForQuery).toHaveBeenCalledWith(
    expect.objectContaining({
      operationSignature: {
        objectNameSingular: 'messageParticipant',
        variables: { filter: { personId: { in: ['person-a'] } } },
      },
    }),
  );
  act(() => jest.advanceTimersByTime(30_000));
  expect(refetch).toHaveBeenCalledTimes(1);
  unmount();
  act(() => jest.advanceTimersByTime(60_000));
  expect(refetch).toHaveBeenCalledTimes(1);
  visibility.mockRestore();
  jest.useRealTimers();
});
