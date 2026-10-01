# Search vector trigger mode — PR 1 (foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add everything needed to run a workspace's `searchVector` through a trigger instead of a generated column — the lean formula, the trigger SQL, the search-list guard, the converted-state flag, the per-table conversion and a `--dry-run` command — without converting any workspace yet.

**Architecture:** The existing formula builder gets a "style" parameter so one code path emits three shapes: today's generated-column formula (unchanged, byte for byte), the lean formula over plain columns (for the pre-conversion comparison) and the lean formula over `NEW."…"` (the trigger body). A new `search-vector-trigger` core module turns those into DDL and converts one table at a time. The command only dry-runs in this PR; PR 2 enables real conversion once the migration runner is trigger-aware.

**Tech Stack:** NestJS, nest-commander, TypeORM `DataSource`/`QueryRunner` raw SQL, Postgres 16 (`tsvector`, plpgsql), Jest (unit + integration against the `test` database).

Spec: `docs/superpowers/specs/2026-10-01-search-vector-trigger-mode-design.md`.

---

## Running tests

Nx targets can fail with `ERR_UNKNOWN_FILE_EXTENSION` on this machine's Node version; use Jest directly.

- Unit: `cd packages/twenty-server && npx jest <path-to-spec> --config ./jest.config.mjs`
- Integration (uses the `test` database, not `default`):
  `cd packages/twenty-server && NODE_ENV=test npx jest --config ./jest-integration.config.ts <path-to-integration-spec>`

All paths below are relative to `packages/twenty-server/` unless they start with `packages/`.

## File structure

| File | Responsibility |
|---|---|
| `src/engine/workspace-manager/utils/get-ts-vector-column-expression.util.ts` (modify) | One builder, three output styles; new `getLeanTsVectorExpressionFromFields` |
| `src/engine/metadata-modules/flat-search-field-metadata/utils/compute-search-vector-as-expression-from-search-field-metadatas.util.ts` (modify) | Pass the expression shape through |
| `src/engine/metadata-modules/flat-search-field-metadata/utils/derive-search-vector-as-expression-for-ts-vector-field.util.ts` (modify) | Accept `shape` |
| `src/engine/metadata-modules/flat-search-field-metadata/utils/find-missing-standard-search-field-names.util.ts` (create) | Pure: which standard search fields are missing for an object |
| `src/engine/metadata-modules/flat-search-field-metadata/utils/assert-standard-search-fields-present-or-throw.util.ts` (create) | Guard used by the migration runner and the conversion |
| `src/engine/workspace-manager/workspace-migration/workspace-migration-runner/exceptions/workspace-migration-action-execution.exception.ts` (modify) | New code `MISSING_STANDARD_SEARCH_FIELDS` |
| `src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/field/services/update-field-action-handler.service.ts` (modify) | Call the guard before rebuilding |
| `src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/object/services/create-object-action-handler.service.ts` (modify) | Call the guard before creating the column |
| `packages/twenty-shared/src/types/FeatureFlagKey.ts` (modify) | `IS_SEARCH_VECTOR_TRIGGER_ENABLED` |
| `src/engine/core-modules/search-vector-trigger/utils/build-search-vector-trigger-statements.util.ts` (create) | Pure: function/trigger DDL strings and names |
| `src/engine/core-modules/search-vector-trigger/services/search-vector-trigger-conversion.service.ts` (create) | Convert one table; convert a workspace (check-all-then-convert) |
| `src/engine/core-modules/search-vector-trigger/search-vector-trigger.module.ts` (create) | Nest module |
| `src/database/commands/convert-search-vector-to-trigger.command.ts` (create) | `workspace:convert-search-vector-to-trigger`, dry-run only in PR 1 |
| `src/database/commands/database-command.module.ts` (modify) | Register the command |

---

### Task 1: Freeze today's generated-column output with a snapshot

The builder refactor in Task 2 must not change a single character of today's formula — prod vectors depend on it. Lock it first.

**Files:**
- Create: `src/engine/workspace-manager/utils/__tests__/get-ts-vector-column-expression-output-freeze.util.spec.ts`

- [ ] **Step 1: Write the snapshot test**

```ts
import { FieldMetadataType } from 'twenty-shared/types';

import {
  type FieldTypeAndNameMetadata,
  getTsVectorColumnExpressionFromFields,
} from 'src/engine/workspace-manager/utils/get-ts-vector-column-expression.util';

const everyBranchFields: FieldTypeAndNameMetadata[] = [
  { name: 'name', type: FieldMetadataType.FULL_NAME },
  { name: 'emails', type: FieldMetadataType.EMAILS },
  { name: 'phones', type: FieldMetadataType.PHONES },
  { name: 'domainName', type: FieldMetadataType.LINKS },
  { name: 'jobTitle', type: FieldMetadataType.TEXT },
  {
    name: 'aeTier',
    type: FieldMetadataType.SELECT,
    options: [
      { value: 'OPT_1', label: '1', position: 0 },
      { value: 'PARTNER', label: 'Partner', position: 1 },
    ],
  },
  {
    name: 'seniority',
    type: FieldMetadataType.MULTI_SELECT,
    options: [
      { value: 'VP', label: 'VP/SVP', position: 0 },
      { value: 'DIRECTOR', label: 'Director', position: 1 },
    ],
  },
];

describe('getTsVectorColumnExpressionFromFields output freeze', () => {
  it('produces exactly the formula stored in prod generated columns', () => {
    expect(
      getTsVectorColumnExpressionFromFields(everyBranchFields),
    ).toMatchSnapshot();
  });

  it('produces exactly the empty formula', () => {
    expect(getTsVectorColumnExpressionFromFields([])).toBe(
      "to_tsvector('simple', NULL)",
    );
  });
});
```

- [ ] **Step 2: Run it to write the snapshot**

Run: `cd packages/twenty-server && npx jest src/engine/workspace-manager/utils/__tests__/get-ts-vector-column-expression-output-freeze.util.spec.ts --config ./jest.config.mjs`
Expected: PASS, `1 snapshot written`. A `__snapshots__/get-ts-vector-column-expression-output-freeze.util.spec.ts.snap` file appears.

- [ ] **Step 3: Commit**

```bash
git add packages/twenty-server/src/engine/workspace-manager/utils/__tests__/get-ts-vector-column-expression-output-freeze.util.spec.ts packages/twenty-server/src/engine/workspace-manager/utils/__tests__/__snapshots__/
git commit -m "test(search): freeze generated searchVector formula output"
```

---

### Task 2: Give the builder an output style, and add the lean formula

**Files:**
- Modify: `src/engine/workspace-manager/utils/get-ts-vector-column-expression.util.ts` (whole file)
- Create: `src/engine/workspace-manager/utils/__tests__/get-lean-ts-vector-expression-from-fields.util.spec.ts`

- [ ] **Step 1: Write the failing tests for the lean builder**

```ts
import { FieldMetadataType } from 'twenty-shared/types';

import {
  getLeanTsVectorExpressionFromFields,
  SEARCH_VECTOR_TEXT_LIMIT,
} from 'src/engine/workspace-manager/utils/get-ts-vector-column-expression.util';
import { isSafeTsVectorExpression } from 'src/engine/workspace-manager/workspace-migration/utils/remove-sql-injection.util';

describe('getLeanTsVectorExpressionFromFields', () => {
  it('joins every piece once and calls unaccent once', () => {
    const result = getLeanTsVectorExpressionFromFields(
      [
        { name: 'name', type: FieldMetadataType.FULL_NAME },
        { name: 'jobTitle', type: FieldMetadataType.TEXT },
      ],
      { columnReference: 'column' },
    );

    expect(result).toBe(
      `to_tsvector('simple', public.unaccent_immutable(left(concat_ws(' ', concat_ws(' ', COALESCE(("nameFirstName"), ''), COALESCE(("nameLastName"), ''), COALESCE(("jobTitle"), ''))), ${SEARCH_VECTOR_TEXT_LIMIT})))`,
    );
    expect(result.match(/unaccent_immutable/g)).toHaveLength(1);
  });

  it('reads columns from the trigger row when asked to', () => {
    const result = getLeanTsVectorExpressionFromFields(
      [{ name: 'jobTitle', type: FieldMetadataType.TEXT }],
      { columnReference: 'triggerRow' },
    );

    expect(result).toContain('COALESCE((NEW."jobTitle"), \'\')');
    expect(result).not.toContain(' "jobTitle"');
  });

  it('splits more than 99 pieces into nested concat_ws calls', () => {
    const fields = Array.from({ length: 150 }, (_, index) => ({
      name: `field${index}`,
      type: FieldMetadataType.TEXT,
    }));

    const result = getLeanTsVectorExpressionFromFields(fields, {
      columnReference: 'column',
    });

    expect(result.match(/concat_ws\(' ', /g)).toHaveLength(3);
  });

  it('caps the joined text at 128K characters', () => {
    expect(SEARCH_VECTOR_TEXT_LIMIT).toBe(131072);
    expect(
      getLeanTsVectorExpressionFromFields(
        [{ name: 'jobTitle', type: FieldMetadataType.TEXT }],
        { columnReference: 'column' },
      ),
    ).toContain(`, 131072)`);
  });

  it('returns the empty formula when nothing is searchable', () => {
    expect(
      getLeanTsVectorExpressionFromFields([], { columnReference: 'column' }),
    ).toBe("to_tsvector('simple', NULL)");
  });

  it('stays a safe expression with hostile option labels', () => {
    const result = getLeanTsVectorExpressionFromFields(
      [
        {
          name: 'tier',
          type: FieldMetadataType.SELECT,
          options: [{ value: 'A', label: "x'; DROP TABLE y; --$$", position: 0 }],
        },
      ],
      { columnReference: 'triggerRow' },
    );

    expect(isSafeTsVectorExpression(result)).toBe(true);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd packages/twenty-server && npx jest src/engine/workspace-manager/utils/__tests__/get-lean-ts-vector-expression-from-fields.util.spec.ts --config ./jest.config.mjs`
Expected: FAIL — `getLeanTsVectorExpressionFromFields` is not exported.

- [ ] **Step 3: Replace the builder file**

Replace the whole content of `src/engine/workspace-manager/utils/get-ts-vector-column-expression.util.ts` with:

```ts
import {
  FieldMetadataType,
  compositeTypeDefinitions,
} from 'twenty-shared/types';
import type { SearchableFieldType } from 'twenty-shared/utils';

import {
  computeColumnName,
  computeCompositeColumnName,
} from 'src/engine/metadata-modules/field-metadata/utils/compute-column-name.util';
import { isCompositeFieldMetadataType } from 'src/engine/metadata-modules/field-metadata/utils/is-composite-field-metadata-type.util';
import { isSearchableSubfield } from 'src/engine/workspace-manager/utils/is-searchable-subfield.util';
import { type AdditionalSearchableFieldType } from 'src/engine/workspace-manager/utils/is-additional-searchable-field-type.util';
import {
  escapeIdentifier,
  escapeLiteral,
} from 'src/engine/workspace-manager/workspace-migration/utils/remove-sql-injection.util';

// A dropdown option as the search expression needs it: the stored enum value plus the
// human label, which lives in field metadata and never in the row.
export type SearchableFieldOption = {
  value: string;
  label: string;
  position: number;
};

export type FieldTypeAndNameMetadata = {
  name: string;
  type: SearchableFieldType | AdditionalSearchableFieldType;
  options?: SearchableFieldOption[];
};

// Postgres rejects a tsvector over 1,048,575 bytes and fails the whole row write. left()
// counts characters; 131,072 keeps the worst case (distinct 4-byte-UTF-8 words) near 700KB.
export const SEARCH_VECTOR_TEXT_LIMIT = 131072;

// Postgres caps a function call at 100 arguments.
const CONCAT_WS_MAX_PIECES = 99;

type TsVectorExpressionStyle = {
  quoteColumn: (columnName: string) => string;
  unaccent: (expression: string) => string;
};

const GENERATED_COLUMN_STYLE: TsVectorExpressionStyle = {
  quoteColumn: escapeIdentifier,
  unaccent: (expression) => `public.unaccent_immutable(${expression})`,
};

export const getTsVectorColumnExpressionFromFields = (
  fieldsUsedForSearch: FieldTypeAndNameMetadata[],
): string => {
  const columnExpressions = fieldsUsedForSearch.flatMap((field) =>
    getColumnExpressionsFromField(field, GENERATED_COLUMN_STYLE),
  );
  const concatenatedExpression =
    columnExpressions.length > 0
      ? columnExpressions.join(" || ' ' || ")
      : 'NULL';

  return `to_tsvector('simple', ${concatenatedExpression})`;
};

// Same pieces in the same order as the generated-column formula, joined once and
// unaccented once. Verified to produce identical vectors on every Alchemer row.
// concat_ws is not immutable, so this shape is only usable outside a generated column.
export const getLeanTsVectorExpressionFromFields = (
  fieldsUsedForSearch: FieldTypeAndNameMetadata[],
  { columnReference }: { columnReference: 'column' | 'triggerRow' },
): string => {
  const style: TsVectorExpressionStyle = {
    quoteColumn:
      columnReference === 'triggerRow'
        ? (columnName) => `NEW.${escapeIdentifier(columnName)}`
        : escapeIdentifier,
    unaccent: (expression) => `(${expression})`,
  };

  const pieces = fieldsUsedForSearch.flatMap((field) =>
    getColumnExpressionsFromField(field, style),
  );

  if (pieces.length === 0) {
    return "to_tsvector('simple', NULL)";
  }

  const chunks: string[] = [];

  for (let start = 0; start < pieces.length; start += CONCAT_WS_MAX_PIECES) {
    chunks.push(
      `concat_ws(' ', ${pieces.slice(start, start + CONCAT_WS_MAX_PIECES).join(', ')})`,
    );
  }

  return `to_tsvector('simple', public.unaccent_immutable(left(concat_ws(' ', ${chunks.join(', ')}), ${SEARCH_VECTOR_TEXT_LIMIT})))`;
};

// isSafeTsVectorExpression scans the whole expression for these tokens without tracking
// string context, so they cannot appear even inside a quoted literal. to_tsvector('simple')
// discards punctuation anyway, so replacing them with a space loses nothing searchable.
const TS_VECTOR_UNSAFE_PATTERN = /\0|;|--|\/\*|\*\/|\$/g;

const sanitiseForTsVector = (value: string): string =>
  // replace with a /g regex rather than replaceAll: the server's lib target predates it.
  value.replace(TS_VECTOR_UNSAFE_PATTERN, ' ');

// Projected text is rewritten; a comparison literal never is. An option value is the enum
// comparison literal, so rewriting it would turn an out-of-range value into a *different*
// literal that is not a label of the generated enum, and the DDL would fail with "invalid
// input value for enum". Left alone, the same value is rejected cleanly upstream by
// assertSafeTsVectorExpression. Labels are only ever projected constants, so rewriting them
// is exactly right.
const quoteComparisonLiteral = (value: string): string => escapeLiteral(value);

const quoteProjectedText = (value: string): string =>
  escapeLiteral(sanitiseForTsVector(value));

// Emit in metadata position order so the generated expression is stable across rebuilds;
// value is only a tie-break for options sharing a position.
const orderOptions = (
  options: SearchableFieldOption[],
): SearchableFieldOption[] =>
  [...options].sort((a, b) => {
    if (a.position !== b.position) {
      return a.position - b.position;
    }

    return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
  });

const EMPTY_PROJECTION = "''";

// SELECT is a single Postgres enum column: map each option to its own value and its label.
const getSelectExpression = (
  quotedColumnName: string,
  options: SearchableFieldOption[],
  style: TsVectorExpressionStyle,
): string => {
  const orderedOptions = orderOptions(options);

  if (orderedOptions.length === 0) {
    return EMPTY_PROJECTION;
  }

  const buildCase = (
    pick: (option: SearchableFieldOption) => string,
  ): string => {
    const arms = orderedOptions
      .map(
        (option) =>
          `WHEN ${quoteComparisonLiteral(option.value)} THEN ${quoteProjectedText(pick(option))}`,
      )
      .join(' ');

    return `COALESCE(${style.unaccent(`CASE ${quotedColumnName} ${arms} ELSE '' END`)}, '')`;
  };

  return `${buildCase((option) => option.value)} || ' ' || ${buildCase((option) => option.label)}`;
};

// MULTI_SELECT is an enum ARRAY column, so membership has to be tested per option.
const getMultiSelectExpression = (
  quotedColumnName: string,
  options: SearchableFieldOption[],
  style: TsVectorExpressionStyle,
): string => {
  const orderedOptions = orderOptions(options);

  if (orderedOptions.length === 0) {
    return EMPTY_PROJECTION;
  }

  const buildTests = (
    pick: (option: SearchableFieldOption) => string,
  ): string => {
    const tests = orderedOptions
      .map(
        (option) =>
          `CASE WHEN ${quoteComparisonLiteral(option.value)} = ANY(${quotedColumnName}) THEN ${quoteProjectedText(pick(option))} ELSE '' END`,
      )
      .join(" || ' ' || ");

    return `COALESCE(${style.unaccent(tests)}, '')`;
  };

  return `${buildTests((option) => option.value)} || ' ' || ${buildTests((option) => option.label)}`;
};

const getColumnExpressionsFromField = (
  fieldMetadataTypeAndName: FieldTypeAndNameMetadata,
  style: TsVectorExpressionStyle,
): string[] => {
  // Handled before the composite branch: dropdowns need the metadata options, which the
  // shared getColumnExpression(columnName, fieldType) never receives.
  if (
    fieldMetadataTypeAndName.type === FieldMetadataType.SELECT ||
    fieldMetadataTypeAndName.type === FieldMetadataType.MULTI_SELECT
  ) {
    const quotedColumnName = style.quoteColumn(
      computeColumnName(fieldMetadataTypeAndName.name),
    );
    const options = fieldMetadataTypeAndName.options ?? [];

    return [
      fieldMetadataTypeAndName.type === FieldMetadataType.SELECT
        ? getSelectExpression(quotedColumnName, options, style)
        : getMultiSelectExpression(quotedColumnName, options, style),
    ];
  }

  if (isCompositeFieldMetadataType(fieldMetadataTypeAndName.type)) {
    const compositeType = compositeTypeDefinitions.get(
      fieldMetadataTypeAndName.type,
    );

    if (!compositeType) {
      throw new Error(
        `Composite type not found for field metadata type: ${fieldMetadataTypeAndName.type}`,
      );
    }

    const baseExpressions = compositeType.properties
      .filter((property) =>
        isSearchableSubfield(compositeType.type, property.type, property.name),
      )
      .map((property) => {
        const columnName = computeCompositeColumnName(
          fieldMetadataTypeAndName,
          property,
        );

        return getColumnExpression(
          columnName,
          fieldMetadataTypeAndName.type,
          style,
        );
      });

    if (fieldMetadataTypeAndName.type === FieldMetadataType.PHONES) {
      const phoneNumberColumn = style.quoteColumn(
        `${fieldMetadataTypeAndName.name}PrimaryPhoneNumber`,
      );
      const callingCodeColumn = style.quoteColumn(
        `${fieldMetadataTypeAndName.name}PrimaryPhoneCallingCode`,
      );
      const additionalPhonesColumn = style.quoteColumn(
        `${fieldMetadataTypeAndName.name}AdditionalPhones`,
      );

      const internationalFormats = [
        `COALESCE(${callingCodeColumn} || ${phoneNumberColumn}, '')`,
        `COALESCE(REPLACE(${callingCodeColumn}, '+', '') || ${phoneNumberColumn}, '')`,
        `COALESCE('0' || ${phoneNumberColumn}, '')`,
      ];

      const additionalPhonesExpression = `COALESCE(TRANSLATE(regexp_replace(${additionalPhonesColumn}::text, '"(number|countryCode|callingCode)"\\s*:\\s*', '', 'g'), '[]{}",:', '        '), '')`;

      return [
        ...baseExpressions,
        ...internationalFormats,
        additionalPhonesExpression,
      ];
    }

    if (fieldMetadataTypeAndName.type === FieldMetadataType.LINKS) {
      const secondaryLinksColumn = style.quoteColumn(
        `${fieldMetadataTypeAndName.name}SecondaryLinks`,
      );

      const secondaryLinksExpression = `COALESCE(${style.unaccent(`TRANSLATE(regexp_replace(${secondaryLinksColumn}::text, '"(label|url)"\\s*:\\s*', '', 'g'), '[]{}",:', '        ')`)}, '')`;

      return [...baseExpressions, secondaryLinksExpression];
    }

    if (fieldMetadataTypeAndName.type === FieldMetadataType.EMAILS) {
      const additionalEmailsColumn = style.quoteColumn(
        `${fieldMetadataTypeAndName.name}AdditionalEmails`,
      );

      const additionalEmailsExpression = `COALESCE(${style.unaccent(`TRANSLATE(${additionalEmailsColumn}::text, '[]",', '    ')`)}, '') || ' ' || COALESCE(${style.unaccent(`TRANSLATE(REPLACE(${additionalEmailsColumn}::text, '@', ' '), '[]",', '    ')`)}, '')`;

      return [...baseExpressions, additionalEmailsExpression];
    }

    return baseExpressions;
  }
  const columnName = computeColumnName(fieldMetadataTypeAndName.name);

  return [
    getColumnExpression(columnName, fieldMetadataTypeAndName.type, style),
  ];
};

const getColumnExpression = (
  columnName: string,
  fieldType: FieldMetadataType,
  style: TsVectorExpressionStyle,
): string => {
  const quotedColumnName = style.quoteColumn(columnName);

  switch (fieldType) {
    case FieldMetadataType.EMAILS:
      return `
      COALESCE(${style.unaccent(quotedColumnName)}, '') || ' ' ||
      COALESCE(${style.unaccent(`SPLIT_PART(${quotedColumnName}, '@', 2)`)}, '')`;

    case FieldMetadataType.PHONES:
      return `COALESCE(${quotedColumnName}, '')`;

    case FieldMetadataType.UUID:
      return `COALESCE(${quotedColumnName}::text, '')`;

    default:
      return `COALESCE(${style.unaccent(quotedColumnName)}, '')`;
  }
};
```

- [ ] **Step 4: Run the new tests, the freeze test and the existing builder tests**

Run:
```bash
cd packages/twenty-server && npx jest src/engine/workspace-manager/utils/__tests__/ --config ./jest.config.mjs
```
Expected: all PASS. The freeze snapshot must match unchanged — if it reports a snapshot difference, the refactor changed today's formula; fix the refactor, never update the snapshot.

- [ ] **Step 5: Commit**

```bash
git add packages/twenty-server/src/engine/workspace-manager/utils/
git commit -m "feat(search): add lean searchVector expression builder"
```

---

### Task 3: Prove the lean formula equals the generated one in Postgres

The unit tests check strings. This test checks the vectors Postgres actually produces, using the same awkward data that passed on Alchemer.

**Files:**
- Create: `test/integration/search-vector/lean-search-vector-expression.integration-spec.ts`

- [ ] **Step 1: Write the integration test**

```ts
import { FieldMetadataType } from 'twenty-shared/types';
import { DataSource } from 'typeorm';

import {
  type FieldTypeAndNameMetadata,
  getLeanTsVectorExpressionFromFields,
  getTsVectorColumnExpressionFromFields,
} from 'src/engine/workspace-manager/utils/get-ts-vector-column-expression.util';

const SCHEMA = 'search_vector_lean_test';

const fields: FieldTypeAndNameMetadata[] = [
  { name: 'name', type: FieldMetadataType.FULL_NAME },
  { name: 'emails', type: FieldMetadataType.EMAILS },
  { name: 'phones', type: FieldMetadataType.PHONES },
  { name: 'domainName', type: FieldMetadataType.LINKS },
  { name: 'jobTitle', type: FieldMetadataType.TEXT },
  {
    name: 'tier',
    type: FieldMetadataType.SELECT,
    options: [
      { value: 'NO', label: 'No', position: 0 },
      { value: 'YES', label: 'Yes', position: 1 },
    ],
  },
];

describe('lean searchVector expression in Postgres', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      url: process.env.PG_DATABASE_URL,
      synchronize: false,
    });
    await dataSource.initialize();
    await dataSource.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await dataSource.query(`CREATE SCHEMA "${SCHEMA}"`);
    await dataSource.query(`CREATE TABLE "${SCHEMA}"."person" (
      "id" serial PRIMARY KEY,
      "nameFirstName" text, "nameLastName" text,
      "emailsPrimaryEmail" text, "emailsAdditionalEmails" jsonb,
      "phonesPrimaryPhoneNumber" text, "phonesPrimaryPhoneCallingCode" text,
      "phonesAdditionalPhones" jsonb,
      "domainNamePrimaryLinkLabel" text, "domainNamePrimaryLinkUrl" text,
      "domainNameSecondaryLinks" jsonb,
      "jobTitle" text, "tier" text
    )`);
    await dataSource.query(`INSERT INTO "${SCHEMA}"."person"
      ("nameFirstName","nameLastName","emailsPrimaryEmail","emailsAdditionalEmails",
       "phonesPrimaryPhoneNumber","phonesPrimaryPhoneCallingCode","phonesAdditionalPhones",
       "domainNamePrimaryLinkLabel","domainNamePrimaryLinkUrl","domainNameSecondaryLinks",
       "jobTitle","tier") VALUES
      ('Samuel','Sunderaraj','samuel@petavue.com','[]','4155550100','+1','[]',NULL,'petavue.com','[]','VP Sales','YES'),
      ('José','Müller','jose.muller@café.de','["p.iyer@gmail.com"]',NULL,NULL,NULL,'Lïnk','https://ex.com/Pàge','[{"url":"https://two.io","label":"Sécond"}]','Directeur Général','NO'),
      ('','Ng','','[]','','','[]','','','[]','',NULL),
      (NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
      ('O''Brien','Iyer','priya@acme.io','["a@b.co","c@d.co"]','9876543210','+91','[{"number":"2025550199","countryCode":"US","callingCode":"+1"}]',NULL,NULL,NULL,'CTO','YES')`);
  });

  afterAll(async () => {
    await dataSource.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await dataSource.destroy();
  });

  it('gives identical vectors, positions included, on every row', async () => {
    const generated = getTsVectorColumnExpressionFromFields(fields);
    const lean = getLeanTsVectorExpressionFromFields(fields, {
      columnReference: 'column',
    });

    const [{ total, identical }] = await dataSource.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE (${generated}) = (${lean}))::int AS identical
         FROM "${SCHEMA}"."person"`,
    );

    expect(total).toBe(5);
    expect(identical).toBe(5);
  });
});
```

- [ ] **Step 2: Run it**

Run: `cd packages/twenty-server && NODE_ENV=test npx jest --config ./jest-integration.config.ts test/integration/search-vector/lean-search-vector-expression.integration-spec.ts`
Expected: PASS (5 of 5 identical). If the integration global setup tries to reset the database and fails, check `test/integration/utils/setup-test.ts` and run against a freshly reset `test` database (`npx nx database:reset twenty-server` with `NODE_ENV=test`).

- [ ] **Step 3: Commit**

```bash
git add packages/twenty-server/test/integration/search-vector/
git commit -m "test(search): prove lean searchVector expression matches in Postgres"
```

---

### Task 4: Pass the expression shape through compute and derive

**Files:**
- Modify: `src/engine/metadata-modules/flat-search-field-metadata/utils/compute-search-vector-as-expression-from-search-field-metadatas.util.ts`
- Modify: `src/engine/metadata-modules/flat-search-field-metadata/utils/derive-search-vector-as-expression-for-ts-vector-field.util.ts`
- Test: `src/engine/metadata-modules/flat-search-field-metadata/utils/__tests__/derive-search-vector-as-expression-for-ts-vector-field.util.spec.ts` (add cases)

- [ ] **Step 1: Add failing tests to the derive spec**

Append inside the existing top-level `describe` of `derive-search-vector-as-expression-for-ts-vector-field.util.spec.ts`. If that file mocks `computeSearchVectorAsExpressionFromSearchFieldMetadatas` globally, put these in a new file `derive-search-vector-as-expression-shapes.util.spec.ts` in the same folder instead:

```ts
import { FieldMetadataType } from 'twenty-shared/types';

import { type FlatSearchFieldMetadata } from 'src/engine/metadata-modules/flat-search-field-metadata/types/flat-search-field-metadata.type';
import { deriveSearchVectorAsExpressionForTsVectorField } from 'src/engine/metadata-modules/flat-search-field-metadata/utils/derive-search-vector-as-expression-for-ts-vector-field.util';

const jobTitleRow = {
  fieldMetadataId: 'job-title-id',
  position: 0,
  universalIdentifier: 'row-1',
} as unknown as FlatSearchFieldMetadata;

const indexedFieldById = new Map([
  ['job-title-id', { name: 'jobTitle', type: FieldMetadataType.TEXT }],
]);

describe('deriveSearchVectorAsExpressionForTsVectorField shapes', () => {
  it('defaults to the generated-column formula', () => {
    expect(
      deriveSearchVectorAsExpressionForTsVectorField({
        targetSearchFieldMetadatas: [jobTitleRow],
        indexedFieldById,
      }),
    ).toBe(
      "to_tsvector('simple', COALESCE(public.unaccent_immutable(\"jobTitle\"), ''))",
    );
  });

  it('builds the lean trigger-row formula', () => {
    expect(
      deriveSearchVectorAsExpressionForTsVectorField({
        targetSearchFieldMetadatas: [jobTitleRow],
        indexedFieldById,
        shape: 'triggerRow',
      }),
    ).toContain('COALESCE((NEW."jobTitle"), \'\')');
  });

  it('builds the lean plain-column formula', () => {
    expect(
      deriveSearchVectorAsExpressionForTsVectorField({
        targetSearchFieldMetadatas: [jobTitleRow],
        indexedFieldById,
        shape: 'leanColumn',
      }),
    ).toContain('COALESCE(("jobTitle"), \'\')');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/twenty-server && npx jest src/engine/metadata-modules/flat-search-field-metadata/utils/__tests__/ --config ./jest.config.mjs`
Expected: FAIL — `shape` is not a known property / lean output missing.

- [ ] **Step 3: Implement**

In `compute-search-vector-as-expression-from-search-field-metadatas.util.ts`, change the import and the function:

```ts
import {
  type FieldTypeAndNameMetadata,
  getLeanTsVectorExpressionFromFields,
  getTsVectorColumnExpressionFromFields,
  type SearchableFieldOption,
} from 'src/engine/workspace-manager/utils/get-ts-vector-column-expression.util';

export type SearchVectorExpressionShape =
  | 'generatedColumn'
  | 'leanColumn'
  | 'triggerRow';
```

and replace the last line of `computeSearchVectorAsExpressionFromSearchFieldMetadatas` (the `return getTsVectorColumnExpressionFromFields(orderedSearchableFields);`) plus its signature:

```ts
export const computeSearchVectorAsExpressionFromSearchFieldMetadatas = (
  targetSearchableFields: SearchVectorTargetField[],
  shape: SearchVectorExpressionShape = 'generatedColumn',
): string => {
```

```ts
  if (shape === 'generatedColumn') {
    return getTsVectorColumnExpressionFromFields(orderedSearchableFields);
  }

  return getLeanTsVectorExpressionFromFields(orderedSearchableFields, {
    columnReference: shape === 'triggerRow' ? 'triggerRow' : 'column',
  });
};
```

In `derive-search-vector-as-expression-for-ts-vector-field.util.ts`, add the import and parameter:

```ts
import {
  buildSearchVectorTargetField,
  computeSearchVectorAsExpressionFromSearchFieldMetadatas,
  type SearchVectorExpressionShape,
} from 'src/engine/metadata-modules/flat-search-field-metadata/utils/compute-search-vector-as-expression-from-search-field-metadatas.util';
```

```ts
export const deriveSearchVectorAsExpressionForTsVectorField = ({
  targetSearchFieldMetadatas,
  indexedFieldById,
  shape = 'generatedColumn',
}: {
  targetSearchFieldMetadatas: FlatSearchFieldMetadata[];
  indexedFieldById: ReadonlyMap<
    string,
    {
      name: string;
      type: FieldMetadataType;
      // Dropdown labels live in metadata, not the row, so the expression needs them here
      // or a registered SELECT row projects nothing.
      options?: SearchableFieldOption[];
    }
  >;
  shape?: SearchVectorExpressionShape;
}): string => {
```

and change the compute call to:

```ts
  const expression = computeSearchVectorAsExpressionFromSearchFieldMetadatas(
    targetSearchableFields,
    shape,
  );
```

- [ ] **Step 4: Run tests**

Run: `cd packages/twenty-server && npx jest src/engine/metadata-modules/flat-search-field-metadata/ src/engine/workspace-manager/utils/ --config ./jest.config.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/twenty-server/src/engine/metadata-modules/flat-search-field-metadata/
git commit -m "feat(search): let callers choose the searchVector expression shape"
```

---

### Task 5: The search-list guard (pure logic)

**Files:**
- Create: `src/engine/metadata-modules/flat-search-field-metadata/utils/find-missing-standard-search-field-names.util.ts`
- Test: `src/engine/metadata-modules/flat-search-field-metadata/utils/__tests__/find-missing-standard-search-field-names.util.spec.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { STANDARD_OBJECTS } from 'twenty-shared/metadata';

import { findMissingStandardSearchFieldNames } from 'src/engine/metadata-modules/flat-search-field-metadata/utils/find-missing-standard-search-field-names.util';

const person = STANDARD_OBJECTS.person;
const personField = (name: keyof typeof person.fields) =>
  person.fields[name].universalIdentifier;

const allPersonFields = new Set([
  personField('name'),
  personField('emails'),
  personField('phones'),
  personField('jobTitle'),
]);

describe('findMissingStandardSearchFieldNames', () => {
  it('reports every standard field when the list is empty (the 56 GO-660 workspaces)', () => {
    expect(
      findMissingStandardSearchFieldNames({
        objectUniversalIdentifier: person.universalIdentifier,
        isStandardObject: true,
        activeFieldUniversalIdentifiers: allPersonFields,
        searchedFieldUniversalIdentifiers: new Set(),
      }),
    ).toEqual(['name', 'emails', 'phones', 'jobTitle']);
  });

  it('reports the standard fields missing next to a custom-only list (df76c87b)', () => {
    expect(
      findMissingStandardSearchFieldNames({
        objectUniversalIdentifier: person.universalIdentifier,
        isStandardObject: true,
        activeFieldUniversalIdentifiers: allPersonFields,
        searchedFieldUniversalIdentifiers: new Set(['company-tier-custom-field']),
      }),
    ).toEqual(['name', 'emails', 'phones', 'jobTitle']);
  });

  it('reports nothing when every standard field is searched', () => {
    expect(
      findMissingStandardSearchFieldNames({
        objectUniversalIdentifier: person.universalIdentifier,
        isStandardObject: true,
        activeFieldUniversalIdentifiers: allPersonFields,
        searchedFieldUniversalIdentifiers: allPersonFields,
      }),
    ).toEqual([]);
  });

  it('ignores a standard field the workspace does not have or has deactivated', () => {
    expect(
      findMissingStandardSearchFieldNames({
        objectUniversalIdentifier: person.universalIdentifier,
        isStandardObject: true,
        activeFieldUniversalIdentifiers: new Set([personField('name')]),
        searchedFieldUniversalIdentifiers: new Set([personField('name')]),
      }),
    ).toEqual([]);
  });

  it('never checks custom objects', () => {
    expect(
      findMissingStandardSearchFieldNames({
        objectUniversalIdentifier: 'some-custom-object',
        isStandardObject: false,
        activeFieldUniversalIdentifiers: new Set(),
        searchedFieldUniversalIdentifiers: new Set(),
      }),
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/twenty-server && npx jest src/engine/metadata-modules/flat-search-field-metadata/utils/__tests__/find-missing-standard-search-field-names.util.spec.ts --config ./jest.config.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { STANDARD_OBJECTS } from 'twenty-shared/metadata';
import { isDefined } from 'twenty-shared/utils';

import { SEARCH_FIELDS_BY_STANDARD_OBJECT_NAME } from 'src/engine/workspace-manager/twenty-standard-application/constants/search-fields-by-standard-object-name.constant';

type StandardObjectName = keyof typeof SEARCH_FIELDS_BY_STANDARD_OBJECT_NAME;

const findStandardObjectName = (
  objectUniversalIdentifier: string,
): StandardObjectName | undefined =>
  (Object.keys(SEARCH_FIELDS_BY_STANDARD_OBJECT_NAME) as StandardObjectName[]).find(
    (objectName) =>
      STANDARD_OBJECTS[objectName].universalIdentifier ===
      objectUniversalIdentifier,
  );

// Only fields the workspace actually has, and has active, are expected: an upgrade can
// add a standard field to the list before the step that creates the field has run.
export const findMissingStandardSearchFieldNames = ({
  objectUniversalIdentifier,
  isStandardObject,
  activeFieldUniversalIdentifiers,
  searchedFieldUniversalIdentifiers,
}: {
  objectUniversalIdentifier: string;
  isStandardObject: boolean;
  activeFieldUniversalIdentifiers: ReadonlySet<string>;
  searchedFieldUniversalIdentifiers: ReadonlySet<string>;
}): string[] => {
  if (!isStandardObject) {
    return [];
  }

  const objectName = findStandardObjectName(objectUniversalIdentifier);

  if (!isDefined(objectName)) {
    return [];
  }

  const standardFields: Record<string, { universalIdentifier: string }> =
    STANDARD_OBJECTS[objectName].fields;

  return SEARCH_FIELDS_BY_STANDARD_OBJECT_NAME[objectName].flatMap(
    ({ name }) => {
      const fieldUniversalIdentifier = standardFields[name]?.universalIdentifier;

      if (
        !isDefined(fieldUniversalIdentifier) ||
        !activeFieldUniversalIdentifiers.has(fieldUniversalIdentifier) ||
        searchedFieldUniversalIdentifiers.has(fieldUniversalIdentifier)
      ) {
        return [];
      }

      return [name];
    },
  );
};
```

- [ ] **Step 4: Run tests**

Run the same command as Step 2. Expected: PASS. If TypeScript rejects the `Record<string, …>` widening of `STANDARD_OBJECTS[objectName].fields`, type it as `const standardFields = STANDARD_OBJECTS[objectName].fields as Record<string, { universalIdentifier: string }>;` — the shape is the same for every standard object.

- [ ] **Step 5: Commit**

```bash
git add packages/twenty-server/src/engine/metadata-modules/flat-search-field-metadata/utils/
git commit -m "feat(search): detect standard search fields missing from the list"
```

---

### Task 6: Guard wrapper and exception code

**Files:**
- Modify: `src/engine/workspace-manager/workspace-migration/workspace-migration-runner/exceptions/workspace-migration-action-execution.exception.ts`
- Create: `src/engine/metadata-modules/flat-search-field-metadata/utils/assert-standard-search-fields-present-or-throw.util.ts`
- Test: `src/engine/metadata-modules/flat-search-field-metadata/utils/__tests__/assert-standard-search-fields-present-or-throw.util.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { STANDARD_OBJECTS } from 'twenty-shared/metadata';

import { type FlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/types/flat-field-metadata.type';
import { type FlatObjectMetadata } from 'src/engine/metadata-modules/flat-object-metadata/types/flat-object-metadata.type';
import { type FlatSearchFieldMetadata } from 'src/engine/metadata-modules/flat-search-field-metadata/types/flat-search-field-metadata.type';
import { assertStandardSearchFieldsPresentOrThrow } from 'src/engine/metadata-modules/flat-search-field-metadata/utils/assert-standard-search-fields-present-or-throw.util';
import { TWENTY_STANDARD_APPLICATION } from 'src/engine/workspace-manager/twenty-standard-application/constants/twenty-standard-applications';
import { WorkspaceMigrationActionExecutionException } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/exceptions/workspace-migration-action-execution.exception';

const person = STANDARD_OBJECTS.person;
const personObject = {
  universalIdentifier: person.universalIdentifier,
  applicationUniversalIdentifier: TWENTY_STANDARD_APPLICATION.universalIdentifier,
  nameSingular: 'person',
} as unknown as FlatObjectMetadata;

const activeField = (name: keyof typeof person.fields) =>
  ({
    universalIdentifier: person.fields[name].universalIdentifier,
    isActive: true,
  }) as unknown as FlatFieldMetadata;

const personFields = [
  activeField('name'),
  activeField('emails'),
  activeField('phones'),
  activeField('jobTitle'),
];

const searchRow = (name: keyof typeof person.fields) =>
  ({
    fieldMetadataUniversalIdentifier: person.fields[name].universalIdentifier,
  }) as unknown as FlatSearchFieldMetadata;

describe('assertStandardSearchFieldsPresentOrThrow', () => {
  it('throws, naming the object and the missing fields', () => {
    expect(() =>
      assertStandardSearchFieldsPresentOrThrow({
        flatObjectMetadata: personObject,
        objectFlatFieldMetadatas: personFields,
        targetSearchFieldMetadatas: [searchRow('name')],
      }),
    ).toThrow(
      new WorkspaceMigrationActionExecutionException({
        message:
          'Refusing to build searchVector for person: standard search fields missing from searchFieldMetadata: emails, phones, jobTitle',
        code: 'MISSING_STANDARD_SEARCH_FIELDS',
      }),
    );
  });

  it('passes when the standard fields are present', () => {
    expect(() =>
      assertStandardSearchFieldsPresentOrThrow({
        flatObjectMetadata: personObject,
        objectFlatFieldMetadatas: personFields,
        targetSearchFieldMetadatas: [
          searchRow('name'),
          searchRow('emails'),
          searchRow('phones'),
          searchRow('jobTitle'),
        ],
      }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/twenty-server && npx jest src/engine/metadata-modules/flat-search-field-metadata/utils/__tests__/assert-standard-search-fields-present-or-throw.util.spec.ts --config ./jest.config.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the exception code**

In `workspace-migration-action-execution.exception.ts`, add to `WorkspaceMigrationActionExecutionExceptionCode`:

```ts
  MISSING_STANDARD_SEARCH_FIELDS: 'MISSING_STANDARD_SEARCH_FIELDS',
```

and to the `switch` in `getWorkspaceMigrationActionExecutionExceptionUserFriendlyMessage`, before `default:`:

```ts
    case WorkspaceMigrationActionExecutionExceptionCode.MISSING_STANDARD_SEARCH_FIELDS:
      return msg`Search is not set up correctly for this object.`;
```

- [ ] **Step 4: Implement the wrapper**

```ts
import { type FlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/types/flat-field-metadata.type';
import { type FlatObjectMetadata } from 'src/engine/metadata-modules/flat-object-metadata/types/flat-object-metadata.type';
import { type FlatSearchFieldMetadata } from 'src/engine/metadata-modules/flat-search-field-metadata/types/flat-search-field-metadata.type';
import { findMissingStandardSearchFieldNames } from 'src/engine/metadata-modules/flat-search-field-metadata/utils/find-missing-standard-search-field-names.util';
import { belongsToTwentyStandardApp } from 'src/engine/metadata-modules/utils/belongs-to-twenty-standard-app.util';
import {
  WorkspaceMigrationActionExecutionException,
  WorkspaceMigrationActionExecutionExceptionCode,
} from 'src/engine/workspace-manager/workspace-migration/workspace-migration-runner/exceptions/workspace-migration-action-execution.exception';

// GO-660: an empty or custom-only list silently built a formula that indexed nothing.
// Failing the migration keeps the previous formula in place.
export const assertStandardSearchFieldsPresentOrThrow = ({
  flatObjectMetadata,
  objectFlatFieldMetadatas,
  targetSearchFieldMetadatas,
}: {
  flatObjectMetadata: FlatObjectMetadata;
  objectFlatFieldMetadatas: FlatFieldMetadata[];
  targetSearchFieldMetadatas: FlatSearchFieldMetadata[];
}): void => {
  const missingFieldNames = findMissingStandardSearchFieldNames({
    objectUniversalIdentifier: flatObjectMetadata.universalIdentifier,
    isStandardObject: belongsToTwentyStandardApp(flatObjectMetadata),
    activeFieldUniversalIdentifiers: new Set(
      objectFlatFieldMetadatas
        .filter((flatFieldMetadata) => flatFieldMetadata.isActive)
        .map((flatFieldMetadata) => flatFieldMetadata.universalIdentifier),
    ),
    searchedFieldUniversalIdentifiers: new Set(
      targetSearchFieldMetadatas.map(
        (searchFieldMetadata) =>
          searchFieldMetadata.fieldMetadataUniversalIdentifier,
      ),
    ),
  });

  if (missingFieldNames.length > 0) {
    throw new WorkspaceMigrationActionExecutionException({
      message: `Refusing to build searchVector for ${flatObjectMetadata.nameSingular}: standard search fields missing from searchFieldMetadata: ${missingFieldNames.join(', ')}`,
      code: WorkspaceMigrationActionExecutionExceptionCode.MISSING_STANDARD_SEARCH_FIELDS,
    });
  }
};
```

- [ ] **Step 5: Run tests and commit**

Run the Step 2 command. Expected: PASS.

```bash
git add packages/twenty-server/src/engine/metadata-modules/flat-search-field-metadata/utils/ packages/twenty-server/src/engine/workspace-manager/workspace-migration/workspace-migration-runner/exceptions/
git commit -m "feat(search): refuse to build a searchVector missing standard fields"
```

---

### Task 7: Call the guard where today's formula is built

**Files:**
- Modify: `src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/field/services/update-field-action-handler.service.ts` (rebuild block, ~line 351)
- Modify: `src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/object/services/create-object-action-handler.service.ts` (~line 150)

- [ ] **Step 1: Update-field handler**

In the `if (flatAction.rebuildSearchVector === true && …TS_VECTOR)` block, replace

```ts
      const indexedFieldById = new Map(
        findManyFlatEntityByIdInFlatEntityMaps({
          flatEntityMaps: flatFieldMetadataMaps,
          flatEntityIds: flatObjectMetadata.fieldIds,
        }).map((indexedFlatFieldMetadata) => [
```

through the end of the `deriveSearchVectorAsExpressionForTsVectorField({ … })` call with:

```ts
      const objectFlatFieldMetadatas = findManyFlatEntityByIdInFlatEntityMaps({
        flatEntityMaps: flatFieldMetadataMaps,
        flatEntityIds: flatObjectMetadata.fieldIds,
      });

      const indexedFieldById = new Map(
        objectFlatFieldMetadatas.map((indexedFlatFieldMetadata) => [
          indexedFlatFieldMetadata.id,
          {
            name: indexedFlatFieldMetadata.name,
            type: indexedFlatFieldMetadata.type,
            options: indexedFlatFieldMetadata.options ?? undefined,
          },
        ]),
      );

      const targetSearchFieldMetadatas =
        getSearchFieldMetadatasByTsVectorFieldId?.(
          optimisticFlatFieldMetadata.id,
        ) ??
        getTargetSearchFieldMetadatasForTsVectorField({
          tsVectorFieldMetadataId: optimisticFlatFieldMetadata.id,
          flatSearchFieldMetadataMaps,
        });

      assertStandardSearchFieldsPresentOrThrow({
        flatObjectMetadata,
        objectFlatFieldMetadatas,
        targetSearchFieldMetadatas,
      });

      const searchVectorAsExpression =
        deriveSearchVectorAsExpressionForTsVectorField({
          targetSearchFieldMetadatas,
          indexedFieldById,
        });
```

and add the import:

```ts
import { assertStandardSearchFieldsPresentOrThrow } from 'src/engine/metadata-modules/flat-search-field-metadata/utils/assert-standard-search-fields-present-or-throw.util';
```

- [ ] **Step 2: Create-object handler**

Inside the `flatFieldMetadatas.flatMap(...)` that builds `columnDefinitions`, for the `TS_VECTOR` branch compute the target list once, assert, then derive. Replace the inline ternary value of `searchVectorAsExpression` with a call to a local helper declared just above `const columnDefinitions`:

```ts
    const deriveCheckedSearchVectorExpression = (
      tsVectorFieldMetadataId: string,
    ): string => {
      const targetSearchFieldMetadatas =
        getSearchFieldMetadatasByTsVectorFieldId?.(tsVectorFieldMetadataId) ??
        getTargetSearchFieldMetadatasForTsVectorField({
          tsVectorFieldMetadataId,
          flatSearchFieldMetadataMaps:
            allFlatEntityMaps.flatSearchFieldMetadataMaps,
        });

      assertStandardSearchFieldsPresentOrThrow({
        flatObjectMetadata,
        objectFlatFieldMetadatas: flatFieldMetadatas,
        targetSearchFieldMetadatas,
      });

      return deriveSearchVectorAsExpressionForTsVectorField({
        targetSearchFieldMetadatas,
        indexedFieldById,
      });
    };
```

then:

```ts
        searchVectorAsExpression: isFlatFieldMetadataOfType(
          flatFieldMetadata,
          FieldMetadataType.TS_VECTOR,
        )
          ? deriveCheckedSearchVectorExpression(flatFieldMetadata.id)
          : undefined,
```

Use the handler's existing local names for the object (`flatObjectMetadata`, from `flatAction.flatEntity`) and its fields (`flatFieldMetadatas`, from `flatAction.flatFieldMetadatas`); rename in the helper if the handler uses different names. Add the same import as Step 1.

- [ ] **Step 3: Run the handler unit tests**

Run: `cd packages/twenty-server && npx jest src/engine/workspace-manager/workspace-migration/workspace-migration-runner/ --config ./jest.config.mjs`
Expected: PASS.

- [ ] **Step 4: Run integration suites that create workspaces and objects**

Provisioning creates every standard object, and its search rows are ordered before object creation, so the guard must stay silent. Prove it:

Run: `cd packages/twenty-server && NODE_ENV=test npx jest --config ./jest-integration.config.ts test/integration/metadata/suites/object-metadata`
Expected: PASS, with no `MISSING_STANDARD_SEARCH_FIELDS` errors. If a suite fails with that code, the guard has a false positive — capture the object and fields from the message and stop for review; do not loosen the guard silently.

- [ ] **Step 5: Commit**

```bash
git add packages/twenty-server/src/engine/workspace-manager/workspace-migration/workspace-migration-runner/action-handlers/
git commit -m "fix(search): guard searchVector builds against missing standard fields"
```

---

### Task 8: The converted-state feature flag

**Files:**
- Modify: `packages/twenty-shared/src/types/FeatureFlagKey.ts`
- Regenerated: `packages/twenty-front/src/generated-metadata/graphql.ts`, `packages/twenty-front/src/generated-admin/graphql.ts`, `packages/twenty-client-sdk/src/metadata/generated/schema.ts` (by the generators)

- [ ] **Step 1: Add the key**

Append to the enum:

```ts
  IS_SEARCH_VECTOR_TRIGGER_ENABLED = 'IS_SEARCH_VECTOR_TRIGGER_ENABLED',
```

Do **not** add it to `DEFAULT_FEATURE_FLAGS`: only the conversion command may set it.

- [ ] **Step 2: Build shared and regenerate GraphQL types**

Run:
```bash
npx nx build twenty-shared
npx nx run twenty-front:graphql:generate --configuration=metadata
npx nx run twenty-front:graphql:generate
```
Expected: the generated files gain `IS_SEARCH_VECTOR_TRIGGER_ENABLED` in the `FeatureFlagKey` enum and nothing else changes. If `graphql:generate` needs a running server, start `npx nx start twenty-server` first. Regenerate `twenty-client-sdk` the same way its README describes, or leave it to CI if it is generated there; check `git diff --stat` and keep only enum additions.

- [ ] **Step 3: Commit**

```bash
git add packages/twenty-shared/src/types/FeatureFlagKey.ts packages/twenty-front/src/generated-metadata/ packages/twenty-front/src/generated-admin/ packages/twenty-client-sdk/src/metadata/generated/
git commit -m "feat(search): add IS_SEARCH_VECTOR_TRIGGER_ENABLED feature flag"
```

---

### Task 9: Trigger DDL builder (pure)

**Files:**
- Create: `src/engine/core-modules/search-vector-trigger/utils/build-search-vector-trigger-statements.util.ts`
- Test: `src/engine/core-modules/search-vector-trigger/utils/__tests__/build-search-vector-trigger-statements.util.spec.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { buildSearchVectorTriggerStatements } from 'src/engine/core-modules/search-vector-trigger/utils/build-search-vector-trigger-statements.util';

const expression = `to_tsvector('simple', public.unaccent_immutable(left(concat_ws(' ', concat_ws(' ', COALESCE((NEW."jobTitle"), ''))), 131072)))`;

describe('buildSearchVectorTriggerStatements', () => {
  it('builds a function and a BEFORE INSERT OR UPDATE trigger in the workspace schema', () => {
    const statements = buildSearchVectorTriggerStatements({
      schemaName: 'workspace_abc',
      tableName: 'person',
      triggerRowExpression: expression,
    });

    expect(statements.functionName).toBe('person_search_vector');
    expect(statements.createFunction).toBe(
      `CREATE OR REPLACE FUNCTION "workspace_abc"."person_search_vector"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $search_vector$
BEGIN
  NEW."searchVector" := ${expression};
  RETURN NEW;
END
$search_vector$`,
    );
    expect(statements.createTrigger).toBe(
      `CREATE TRIGGER "person_search_vector" BEFORE INSERT OR UPDATE ON "workspace_abc"."person" FOR EACH ROW EXECUTE FUNCTION "workspace_abc"."person_search_vector"()`,
    );
    expect(statements.dropTrigger).toBe(
      `DROP TRIGGER IF EXISTS "person_search_vector" ON "workspace_abc"."person"`,
    );
  });

  it('keeps names within Postgres 63-byte identifiers for long custom tables', () => {
    const { functionName } = buildSearchVectorTriggerStatements({
      schemaName: 'workspace_abc',
      tableName: `_${'a'.repeat(62)}`,
      triggerRowExpression: expression,
    });

    expect(functionName.length).toBeLessThanOrEqual(63);
    expect(functionName).toMatch(/_search_vector_[0-9a-f]{8}$/);
  });

  it('refuses an unsafe expression', () => {
    expect(() =>
      buildSearchVectorTriggerStatements({
        schemaName: 'workspace_abc',
        tableName: 'person',
        triggerRowExpression: "x; DROP TABLE y; $$",
      }),
    ).toThrow('Unsafe tsvector expression detected');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/twenty-server && npx jest src/engine/core-modules/search-vector-trigger/ --config ./jest.config.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { createHash } from 'crypto';

import {
  assertSafeTsVectorExpression,
  escapeIdentifier,
} from 'src/engine/workspace-manager/workspace-migration/utils/remove-sql-injection.util';

const POSTGRES_IDENTIFIER_MAX_LENGTH = 63;
const FUNCTION_SUFFIX = '_search_vector';

export type SearchVectorTriggerStatements = {
  functionName: string;
  createFunction: string;
  createTrigger: string;
  dropTrigger: string;
};

const computeFunctionName = (tableName: string): string => {
  const plainName = `${tableName}${FUNCTION_SUFFIX}`;

  if (plainName.length <= POSTGRES_IDENTIFIER_MAX_LENGTH) {
    return plainName;
  }

  const hash = createHash('sha1').update(tableName).digest('hex').slice(0, 8);

  return `${tableName.slice(0, POSTGRES_IDENTIFIER_MAX_LENGTH - FUNCTION_SUFFIX.length - 9)}${FUNCTION_SUFFIX}_${hash}`;
};

// The expression is checked before it is wrapped: the plpgsql body itself contains ';' and
// '$', which the expression check forbids. Checking the expression guarantees it cannot
// close the $search_vector$ quote.
export const buildSearchVectorTriggerStatements = ({
  schemaName,
  tableName,
  triggerRowExpression,
}: {
  schemaName: string;
  tableName: string;
  triggerRowExpression: string;
}): SearchVectorTriggerStatements => {
  assertSafeTsVectorExpression(triggerRowExpression);

  const functionName = computeFunctionName(tableName);
  const qualifiedFunction = `${escapeIdentifier(schemaName)}.${escapeIdentifier(functionName)}`;
  const qualifiedTable = `${escapeIdentifier(schemaName)}.${escapeIdentifier(tableName)}`;

  return {
    functionName,
    createFunction: `CREATE OR REPLACE FUNCTION ${qualifiedFunction}() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $search_vector$
BEGIN
  NEW."searchVector" := ${triggerRowExpression};
  RETURN NEW;
END
$search_vector$`,
    createTrigger: `CREATE TRIGGER ${escapeIdentifier(functionName)} BEFORE INSERT OR UPDATE ON ${qualifiedTable} FOR EACH ROW EXECUTE FUNCTION ${qualifiedFunction}()`,
    dropTrigger: `DROP TRIGGER IF EXISTS ${escapeIdentifier(functionName)} ON ${qualifiedTable}`,
  };
};
```

- [ ] **Step 4: Run tests and commit**

Run the Step 2 command. Expected: PASS.

```bash
git add packages/twenty-server/src/engine/core-modules/search-vector-trigger/
git commit -m "feat(search): build searchVector trigger DDL"
```

---

### Task 10: Convert one table (service, integration-tested)

**Files:**
- Create: `src/engine/core-modules/search-vector-trigger/services/search-vector-trigger-conversion.service.ts`
- Test: `test/integration/search-vector/search-vector-table-conversion.integration-spec.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
import { FieldMetadataType } from 'twenty-shared/types';
import { DataSource } from 'typeorm';

import { SearchVectorTriggerConversionService } from 'src/engine/core-modules/search-vector-trigger/services/search-vector-trigger-conversion.service';
import {
  getLeanTsVectorExpressionFromFields,
  getTsVectorColumnExpressionFromFields,
} from 'src/engine/workspace-manager/utils/get-ts-vector-column-expression.util';

const SCHEMA = 'search_vector_conversion_test';
const fields = [
  { name: 'name', type: FieldMetadataType.FULL_NAME },
  { name: 'jobTitle', type: FieldMetadataType.TEXT },
];

describe('SearchVectorTriggerConversionService.convertTable', () => {
  let dataSource: DataSource;
  let service: SearchVectorTriggerConversionService;

  const leanColumnExpression = getLeanTsVectorExpressionFromFields(fields, {
    columnReference: 'column',
  });
  const triggerRowExpression = getLeanTsVectorExpressionFromFields(fields, {
    columnReference: 'triggerRow',
  });

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      url: process.env.PG_DATABASE_URL,
      synchronize: false,
    });
    await dataSource.initialize();
    service = new SearchVectorTriggerConversionService(
      dataSource,
      { getOrRecompute: jest.fn() } as never,
      { upsertWorkspaceFeatureFlag: jest.fn() } as never,
    );
  });

  beforeEach(async () => {
    await dataSource.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await dataSource.query(`CREATE SCHEMA "${SCHEMA}"`);
    await dataSource.query(`CREATE TABLE "${SCHEMA}"."person" (
      "id" serial PRIMARY KEY, "nameFirstName" text, "nameLastName" text, "jobTitle" text,
      "searchVector" tsvector GENERATED ALWAYS AS (${getTsVectorColumnExpressionFromFields(fields)}) STORED
    )`);
    await dataSource.query(`INSERT INTO "${SCHEMA}"."person" ("nameFirstName","nameLastName","jobTitle")
      VALUES ('Samuel','Sunderaraj','VP Sales'), ('José','Müller',NULL)`);
  });

  afterAll(async () => {
    await dataSource.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await dataSource.destroy();
  });

  const convert = (dryRun: boolean) =>
    service.convertTable({
      schemaName: SCHEMA,
      tableName: 'person',
      leanColumnExpression,
      triggerRowExpression,
      dryRun,
    });

  it('dry run checks and changes nothing', async () => {
    await expect(convert(true)).resolves.toEqual({
      status: 'dryRun',
      mismatchCount: 0,
    });
    const [{ attgenerated }] = await dataSource.query(
      `SELECT attgenerated FROM pg_attribute WHERE attrelid = '"${SCHEMA}"."person"'::regclass AND attname = 'searchVector'`,
    );
    expect(attgenerated).toBe('s');
  });

  it('converts without changing any stored vector, then keeps vectors current', async () => {
    const before = await dataSource.query(
      `SELECT id, "searchVector"::text AS v FROM "${SCHEMA}"."person" ORDER BY id`,
    );

    await expect(convert(false)).resolves.toEqual({
      status: 'converted',
      mismatchCount: 0,
    });

    const after = await dataSource.query(
      `SELECT id, "searchVector"::text AS v FROM "${SCHEMA}"."person" ORDER BY id`,
    );
    expect(after).toEqual(before);

    const [{ attgenerated }] = await dataSource.query(
      `SELECT attgenerated FROM pg_attribute WHERE attrelid = '"${SCHEMA}"."person"'::regclass AND attname = 'searchVector'`,
    );
    expect(attgenerated).toBe('');

    await dataSource.query(
      `UPDATE "${SCHEMA}"."person" SET "jobTitle" = 'Chief Hacker' WHERE "nameFirstName" = 'Samuel'`,
    );
    const [{ matches }] = await dataSource.query(
      `SELECT count(*)::int AS matches FROM "${SCHEMA}"."person" WHERE "searchVector" @@ to_tsquery('simple', 'hacker')`,
    );
    expect(matches).toBe(1);
  });

  it('is idempotent', async () => {
    await convert(false);
    await expect(convert(false)).resolves.toEqual({
      status: 'alreadyConverted',
      mismatchCount: 0,
    });
  });

  it('refuses when a stored vector differs from the lean formula', async () => {
    const otherFields = [{ name: 'jobTitle', type: FieldMetadataType.TEXT }];

    await expect(
      service.convertTable({
        schemaName: SCHEMA,
        tableName: 'person',
        leanColumnExpression: getLeanTsVectorExpressionFromFields(otherFields, {
          columnReference: 'column',
        }),
        triggerRowExpression,
        dryRun: false,
      }),
    ).resolves.toEqual({ status: 'mismatch', mismatchCount: 2 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/twenty-server && NODE_ENV=test npx jest --config ./jest-integration.config.ts test/integration/search-vector/search-vector-table-conversion.integration-spec.ts`
Expected: FAIL — service module not found.

- [ ] **Step 3: Implement the table conversion part of the service**

```ts
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { type DataSource, type QueryRunner } from 'typeorm';

import { buildSearchVectorTriggerStatements } from 'src/engine/core-modules/search-vector-trigger/utils/build-search-vector-trigger-statements.util';
import { FeatureFlagService } from 'src/engine/core-modules/feature-flag/services/feature-flag.service';
import { WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';
import { escapeIdentifier } from 'src/engine/workspace-manager/workspace-migration/utils/remove-sql-injection.util';

export type SearchVectorTableConversionResult = {
  status: 'converted' | 'alreadyConverted' | 'mismatch' | 'dryRun';
  mismatchCount: number;
};

const CONVERSION_LOCK_TIMEOUT = '8s';

@Injectable()
export class SearchVectorTriggerConversionService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly workspaceCacheService: WorkspaceCacheService,
    private readonly featureFlagService: FeatureFlagService,
  ) {}

  async convertTable({
    schemaName,
    tableName,
    leanColumnExpression,
    triggerRowExpression,
    dryRun,
  }: {
    schemaName: string;
    tableName: string;
    leanColumnExpression: string;
    triggerRowExpression: string;
    dryRun: boolean;
  }): Promise<SearchVectorTableConversionResult> {
    const qualifiedTable = `${escapeIdentifier(schemaName)}.${escapeIdentifier(tableName)}`;
    const statements = buildSearchVectorTriggerStatements({
      schemaName,
      tableName,
      triggerRowExpression,
    });

    const queryRunner = this.dataSource.createQueryRunner();

    try {
      await queryRunner.connect();

      if (!(await this.isGeneratedColumn(queryRunner, schemaName, tableName))) {
        return { status: 'alreadyConverted', mismatchCount: 0 };
      }

      const [{ mismatchCount }] = (await queryRunner.query(
        `SELECT count(*) FILTER (WHERE "searchVector" IS DISTINCT FROM (${leanColumnExpression}))::int AS "mismatchCount" FROM ${qualifiedTable}`,
      )) as Array<{ mismatchCount: number }>;

      if (mismatchCount > 0) {
        return { status: 'mismatch', mismatchCount };
      }

      if (dryRun) {
        return { status: 'dryRun', mismatchCount: 0 };
      }

      await queryRunner.query(statements.createFunction);

      await queryRunner.startTransaction();
      await queryRunner.query(
        `SET LOCAL lock_timeout = '${CONVERSION_LOCK_TIMEOUT}'`,
      );
      // Same transaction: after DROP EXPRESSION the column accepts direct writes, so the
      // trigger must exist before anyone else can write the table.
      await queryRunner.query(
        `ALTER TABLE ${qualifiedTable} ALTER COLUMN "searchVector" DROP EXPRESSION`,
      );
      await queryRunner.query(statements.dropTrigger);
      await queryRunner.query(statements.createTrigger);
      await queryRunner.commitTransaction();

      return { status: 'converted', mismatchCount: 0 };
    } catch (error) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction();
      }
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private async isGeneratedColumn(
    queryRunner: QueryRunner,
    schemaName: string,
    tableName: string,
  ): Promise<boolean> {
    const rows = (await queryRunner.query(
      `SELECT a.attgenerated
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2 AND a.attname = 'searchVector' AND NOT a.attisdropped`,
      [schemaName, tableName],
    )) as Array<{ attgenerated: string }>;

    return rows[0]?.attgenerated === 's';
  }
}
```

- [ ] **Step 4: Run the integration test**

Run the Step 2 command. Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/twenty-server/src/engine/core-modules/search-vector-trigger/services/ packages/twenty-server/test/integration/search-vector/search-vector-table-conversion.integration-spec.ts
git commit -m "feat(search): convert one searchVector table to trigger mode"
```

---

### Task 11: Convert a workspace (check every table first, then convert)

Converting some tables but not others would leave the workspace half in each mode. So every table is checked before any is converted, and the flag is only set when all are converted.

**Files:**
- Modify: `src/engine/core-modules/search-vector-trigger/services/search-vector-trigger-conversion.service.ts`
- Test: `src/engine/core-modules/search-vector-trigger/services/__tests__/search-vector-trigger-conversion.service.spec.ts`

- [ ] **Step 1: Write the failing unit test**

```ts
import { FeatureFlagKey } from 'twenty-shared/types';

import { SearchVectorTriggerConversionService } from 'src/engine/core-modules/search-vector-trigger/services/search-vector-trigger-conversion.service';

const buildService = () => {
  const featureFlagService = { upsertWorkspaceFeatureFlag: jest.fn() };
  const service = new SearchVectorTriggerConversionService(
    {} as never,
    { getOrRecompute: jest.fn() } as never,
    featureFlagService as never,
  );

  return { service, featureFlagService };
};

const plan = (tableName: string) => ({
  objectNameSingular: tableName,
  schemaName: 'workspace_abc',
  tableName,
  leanColumnExpression: 'lean',
  triggerRowExpression: 'trigger',
});

describe('SearchVectorTriggerConversionService.convertWorkspace', () => {
  afterEach(() => jest.clearAllMocks());

  it('converts nothing when any table mismatches', async () => {
    const { service, featureFlagService } = buildService();
    jest
      .spyOn(service, 'buildWorkspaceTablePlans')
      .mockResolvedValue([plan('person'), plan('company')]);
    const convertTable = jest
      .spyOn(service, 'convertTable')
      .mockImplementation(async ({ tableName, dryRun }) =>
        tableName === 'company' && dryRun
          ? { status: 'mismatch' as const, mismatchCount: 3 }
          : {
              status: dryRun ? ('dryRun' as const) : ('converted' as const),
              mismatchCount: 0,
            },
      );

    const report = await service.convertWorkspace({
      workspaceId: 'w1',
      dryRun: false,
    });

    expect(report.status).toBe('mismatch');
    expect(convertTable.mock.calls.every(([args]) => args.dryRun)).toBe(true);
    expect(featureFlagService.upsertWorkspaceFeatureFlag).not.toHaveBeenCalled();
  });

  it('converts every table and sets the flag when all checks pass', async () => {
    const { service, featureFlagService } = buildService();
    jest
      .spyOn(service, 'buildWorkspaceTablePlans')
      .mockResolvedValue([plan('person'), plan('company')]);
    jest
      .spyOn(service, 'convertTable')
      .mockImplementation(async ({ dryRun }) => ({
        status: dryRun ? ('dryRun' as const) : ('converted' as const),
        mismatchCount: 0,
      }));

    const report = await service.convertWorkspace({
      workspaceId: 'w1',
      dryRun: false,
    });

    expect(report.status).toBe('converted');
    expect(featureFlagService.upsertWorkspaceFeatureFlag).toHaveBeenCalledWith({
      workspaceId: 'w1',
      featureFlag: FeatureFlagKey.IS_SEARCH_VECTOR_TRIGGER_ENABLED,
      value: true,
    });
  });

  it('dry run never sets the flag', async () => {
    const { service, featureFlagService } = buildService();
    jest
      .spyOn(service, 'buildWorkspaceTablePlans')
      .mockResolvedValue([plan('person')]);
    jest
      .spyOn(service, 'convertTable')
      .mockResolvedValue({ status: 'dryRun' as const, mismatchCount: 0 });

    const report = await service.convertWorkspace({
      workspaceId: 'w1',
      dryRun: true,
    });

    expect(report.status).toBe('dryRun');
    expect(featureFlagService.upsertWorkspaceFeatureFlag).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/twenty-server && npx jest src/engine/core-modules/search-vector-trigger/services/ --config ./jest.config.mjs`
Expected: FAIL — `convertWorkspace` / `buildWorkspaceTablePlans` not defined.

- [ ] **Step 3: Implement the workspace orchestration**

Add these imports to the service:

```ts
import { FeatureFlagKey } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';

import { findManyFlatEntityByIdInFlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/utils/find-many-flat-entity-by-id-in-flat-entity-maps.util';
import { assertStandardSearchFieldsPresentOrThrow } from 'src/engine/metadata-modules/flat-search-field-metadata/utils/assert-standard-search-fields-present-or-throw.util';
import { deriveSearchVectorAsExpressionForTsVectorField } from 'src/engine/metadata-modules/flat-search-field-metadata/utils/derive-search-vector-as-expression-for-ts-vector-field.util';
import { findTsVectorFlatFieldMetadataForObject } from 'src/engine/metadata-modules/flat-search-field-metadata/utils/find-ts-vector-flat-field-metadata-for-object.util';
import { getTargetSearchFieldMetadatasForTsVectorField } from 'src/engine/metadata-modules/flat-search-field-metadata/utils/get-target-search-field-metadatas-for-ts-vector-field.util';
import { computeObjectTargetTable } from 'src/engine/utils/compute-object-target-table.util';
import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';
```

Add these types next to `SearchVectorTableConversionResult`:

```ts
export type SearchVectorTablePlan = {
  objectNameSingular: string;
  schemaName: string;
  tableName: string;
  leanColumnExpression: string;
  triggerRowExpression: string;
};

export type SearchVectorWorkspaceConversionReport = {
  status: 'converted' | 'mismatch' | 'dryRun';
  tables: Array<{ tableName: string } & SearchVectorTableConversionResult>;
};
```

Add these methods to the class:

```ts
  async buildWorkspaceTablePlans(
    workspaceId: string,
  ): Promise<SearchVectorTablePlan[]> {
    const {
      flatObjectMetadataMaps,
      flatFieldMetadataMaps,
      flatSearchFieldMetadataMaps,
    } = await this.workspaceCacheService.getOrRecompute(workspaceId, [
      'flatObjectMetadataMaps',
      'flatFieldMetadataMaps',
      'flatSearchFieldMetadataMaps',
    ]);

    const schemaName = getWorkspaceSchemaName(workspaceId);

    return Object.values(flatObjectMetadataMaps.byUniversalIdentifier)
      .filter(isDefined)
      .flatMap((flatObjectMetadata) => {
        const tsVectorFlatFieldMetadata = findTsVectorFlatFieldMetadataForObject({
          fieldUniversalIdentifiers: flatObjectMetadata.fieldUniversalIdentifiers,
          flatFieldMetadataMaps,
        });

        if (!isDefined(tsVectorFlatFieldMetadata)) {
          return [];
        }

        const objectFlatFieldMetadatas = findManyFlatEntityByIdInFlatEntityMaps({
          flatEntityMaps: flatFieldMetadataMaps,
          flatEntityIds: flatObjectMetadata.fieldIds,
        });
        const targetSearchFieldMetadatas =
          getTargetSearchFieldMetadatasForTsVectorField({
            tsVectorFieldMetadataId: tsVectorFlatFieldMetadata.id,
            flatSearchFieldMetadataMaps,
          });

        assertStandardSearchFieldsPresentOrThrow({
          flatObjectMetadata,
          objectFlatFieldMetadatas,
          targetSearchFieldMetadatas,
        });

        const indexedFieldById = new Map(
          objectFlatFieldMetadatas.map((flatFieldMetadata) => [
            flatFieldMetadata.id,
            {
              name: flatFieldMetadata.name,
              type: flatFieldMetadata.type,
              options: flatFieldMetadata.options ?? undefined,
            },
          ]),
        );

        return [
          {
            objectNameSingular: flatObjectMetadata.nameSingular,
            schemaName,
            tableName: computeObjectTargetTable(flatObjectMetadata),
            leanColumnExpression: deriveSearchVectorAsExpressionForTsVectorField({
              targetSearchFieldMetadatas,
              indexedFieldById,
              shape: 'leanColumn',
            }),
            triggerRowExpression: deriveSearchVectorAsExpressionForTsVectorField({
              targetSearchFieldMetadatas,
              indexedFieldById,
              shape: 'triggerRow',
            }),
          },
        ];
      });
  }

  async convertWorkspace({
    workspaceId,
    dryRun,
  }: {
    workspaceId: string;
    dryRun: boolean;
  }): Promise<SearchVectorWorkspaceConversionReport> {
    const plans = await this.buildWorkspaceTablePlans(workspaceId);

    const checks: SearchVectorWorkspaceConversionReport['tables'] = [];

    for (const plan of plans) {
      const result = await this.convertTable({ ...plan, dryRun: true });

      checks.push({ tableName: plan.tableName, ...result });
    }

    if (checks.some((check) => check.status === 'mismatch')) {
      return { status: 'mismatch', tables: checks };
    }

    if (dryRun) {
      return { status: 'dryRun', tables: checks };
    }

    const conversions: SearchVectorWorkspaceConversionReport['tables'] = [];

    for (const plan of plans) {
      const result = await this.convertTable({ ...plan, dryRun: false });

      conversions.push({ tableName: plan.tableName, ...result });
    }

    await this.featureFlagService.upsertWorkspaceFeatureFlag({
      workspaceId,
      featureFlag: FeatureFlagKey.IS_SEARCH_VECTOR_TRIGGER_ENABLED,
      value: true,
    });

    return { status: 'converted', tables: conversions };
  }
```

If `findManyFlatEntityByIdInFlatEntityMaps` returns `(FlatFieldMetadata | undefined)[]` in this codebase, add `.filter(isDefined)` after it. If `getOrRecompute` types its keys differently, mirror exactly how `2-16-workspace-command-1799100000000-backfill-search-field-metadata.command.ts` calls it.

- [ ] **Step 4: Run tests**

Run: `cd packages/twenty-server && npx jest src/engine/core-modules/search-vector-trigger/ --config ./jest.config.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/twenty-server/src/engine/core-modules/search-vector-trigger/
git commit -m "feat(search): convert a whole workspace to trigger mode, all or nothing"
```

---

### Task 12: Module and dry-run command

**Files:**
- Create: `src/engine/core-modules/search-vector-trigger/search-vector-trigger.module.ts`
- Create: `src/database/commands/convert-search-vector-to-trigger.command.ts`
- Modify: `src/database/commands/database-command.module.ts`
- Test: `src/database/commands/__tests__/convert-search-vector-to-trigger.command.spec.ts`

- [ ] **Step 1: Write the failing command test**

```ts
import { ConvertSearchVectorToTriggerCommand } from 'src/database/commands/convert-search-vector-to-trigger.command';

describe('ConvertSearchVectorToTriggerCommand', () => {
  const buildCommand = () => {
    const conversionService = {
      convertWorkspace: jest
        .fn()
        .mockResolvedValue({ status: 'dryRun', tables: [] }),
    };
    const command = new ConvertSearchVectorToTriggerCommand(
      {} as never,
      conversionService as never,
    );

    return { command, conversionService };
  };

  it('dry-runs a workspace', async () => {
    const { command, conversionService } = buildCommand();

    await command.runOnWorkspace({
      workspaceId: 'w1',
      options: { dryRun: true },
      index: 0,
      total: 1,
    });

    expect(conversionService.convertWorkspace).toHaveBeenCalledWith({
      workspaceId: 'w1',
      dryRun: true,
    });
  });

  it('refuses a real conversion until the migration runner supports trigger mode', async () => {
    const { command, conversionService } = buildCommand();

    await expect(
      command.runOnWorkspace({
        workspaceId: 'w1',
        options: {},
        index: 0,
        total: 1,
      }),
    ).rejects.toThrow('only --dry-run is allowed');
    expect(conversionService.convertWorkspace).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/twenty-server && npx jest src/database/commands/__tests__/convert-search-vector-to-trigger.command.spec.ts --config ./jest.config.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the module**

```ts
import { Module } from '@nestjs/common';

import { FeatureFlagModule } from 'src/engine/core-modules/feature-flag/feature-flag.module';
import { SearchVectorTriggerConversionService } from 'src/engine/core-modules/search-vector-trigger/services/search-vector-trigger-conversion.service';
import { WorkspaceCacheModule } from 'src/engine/workspace-cache/workspace-cache.module';

@Module({
  imports: [WorkspaceCacheModule, FeatureFlagModule],
  providers: [SearchVectorTriggerConversionService],
  exports: [SearchVectorTriggerConversionService],
})
export class SearchVectorTriggerModule {}
```

- [ ] **Step 4: Create the command**

```ts
import { Command } from 'nest-commander';

import { ProvisionedWorkspaceCommandRunner } from 'src/database/commands/command-runners/provisioned-workspace.command-runner';
import { WorkspaceIteratorService } from 'src/database/commands/command-runners/workspace-iterator.service';
import { type RunOnWorkspaceArgs } from 'src/database/commands/command-runners/workspace.command-runner';
import { SearchVectorTriggerConversionService } from 'src/engine/core-modules/search-vector-trigger/services/search-vector-trigger-conversion.service';

// Real conversion is enabled in PR 2, once the migration runner stops dropping and
// re-adding searchVector in converted workspaces. Until then a converted workspace would
// break on the next field delete or option change.
const IS_REAL_CONVERSION_ENABLED = false;

// Deliberately not a @RegisteredWorkspaceCommand: it must never run as part of `upgrade`.
@Command({
  name: 'workspace:convert-search-vector-to-trigger',
  description:
    'Check, and later convert, a workspace searchVector from a generated column to a trigger. Use -w for each workspace.',
})
export class ConvertSearchVectorToTriggerCommand extends ProvisionedWorkspaceCommandRunner {
  constructor(
    protected readonly workspaceIteratorService: WorkspaceIteratorService,
    private readonly searchVectorTriggerConversionService: SearchVectorTriggerConversionService,
  ) {
    super(workspaceIteratorService);
  }

  override async runOnWorkspace({
    workspaceId,
    options,
    index,
    total,
  }: RunOnWorkspaceArgs): Promise<void> {
    const dryRun = options.dryRun ?? false;

    if (!dryRun && !IS_REAL_CONVERSION_ENABLED) {
      throw new Error(
        'Search vector trigger conversion is not enabled yet: only --dry-run is allowed',
      );
    }

    const report =
      await this.searchVectorTriggerConversionService.convertWorkspace({
        workspaceId,
        dryRun,
      });

    for (const table of report.tables) {
      this.logger.log(
        `${dryRun ? '[DRY RUN] ' : ''}${workspaceId} ${table.tableName}: ${table.status}${table.mismatchCount > 0 ? ` (${table.mismatchCount} rows differ)` : ''}`,
      );
    }

    this.logger.log(
      `${dryRun ? '[DRY RUN] ' : ''}Workspace ${workspaceId} (${index + 1}/${total}): ${report.status}`,
    );

    if (report.status === 'mismatch') {
      throw new Error(
        `Workspace ${workspaceId} not converted: stored vectors differ from the trigger formula`,
      );
    }
  }
}
```

- [ ] **Step 5: Register it**

In `src/database/commands/database-command.module.ts`, add to the imports at the top:

```ts
import { ConvertSearchVectorToTriggerCommand } from 'src/database/commands/convert-search-vector-to-trigger.command';
import { SearchVectorTriggerModule } from 'src/engine/core-modules/search-vector-trigger/search-vector-trigger.module';
```

add `SearchVectorTriggerModule,` to the module's `imports: [ … ]` array and `ConvertSearchVectorToTriggerCommand,` to its `providers: [ … ]` array.

- [ ] **Step 6: Run the test and a typecheck**

Run:
```bash
cd packages/twenty-server && npx jest src/database/commands/__tests__/convert-search-vector-to-trigger.command.spec.ts --config ./jest.config.mjs
cd /Users/faizurrahman/git_repos_2/twenty && npx nx typecheck twenty-server
```
Expected: test PASS; typecheck clean. If `nx typecheck` fails with `ERR_UNKNOWN_FILE_EXTENSION`, run `cd packages/twenty-server && npx tsc --noEmit -p tsconfig.json`.

- [ ] **Step 7: Dry-run against the local database**

Run: `cd packages/twenty-server && npx nx run twenty-server:command workspace:convert-search-vector-to-trigger -- --dry-run -w <a local workspace id>` (or `yarn command:prod workspace:convert-search-vector-to-trigger --dry-run -w <id>` after a build).
Expected: one `[DRY RUN] … : dryRun` line per searchable table and a final `dryRun` status. A `mismatch` on a local workspace is a real finding — record which table and how many rows.

- [ ] **Step 8: Commit**

```bash
git add packages/twenty-server/src/engine/core-modules/search-vector-trigger/search-vector-trigger.module.ts packages/twenty-server/src/database/commands/
git commit -m "feat(search): add dry-run searchVector trigger conversion command"
```

---

### Task 13: Lint, typecheck and the full relevant suites

- [ ] **Step 1: Lint the diff**

Run: `npx nx lint:diff-with-main twenty-server --configuration=fix` (fallback: `cd packages/twenty-server && npx oxlint <changed files>`).
Expected: clean.

- [ ] **Step 2: Unit suites for touched areas**

Run:
```bash
cd packages/twenty-server && npx jest src/engine/workspace-manager/utils src/engine/metadata-modules/flat-search-field-metadata src/engine/core-modules/search-vector-trigger src/database/commands/__tests__ src/engine/workspace-manager/workspace-migration --config ./jest.config.mjs
```
Expected: PASS.

- [ ] **Step 3: Integration suites**

Run: `cd packages/twenty-server && NODE_ENV=test npx jest --config ./jest-integration.config.ts test/integration/search-vector test/integration/metadata/suites/object-metadata`
Expected: PASS.

- [ ] **Step 4: Commit any lint fixes**

```bash
git add -A packages/twenty-server
git commit -m "chore(search): lint fixes"
```

---

## Handed to PR 2 (not in this plan)

- The migration runner in converted workspaces: regenerate the function instead of drop/add; skip the `searchVector` drop on enum option changes (`update-field-action-handler.service.ts:690-716`); regenerate in the same migration on field delete and rename; new objects get a plain column + trigger.
- Treat the table's real state (`attgenerated`) as truth, not just the flag: a workspace interrupted mid-conversion has some tables converted and the flag unset.
- Backfill table, queue job, reconciler cron, 30-day cleanup, `createdAt <= cutoff` bound.
- A regression test that `searchVector` never becomes generated again in a converted workspace.
- Workspace export DDL (`generate-workspace-schema-ddl.util.ts`) emitting plain column + trigger for converted workspaces.
- Flip `IS_REAL_CONVERSION_ENABLED`.
