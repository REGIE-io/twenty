import { ViewFilterOperand } from '@/types';
import { getFilterOperandsForFilterableFieldType } from '@/utils/filter/utils/getFilterOperandsForFilterableFieldType';

describe('getFilterOperandsForFilterableFieldType', () => {
  const emptyOperands = [
    ViewFilterOperand.IS_EMPTY,
    ViewFilterOperand.IS_NOT_EMPTY,
  ];

  it('should return select operands', () => {
    expect(
      getFilterOperandsForFilterableFieldType({ filterType: 'SELECT' }),
    ).toEqual([
      ViewFilterOperand.IS,
      ViewFilterOperand.IS_NOT,
      ...emptyOperands,
    ]);
  });

  it('should not expose list membership operands in the generic relation menu', () => {
    expect(
      getFilterOperandsForFilterableFieldType({ filterType: 'RELATION' }),
    ).toEqual([
      ViewFilterOperand.IS,
      ViewFilterOperand.IS_NOT,
      ...emptyOperands,
    ]);
  });

  it('should preserve contains as the default text operand', () => {
    expect(
      getFilterOperandsForFilterableFieldType({ filterType: 'TEXT' }),
    ).toEqual([
      ViewFilterOperand.CONTAINS,
      ViewFilterOperand.IS,
      ViewFilterOperand.IS_NOT,
      ViewFilterOperand.STARTS_WITH,
      ViewFilterOperand.DOES_NOT_CONTAIN,
      ...emptyOperands,
    ]);
  });

  it('should preserve actor source subfield operands', () => {
    expect(
      getFilterOperandsForFilterableFieldType({
        filterType: 'ACTOR',
        subFieldName: 'source',
      }),
    ).toEqual([
      ViewFilterOperand.IS,
      ViewFilterOperand.IS_NOT,
      ...emptyOperands,
    ]);
  });

  it('should preserve actor workspace member subfield operands', () => {
    expect(
      getFilterOperandsForFilterableFieldType({
        filterType: 'ACTOR',
        subFieldName: 'workspaceMemberId',
      }),
    ).toEqual([
      ViewFilterOperand.IS,
      ViewFilterOperand.IS_NOT,
      ...emptyOperands,
    ]);
  });

  it('should default currency to amount operands', () => {
    expect(
      getFilterOperandsForFilterableFieldType({ filterType: 'CURRENCY' }),
    ).toEqual([
      ViewFilterOperand.GREATER_THAN_OR_EQUAL,
      ViewFilterOperand.LESS_THAN_OR_EQUAL,
      ViewFilterOperand.IS,
      ViewFilterOperand.IS_NOT,
      ...emptyOperands,
    ]);
  });

  it('should expose exact operands for FULL_NAME firstName and lastName subfields', () => {
    for (const subFieldName of ['firstName', 'lastName']) {
      expect(
        getFilterOperandsForFilterableFieldType({
          filterType: 'FULL_NAME',
          subFieldName,
        }),
      ).toEqual([
        ViewFilterOperand.CONTAINS,
        ViewFilterOperand.IS,
        ViewFilterOperand.IS_NOT,
        ViewFilterOperand.DOES_NOT_CONTAIN,
        ...emptyOperands,
      ]);
    }
  });

  it('should not expose exact operands for a bare FULL_NAME field', () => {
    expect(
      getFilterOperandsForFilterableFieldType({ filterType: 'FULL_NAME' }),
    ).toEqual([
      ViewFilterOperand.CONTAINS,
      ViewFilterOperand.DOES_NOT_CONTAIN,
      ...emptyOperands,
    ]);
  });

  it('should not expose exact operands for an invalid FULL_NAME subfield', () => {
    expect(
      getFilterOperandsForFilterableFieldType({
        filterType: 'FULL_NAME',
        subFieldName: 'displayName',
      }),
    ).toEqual([
      ViewFilterOperand.CONTAINS,
      ViewFilterOperand.DOES_NOT_CONTAIN,
      ...emptyOperands,
    ]);
  });
});
