import { BadRequestException } from '@nestjs/common';

export enum FilterComparators {
  eq = 'eq',
  neq = 'neq',
  in = 'in',
  containsAny = 'containsAny',
  is = 'is',
  gt = 'gt',
  gte = 'gte',
  lt = 'lt',
  lte = 'lte',
  startsWith = 'startsWith',
  endsWith = 'endsWith',
  like = 'like',
  ilike = 'ilike',
  search = 'search',

  // Not handled rigth now
  // regex = 'regex',
  // iregex = 'iregex',
}

export const parseBaseFilter = (
  baseFilter: string,
): {
  fields: string[];
  comparator: string;
  value: string;
} => {
  if (!baseFilter.match(`^(.+)\\[(.+)\\]:(.+)$`)) {
    throw new BadRequestException(
      `'filter' invalid for '${baseFilter}'. eg: price[gte]:10`,
    );
  }
  let fields = '';
  let comparator = '';
  let value = '';
  let fillFields = true;
  let fillComparator = false;
  let fillValue = false;

  // baseFilter = field_1.subfield[in]:["2023-00-00 OO:OO:OO","2024-00-00 OO:OO:OO"]
  for (const c of baseFilter) {
    if (fillValue) value += c;

    if (c === ']' && !fillValue) fillComparator = false;
    if (c === ':' && !fillComparator) fillValue = true;

    if (fillComparator) comparator += c;

    if (c === '[' && fillFields) {
      fillFields = false;
      fillComparator = true;
    }

    if (fillFields) fields += c;
  }
  // field = field_1.subfield ; comparator = in ; value = ["2023-00-00 OO:OO:OO","2024-00-00 OO:OO:OO"]

  if (!Object.keys(FilterComparators).includes(comparator)) {
    throw new BadRequestException(
      `'filter' invalid for '${baseFilter}', comparator ${comparator} not in ${Object.keys(
        FilterComparators,
      ).join(', ')}`,
    );
  }

  // REST parsing runs before object metadata is available. `searchVector` is the
  // sole system TS_VECTOR field exposed by this grammar; keep `search` confined
  // to it so scalar/custom JSON fields can never opt into the TS query operator.
  if (comparator === FilterComparators.search && fields !== 'searchVector') {
    throw new BadRequestException(
      `'filter' invalid for '${baseFilter}', comparator search is only supported on searchVector`,
    );
  }

  return { fields: fields.split('.'), comparator, value };
};
