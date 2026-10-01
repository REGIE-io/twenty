import { STANDARD_OBJECTS } from 'twenty-shared/metadata';
import { FieldMetadataType } from 'twenty-shared/types';

import { type FlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/types/flat-field-metadata.type';
import { type FlatObjectMetadata } from 'src/engine/metadata-modules/flat-object-metadata/types/flat-object-metadata.type';
import { type FlatSearchFieldMetadata } from 'src/engine/metadata-modules/flat-search-field-metadata/types/flat-search-field-metadata.type';
import { deriveCheckedSearchVectorExpression } from 'src/engine/metadata-modules/flat-search-field-metadata/utils/derive-checked-search-vector-expression.util';
import { TWENTY_STANDARD_APPLICATION } from 'src/engine/workspace-manager/twenty-standard-application/constants/twenty-standard-applications';
import { WorkspaceMigrationActionExecutionException } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/exceptions/workspace-migration-action-execution.exception';

const person = STANDARD_OBJECTS.person;
const personObject = {
  universalIdentifier: person.universalIdentifier,
  applicationUniversalIdentifier:
    TWENTY_STANDARD_APPLICATION.universalIdentifier,
  nameSingular: 'person',
} as unknown as FlatObjectMetadata;

const PERSON_SEARCH_FIELD_TYPES = {
  name: FieldMetadataType.FULL_NAME,
  emails: FieldMetadataType.EMAILS,
  phones: FieldMetadataType.PHONES,
  jobTitle: FieldMetadataType.TEXT,
} as const;

type PersonSearchFieldName = keyof typeof PERSON_SEARCH_FIELD_TYPES;

const field = (name: PersonSearchFieldName, isActive = true) =>
  ({
    id: `${name}-id`,
    name,
    type: PERSON_SEARCH_FIELD_TYPES[name],
    options: null,
    universalIdentifier: person.fields[name].universalIdentifier,
    isActive,
  }) as unknown as FlatFieldMetadata;

const searchRow = (name: PersonSearchFieldName, position = 0) =>
  ({
    fieldMetadataId: `${name}-id`,
    fieldMetadataUniversalIdentifier: person.fields[name].universalIdentifier,
    universalIdentifier: `${name}-search`,
    position,
  }) as unknown as FlatSearchFieldMetadata;

const personFields = [
  field('name'),
  field('emails'),
  field('phones'),
  field('jobTitle'),
];
const personSearchRows = [
  searchRow('name', 0),
  searchRow('emails', 1),
  searchRow('phones', 2),
  searchRow('jobTitle', 3),
];

describe('deriveCheckedSearchVectorExpression', () => {
  describe('standard search field guard', () => {
    it('throws naming every standard field when the list is empty (the 56 GO-660 workspaces)', () => {
      expect(() =>
        deriveCheckedSearchVectorExpression({
          flatObjectMetadata: personObject,
          objectFlatFieldMetadatas: personFields,
          targetSearchFieldMetadatas: [],
        }),
      ).toThrow(
        'Refusing to build searchVector for person: standard search fields missing from searchFieldMetadata: name, emails, phones, jobTitle',
      );
    });

    it('throws when only custom fields are searched (df76c87b)', () => {
      expect(() =>
        deriveCheckedSearchVectorExpression({
          flatObjectMetadata: personObject,
          objectFlatFieldMetadatas: personFields,
          targetSearchFieldMetadatas: [
            {
              fieldMetadataId: 'tier-id',
              fieldMetadataUniversalIdentifier: 'company-tier-custom-field',
            } as unknown as FlatSearchFieldMetadata,
          ],
        }),
      ).toThrow('name, emails, phones, jobTitle');
    });

    it('throws the migration execution exception with the dedicated code', () => {
      let thrown: unknown;

      try {
        deriveCheckedSearchVectorExpression({
          flatObjectMetadata: personObject,
          objectFlatFieldMetadatas: personFields,
          targetSearchFieldMetadatas: [searchRow('name')],
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(WorkspaceMigrationActionExecutionException);
      expect((thrown as WorkspaceMigrationActionExecutionException).code).toBe(
        'MISSING_STANDARD_SEARCH_FIELDS',
      );
    });

    it('passes when every standard field is searched', () => {
      expect(() =>
        deriveCheckedSearchVectorExpression({
          flatObjectMetadata: personObject,
          objectFlatFieldMetadatas: personFields,
          targetSearchFieldMetadatas: personSearchRows,
        }),
      ).not.toThrow();
    });

    it('does not require a standard field the workspace has deactivated', () => {
      expect(() =>
        deriveCheckedSearchVectorExpression({
          flatObjectMetadata: personObject,
          objectFlatFieldMetadatas: [
            field('name'),
            field('emails'),
            field('phones', false),
            field('jobTitle'),
          ],
          targetSearchFieldMetadatas: [
            searchRow('name'),
            searchRow('emails'),
            searchRow('jobTitle'),
          ],
        }),
      ).not.toThrow();
    });

    it('does not require a standard field the workspace does not have', () => {
      expect(() =>
        deriveCheckedSearchVectorExpression({
          flatObjectMetadata: personObject,
          objectFlatFieldMetadatas: [field('name')],
          targetSearchFieldMetadatas: [searchRow('name')],
        }),
      ).not.toThrow();
    });

    it('never checks a standard-application object that has no standard search list', () => {
      expect(() =>
        deriveCheckedSearchVectorExpression({
          flatObjectMetadata: {
            ...personObject,
            universalIdentifier: 'unlisted-standard-object',
          } as FlatObjectMetadata,
          objectFlatFieldMetadatas: personFields,
          targetSearchFieldMetadatas: [],
        }),
      ).not.toThrow();
    });

    it('never checks objects outside the standard application', () => {
      expect(() =>
        deriveCheckedSearchVectorExpression({
          flatObjectMetadata: {
            ...personObject,
            applicationUniversalIdentifier: 'some-custom-application',
          } as FlatObjectMetadata,
          objectFlatFieldMetadatas: personFields,
          targetSearchFieldMetadatas: [],
        }),
      ).not.toThrow();
    });
  });

  describe('shapes', () => {
    const jobTitleOnly = {
      flatObjectMetadata: {
        ...personObject,
        applicationUniversalIdentifier: 'some-custom-application',
      } as FlatObjectMetadata,
      objectFlatFieldMetadatas: [field('jobTitle')],
      targetSearchFieldMetadatas: [searchRow('jobTitle')],
    };

    it('defaults to the generated-column formula', () => {
      expect(deriveCheckedSearchVectorExpression(jobTitleOnly)).toBe(
        "to_tsvector('simple', COALESCE(public.unaccent_immutable(\"jobTitle\"), ''))",
      );
    });

    it('builds the lean plain-column formula', () => {
      expect(
        deriveCheckedSearchVectorExpression({
          ...jobTitleOnly,
          shape: 'leanColumn',
        }),
      ).toBe(
        "to_tsvector('simple', public.unaccent_immutable(left(concat_ws(' ', concat_ws(' ', COALESCE((\"jobTitle\"), ''))), 131072)))",
      );
    });

    it('builds the lean trigger-row formula', () => {
      expect(
        deriveCheckedSearchVectorExpression({
          ...jobTitleOnly,
          shape: 'triggerRow',
        }),
      ).toBe(
        "to_tsvector('simple', public.unaccent_immutable(left(concat_ws(' ', concat_ws(' ', COALESCE((NEW.\"jobTitle\"), ''))), 131072)))",
      );
    });
  });
});
