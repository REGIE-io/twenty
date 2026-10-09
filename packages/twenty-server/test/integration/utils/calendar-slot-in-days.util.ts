const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

export const calendarSlotInDays = (
  days: number,
): { startsAt: string; endsAt: string } => {
  const startsAt = Date.now() + days * ONE_DAY_MS;

  return {
    startsAt: new Date(startsAt).toISOString(),
    endsAt: new Date(startsAt + ONE_HOUR_MS).toISOString(),
  };
};
