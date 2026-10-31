type EventBoundary = { dateTime?: string | null; date?: string | null } | null;

const parseBoundary = (boundary?: EventBoundary): number =>
  Date.parse(boundary?.dateTime ?? boundary?.date ?? '');

export const isEventInRequestedWindow = (
  event: { start?: EventBoundary; end?: EventBoundary },
  requestedWindow: { from: string | null; to: string | null },
): boolean =>
  (requestedWindow.to === null ||
    parseBoundary(event.start) < Date.parse(requestedWindow.to)) &&
  (requestedWindow.from === null ||
    parseBoundary(event.end) > Date.parse(requestedWindow.from));
