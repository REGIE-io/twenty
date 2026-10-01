import { type PersonWorkspaceEntity } from 'src/modules/person/standard-objects/person.workspace-entity';

export const findPersonByPrimaryOrAdditionalEmail = ({
  people,
  email,
}: {
  people: PersonWorkspaceEntity[];
  email: string;
}): PersonWorkspaceEntity | undefined => {
  const normalizedEmail = email.trim().toLowerCase();

  if (!normalizedEmail) return undefined;

  const matches = people.filter((person) =>
    [
      person.emails?.primaryEmail,
      ...(Array.isArray(person.emails?.additionalEmails)
        ? person.emails.additionalEmails
        : []),
    ].some((address) => address?.trim().toLowerCase() === normalizedEmail),
  );
  const uniqueMatches = [
    ...new Map(matches.map((person) => [person.id, person])).values(),
  ];

  return uniqueMatches.length === 1 ? uniqueMatches[0] : undefined;
};
