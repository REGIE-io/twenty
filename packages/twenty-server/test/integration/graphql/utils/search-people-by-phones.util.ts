import gql from 'graphql-tag';

import { makeGraphqlAPIRequest } from 'test/integration/graphql/utils/make-graphql-api-request.util';

export type BulkPhoneSearchLookup = {
  clientReference: string;
  phoneNumber: string;
};

export type BulkPhoneSearchLookupResult = {
  clientReference: string;
  phoneNumber: string;
  status: 'FOUND' | 'NOT_FOUND' | 'INVALID';
  matches: Array<{ recordId: string }>;
  hasMore: boolean;
  error: { code: string; message: string } | null;
};

export const searchPeopleByPhones = async ({
  lookups,
  matchLimitPerPhone,
  accessToken,
}: {
  lookups: BulkPhoneSearchLookup[];
  matchLimitPerPhone?: number;
  accessToken?: string;
}) => {
  const response = await makeGraphqlAPIRequest(
    {
      query: gql`
        query SearchPeopleByPhones(
          $lookups: [PhoneSearchLookupInput!]!
          $matchLimitPerPhone: Int
        ) {
          searchPeopleByPhones(
            lookups: $lookups
            matchLimitPerPhone: $matchLimitPerPhone
          ) {
            results {
              clientReference
              phoneNumber
              status
              matches {
                recordId
              }
              hasMore
              error {
                code
                message
              }
            }
          }
        }
      `,
      variables: { lookups, matchLimitPerPhone },
    },
    accessToken,
  );

  return response.body as {
    data?: {
      searchPeopleByPhones: { results: BulkPhoneSearchLookupResult[] };
    };
    errors?: Array<{
      message: string;
      extensions?: { code?: string; retryAfter?: number };
    }>;
  };
};
