import gql from 'graphql-tag';

import { makeGraphqlAPIRequest } from 'test/integration/graphql/utils/make-graphql-api-request.util';

type SearchPeopleByPhoneArgs = {
  phoneNumber: string;
  countryCode?: string;
  limit: number;
  after?: string;
  accessToken?: string;
};

export type SearchPeopleByPhoneResponse = {
  searchPeopleByPhone: {
    edges: Array<{
      node: { recordId: string };
      cursor: string;
    }>;
    pageInfo: {
      endCursor: string | null;
      hasNextPage: boolean;
    };
  };
};

// This intentionally uses the proposed raw operation until schema/client artifacts exist.
export const searchPeopleByPhone = async ({
  phoneNumber,
  countryCode,
  limit,
  after,
  accessToken,
}: SearchPeopleByPhoneArgs) => {
  const response = await makeGraphqlAPIRequest(
    {
      query: gql`
        query SearchPeopleByPhone(
          $phoneNumber: String!
          $countryCode: String
          $limit: Int!
          $after: String
        ) {
          searchPeopleByPhone(
            phoneNumber: $phoneNumber
            countryCode: $countryCode
            limit: $limit
            after: $after
          ) {
            edges {
              node {
                recordId
              }
              cursor
            }
            pageInfo {
              endCursor
              hasNextPage
            }
          }
        }
      `,
      variables: { phoneNumber, countryCode, limit, after },
    },
    accessToken,
  );

  return response.body as {
    data?: SearchPeopleByPhoneResponse;
    errors?: Array<{ message: string }>;
  };
};
