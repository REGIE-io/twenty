// The eight ways a value can be written from the Regie product. This is the taxonomy
// that Twenty cannot infer on its own: every Regie write authenticates with the same
// workspace API key, so the source is only known at the top of each write path in Regie
// and is threaded to Twenty on the write (X-Regie-Source header). It is stamped onto the
// TimelineActivity row beside the diff Twenty already records.
//
// Keep this list in lockstep with the mirror in the Regie monorepo (@regie/types). The
// two are joined only by the header string, so a value added here must be added there.
export const REGIE_SOURCES = [
  'typed_by_hand',
  'csv',
  'enrichment',
  'research',
  'hubspot',
  'salesforce',
  'api',
  'automation',
] as const;

export type RegieSource = (typeof REGIE_SOURCES)[number];

const REGIE_SOURCE_SET: ReadonlySet<string> = new Set(REGIE_SOURCES);

// Narrows an untrusted header value to a RegieSource, or undefined when it is absent or
// unrecognised. Undefined is deliberate: an unknown source must leave the row unlabelled
// rather than mislabelled, and a mislabelled row is worse than an unlabelled one.
export const parseRegieSource = (
  value: string | string[] | undefined | null,
): RegieSource | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  return REGIE_SOURCE_SET.has(value) ? (value as RegieSource) : undefined;
};
