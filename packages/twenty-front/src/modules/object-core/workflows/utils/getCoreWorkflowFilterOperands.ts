import { type ViewFilterOperand } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';

import { CORE_WORKFLOW_FILTER_OPERAND_BY_VIEW_FILTER_OPERAND } from '@/object-core/workflows/constants/CoreWorkflowFilterOperandByViewFilterOperand';
import { getStepFilterOperands } from '@/workflow/workflow-steps/filters/utils/getStepFilterOperands';

export const getCoreWorkflowFilterOperands = ({
  filterType,
}: {
  filterType: string | undefined;
}): readonly ViewFilterOperand[] =>
  getStepFilterOperands({ filterType, subFieldName: undefined }).filter(
    (operand) =>
      isDefined(CORE_WORKFLOW_FILTER_OPERAND_BY_VIEW_FILTER_OPERAND[operand]),
  );
