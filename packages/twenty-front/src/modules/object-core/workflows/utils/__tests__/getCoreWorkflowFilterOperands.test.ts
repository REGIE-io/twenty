import { ViewFilterOperand } from 'twenty-shared/types';

import { CORE_WORKFLOW_FILTER_FIELDS } from '@/object-core/workflows/constants/CoreWorkflowFilterFields';
import { CORE_WORKFLOW_FILTER_OPERAND_BY_VIEW_FILTER_OPERAND } from '@/object-core/workflows/constants/CoreWorkflowFilterOperandByViewFilterOperand';
import { getCoreWorkflowFilterOperands } from '@/object-core/workflows/utils/getCoreWorkflowFilterOperands';
import { getRecordFilterOperands } from '@/object-record/record-filter/utils/getRecordFilterOperands';
import { getStepFilterOperands } from '@/workflow/workflow-steps/filters/utils/getStepFilterOperands';

describe('getCoreWorkflowFilterOperands', () => {
  it.each(CORE_WORKFLOW_FILTER_FIELDS)(
    'offers only backend-supported operands for $key',
    ({ filterType }) => {
      const operands = getCoreWorkflowFilterOperands({ filterType });

      expect(operands.length).toBeGreaterThan(0);
      for (const operand of operands) {
        expect(
          CORE_WORKFLOW_FILTER_OPERAND_BY_VIEW_FILTER_OPERAND[operand],
        ).toBeDefined();
      }
    },
  );

  it('excludes unsupported text comparisons from the workflow-list picker only', () => {
    const operands = getCoreWorkflowFilterOperands({ filterType: 'TEXT' });

    expect(operands).toContain(ViewFilterOperand.IS);
    expect(operands).toContain(ViewFilterOperand.CONTAINS);
    expect(operands).not.toContain(ViewFilterOperand.IS_NOT);
    expect(operands).not.toContain(ViewFilterOperand.STARTS_WITH);
  });

  it('preserves exact and prefix comparisons in generic workflow step filters', () => {
    expect(
      getStepFilterOperands({ filterType: 'TEXT', subFieldName: undefined }),
    ).toEqual(
      expect.arrayContaining([
        ViewFilterOperand.IS,
        ViewFilterOperand.IS_NOT,
        ViewFilterOperand.STARTS_WITH,
      ]),
    );
  });

  it.each([
    {
      filterType: 'TEXT' as const,
      subFieldName: undefined,
      expected: [
        ViewFilterOperand.IS,
        ViewFilterOperand.IS_NOT,
        ViewFilterOperand.STARTS_WITH,
      ],
    },
    {
      filterType: 'FULL_NAME' as const,
      subFieldName: 'firstName',
      expected: [ViewFilterOperand.IS, ViewFilterOperand.IS_NOT],
    },
    {
      filterType: 'FULL_NAME' as const,
      subFieldName: 'lastName',
      expected: [ViewFilterOperand.IS, ViewFilterOperand.IS_NOT],
    },
  ])(
    'preserves CRM record comparisons for $filterType/$subFieldName',
    ({ expected, ...field }) => {
      expect(getRecordFilterOperands(field)).toEqual(
        expect.arrayContaining(expected),
      );
    },
  );
});
