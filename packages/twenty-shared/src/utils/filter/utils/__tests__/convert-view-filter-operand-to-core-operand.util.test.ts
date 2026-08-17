import { ViewFilterOperand, ViewFilterOperandDeprecated } from '@/types';
import { convertViewFilterOperandToCoreOperand } from '@/utils/filter/utils/convert-view-filter-operand-to-core-operand.util';

describe('convertViewFilterOperandToCoreOperand', () => {
  it.each(Object.values(ViewFilterOperand))(
    'should preserve current operand %s',
    (operand) => {
      expect(convertViewFilterOperandToCoreOperand(operand)).toBe(operand);
    },
  );

  it.each([
    [ViewFilterOperandDeprecated.Is, ViewFilterOperand.IS],
    [ViewFilterOperandDeprecated.IsNotNull, ViewFilterOperand.IS_NOT_NULL],
    [ViewFilterOperandDeprecated.IsNot, ViewFilterOperand.IS_NOT],
    [
      ViewFilterOperandDeprecated.LessThanOrEqual,
      ViewFilterOperand.LESS_THAN_OR_EQUAL,
    ],
    [
      ViewFilterOperandDeprecated.GreaterThanOrEqual,
      ViewFilterOperand.GREATER_THAN_OR_EQUAL,
    ],
    [ViewFilterOperandDeprecated.IsBefore, ViewFilterOperand.IS_BEFORE],
    [ViewFilterOperandDeprecated.IsAfter, ViewFilterOperand.IS_AFTER],
    [ViewFilterOperandDeprecated.Contains, ViewFilterOperand.CONTAINS],
    [
      ViewFilterOperandDeprecated.DoesNotContain,
      ViewFilterOperand.DOES_NOT_CONTAIN,
    ],
    [ViewFilterOperandDeprecated.IsEmpty, ViewFilterOperand.IS_EMPTY],
    [ViewFilterOperandDeprecated.IsNotEmpty, ViewFilterOperand.IS_NOT_EMPTY],
    [ViewFilterOperandDeprecated.IsRelative, ViewFilterOperand.IS_RELATIVE],
    [ViewFilterOperandDeprecated.IsInPast, ViewFilterOperand.IS_IN_PAST],
    [ViewFilterOperandDeprecated.IsInFuture, ViewFilterOperand.IS_IN_FUTURE],
    [ViewFilterOperandDeprecated.IsToday, ViewFilterOperand.IS_TODAY],
  ])('should convert deprecated operand %s', (deprecated, current) => {
    expect(convertViewFilterOperandToCoreOperand(deprecated)).toBe(current);
  });
});
