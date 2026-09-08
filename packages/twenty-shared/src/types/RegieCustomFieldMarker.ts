import { z } from 'zod';

// Strict, versioned wire contract between Go and Twenty. Go writes it into a custom
// field's settings; Twenty acts only on fields that carry it, and never infers search
// intent from a field's shape.
//
// Strict because a key one side does not understand must fail loudly rather than be
// dropped, and `version` is a literal because that is what forces Twenty to accept a new
// version before Go is allowed to emit it.
//
// `target` names the object in Regie's vocabulary so Twenty can cross-check it against the
// object the field was actually created on. Regie says `account` where Twenty says
// `company`, and that gap has already produced a wrong-object bug, so the redundancy is
// deliberate.
export const regieCustomFieldMarkerSchema = z.strictObject({
  version: z.literal(1),
  target: z.enum(['person', 'account', 'task', 'calendar_event']),
  searchable: z.boolean(),
});

export type RegieCustomFieldMarker = z.infer<
  typeof regieCustomFieldMarkerSchema
>;

export type RegieCustomFieldSettings = {
  regieCustomField?: RegieCustomFieldMarker;
};

export type RegieCustomFieldMarkerParseResult =
  | { status: 'absent' }
  | { status: 'valid'; marker: RegieCustomFieldMarker }
  | { status: 'invalid'; issues: string[] };

export const REGIE_CUSTOM_FIELD_MARKER_KEY = 'regieCustomField';

export const parseRegieCustomFieldMarker = (
  settings: unknown,
): RegieCustomFieldMarkerParseResult => {
  if (
    typeof settings !== 'object' ||
    settings === null ||
    !Object.prototype.hasOwnProperty.call(
      settings,
      REGIE_CUSTOM_FIELD_MARKER_KEY,
    )
  ) {
    return { status: 'absent' };
  }

  const parsed = regieCustomFieldMarkerSchema.safeParse(
    (settings as Record<string, unknown>)[REGIE_CUSTOM_FIELD_MARKER_KEY],
  );

  if (parsed.success) {
    return { status: 'valid', marker: parsed.data };
  }

  return {
    status: 'invalid',
    issues: parsed.error.issues.map(
      (issue) =>
        `${issue.path.length === 0 ? REGIE_CUSTOM_FIELD_MARKER_KEY : issue.path.join('.')}: ${issue.message}`,
    ),
  };
};
