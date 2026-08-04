import { FieldMetadataType, ViewFilterOperand } from 'twenty-shared/types';

import { createEmptyFlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/constant/create-empty-flat-entity-maps.constant';
import { FlatViewFilterValidatorService } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-builder/validators/services/flat-view-filter-validator.service';

const VIEW_UNIVERSAL_IDENTIFIER = '00000000-0000-4000-8000-000000000001';
const FILTER_UNIVERSAL_IDENTIFIER = '00000000-0000-4000-8000-000000000002';
const SOURCE_FIELD_UNIVERSAL_IDENTIFIER =
  '00000000-0000-4000-8000-000000000003';
const TARGET_FIELD_UNIVERSAL_IDENTIFIER =
  '00000000-0000-4000-8000-000000000004';

const mapsFrom = <TEntity extends { universalIdentifier: string }>(
  entities: TEntity[],
) => {
  const maps = createEmptyFlatEntityMaps() as unknown as {
    byUniversalIdentifier: Record<string, TEntity>;
  };

  for (const entity of entities) {
    maps.byUniversalIdentifier[entity.universalIdentifier] = entity;
  }

  return maps;
};

const buildCreationArgs = ({
  operand,
  sourceFieldType = FieldMetadataType.RELATION,
  targetFieldType = FieldMetadataType.RELATION,
  includeTargetField = true,
}: {
  operand: ViewFilterOperand;
  sourceFieldType?: FieldMetadataType;
  targetFieldType?: FieldMetadataType;
  includeTargetField?: boolean;
}) =>
  ({
    flatEntityToValidate: {
      universalIdentifier: FILTER_UNIVERSAL_IDENTIFIER,
      viewUniversalIdentifier: VIEW_UNIVERSAL_IDENTIFIER,
      fieldMetadataUniversalIdentifier: SOURCE_FIELD_UNIVERSAL_IDENTIFIER,
      relationTargetFieldMetadataUniversalIdentifier: includeTargetField
        ? TARGET_FIELD_UNIVERSAL_IDENTIFIER
        : null,
      viewFilterGroupUniversalIdentifier: null,
      operand,
      value: '["00000000-0000-4000-8000-000000000005"]',
    },
    optimisticFlatEntityMapsAndRelatedFlatEntityMaps: {
      flatViewFilterMaps: mapsFrom([]),
      flatViewMaps: mapsFrom([
        { universalIdentifier: VIEW_UNIVERSAL_IDENTIFIER },
      ]),
      flatFieldMetadataMaps: mapsFrom([
        {
          universalIdentifier: SOURCE_FIELD_UNIVERSAL_IDENTIFIER,
          type: sourceFieldType,
          label: 'Memberships',
        },
        {
          universalIdentifier: TARGET_FIELD_UNIVERSAL_IDENTIFIER,
          type: targetFieldType,
          label: 'List',
        },
      ]),
      flatViewFilterGroupMaps: mapsFrom([]),
    },
  }) as unknown as Parameters<
    FlatViewFilterValidatorService['validateFlatViewFilterCreation']
  >[0];

describe('FlatViewFilterValidatorService', () => {
  const service = new FlatViewFilterValidatorService();

  it.each([ViewFilterOperand.IS_IN_LIST, ViewFilterOperand.IS_NOT_IN_LIST])(
    'accepts %s on a relation traversal',
    (operand) => {
      const result = service.validateFlatViewFilterCreation(
        buildCreationArgs({ operand }),
      );

      expect(result.errors).toEqual([]);
    },
  );

  it('accepts list operands targeting a UUID field', () => {
    const result = service.validateFlatViewFilterCreation(
      buildCreationArgs({
        operand: ViewFilterOperand.IS_IN_LIST,
        targetFieldType: FieldMetadataType.UUID,
      }),
    );

    expect(result.errors).toEqual([]);
  });

  it('rejects list operands without a relation traversal target', () => {
    const result = service.validateFlatViewFilterCreation(
      buildCreationArgs({
        operand: ViewFilterOperand.IS_IN_LIST,
        includeTargetField: false,
      }),
    );

    expect(result.errors).toHaveLength(1);
  });

  it('rejects list operands on direct fields', () => {
    const result = service.validateFlatViewFilterCreation(
      buildCreationArgs({
        operand: ViewFilterOperand.IS_IN_LIST,
        sourceFieldType: FieldMetadataType.UUID,
      }),
    );

    expect(result.errors).toHaveLength(1);
  });
});
