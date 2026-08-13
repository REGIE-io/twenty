import { FieldMetadataType, ViewFilterOperand } from 'twenty-shared/types';

import { FlatViewFilterValidatorService } from 'src/engine/workspace-manager/workspace-migration/workspace-migration-builder/validators/services/flat-view-filter-validator.service';

describe('FlatViewFilterValidatorService', () => {
  const validator = new FlatViewFilterValidatorService() as unknown as {
    getIncompatibleOperandError(input: {
      operand: ViewFilterOperand;
      fieldType: FieldMetadataType;
      subFieldName?: string | null;
      relationTargetFieldType?: FieldMetadataType;
    }): unknown;
  };

  it.each([ViewFilterOperand.IS_IN_LIST, ViewFilterOperand.IS_NOT_IN_LIST])(
    'allows %s only for a relation target selected through a relation',
    (operand) => {
      expect(
        validator.getIncompatibleOperandError({
          operand,
          fieldType: FieldMetadataType.RELATION,
          relationTargetFieldType: FieldMetadataType.RELATION,
        }),
      ).toBeUndefined();
    },
  );

  it.each([
    {
      fieldType: FieldMetadataType.TEXT,
      relationTargetFieldType: undefined,
    },
    {
      fieldType: FieldMetadataType.RELATION,
      relationTargetFieldType: FieldMetadataType.TEXT,
    },
  ])('rejects list operands for unsupported field shape %#', (input) => {
    expect(
      validator.getIncompatibleOperandError({
        operand: ViewFilterOperand.IS_IN_LIST,
        ...input,
      }),
    ).toBeDefined();
    expect(
      validator.getIncompatibleOperandError({
        operand: ViewFilterOperand.IS_NOT_IN_LIST,
        ...input,
      }),
    ).toBeDefined();
  });
});
