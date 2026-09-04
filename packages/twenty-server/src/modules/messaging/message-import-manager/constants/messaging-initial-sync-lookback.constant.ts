// How far back the very first message list fetch reaches. Only the initial crawl is
// bounded: once a channel holds a sync cursor, every later fetch is incremental and
// carries no date filter, so nothing beyond this window is ever missed after the first
// run.
export const MESSAGING_INITIAL_SYNC_LOOKBACK_DAYS = 30;
