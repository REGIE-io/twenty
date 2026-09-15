import { GraphQLInputObjectType, GraphQLString } from 'graphql';

export const TSVectorFilterType = new GraphQLInputObjectType({
  name: 'TSVectorFilter',
  fields: {
    search: { type: GraphQLString },
    // `search` ORs the tsvector match with an ILIKE over the vector's text, which no index
    // covers, so the planner scans the whole table. `match` is the same match without that
    // fallback, so a GIN index on the search vector is usable and an ordinary list query can
    // filter on it while keeping its own sort, cursor and totalCount.
    match: { type: GraphQLString },
  },
});
