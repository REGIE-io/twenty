export type WorkspaceSchemaColumnDefinition = {
  name: string;
  type: string;
  isNullable?: boolean;
  default?: string | number | boolean | null;
  isPrimary?: boolean;
  isArray?: boolean;
  asExpression?: string;
  generatedType?: 'STORED' | 'VIRTUAL';
  // A plain tsvector column that a search-vector trigger fills, in a converted workspace.
  isFilledByTrigger?: boolean;
};
