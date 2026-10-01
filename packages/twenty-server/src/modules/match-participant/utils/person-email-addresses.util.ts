import { type PersonWorkspaceEntity } from 'src/modules/person/standard-objects/person.workspace-entity';

export const personEmailAddresses = (
  people: Pick<PersonWorkspaceEntity, 'emails'>[],
): string[] => [
  ...new Set(
    people.flatMap((person) =>
      [
        person.emails?.primaryEmail,
        ...(Array.isArray(person.emails?.additionalEmails)
          ? person.emails.additionalEmails
          : []),
      ]
        .filter(
          (email): email is string =>
            typeof email === 'string' && email.trim().length > 0,
        )
        .map((email) => email.trim().toLowerCase()),
    ),
  ),
];
