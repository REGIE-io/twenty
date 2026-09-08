import { z } from 'zod';

// Strict, versioned wire contract between the owning service and Twenty. That service writes it into a custom
// field's settings; Twenty acts only on fields that carry it, and never infers search
// intent from a field's shape.
//
// Strict because a key one side does not understand must fail loudly rather than be
// dropped, and `version` is a literal because that is what forces Twenty to accept a new
// version before the owning service is allowed to emit it.
//
// `target` names the object in the owning service's vocabulary so Twenty can cross-check it against the
// object the field was actually created on. That service says `account` where Twenty says
// `company`, and that gap has already produced a wrong-object bug, so the redundancy is
// deliberate.
export const additionalSearchMarkerSchema = z.strictObject({
  version: z.literal(1),
  target: z.enum(['person', 'account', 'task', 'calendar_event']),
  searchable: z.boolean(),
});

export type AdditionalSearchMarker = z.infer<
  typeof additionalSearchMarkerSchema
>;

export type AdditionalSearchSettings = {
  additionalSearch?: AdditionalSearchMarker;
};

export type AdditionalSearchMarkerParseResult =
  | { status: 'absent' }
  | { status: 'valid'; marker: AdditionalSearchMarker }
  | { status: 'invalid'; issues: string[] };

export const ADDITIONAL_SEARCH_MARKER_KEY = 'additionalSearch';

export const parseAdditionalSearchMarker = (
  settings: unknown,
): AdditionalSearchMarkerParseResult => {
  if (
    typeof settings !== 'object' ||
    settings === null ||
    !Object.prototype.hasOwnProperty.call(
      settings,
      ADDITIONAL_SEARCH_MARKER_KEY,
    )
  ) {
    return { status: 'absent' };
  }

  const parsed = additionalSearchMarkerSchema.safeParse(
    (settings as Record<string, unknown>)[ADDITIONAL_SEARCH_MARKER_KEY],
  );

  if (parsed.success) {
    return { status: 'valid', marker: parsed.data };
  }

  return {
    status: 'invalid',
    issues: parsed.error.issues.map(
      (issue) =>
        `${issue.path.length === 0 ? ADDITIONAL_SEARCH_MARKER_KEY : issue.path.join('.')}: ${issue.message}`,
    ),
  };
};
