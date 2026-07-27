import { makeMetadataAPIRequest } from 'test/integration/metadata/suites/utils/make-metadata-api-request.util';
import { destroyViewQueryFactory } from 'test/integration/metadata/suites/view/utils/destroy-view-query-factory.util';
import { type CommonResponseBody } from 'test/integration/metadata/types/common-response-body.type';
import { warnIfErrorButNotExpectedToFail } from 'test/integration/metadata/utils/warn-if-error-but-not-expected-to-fail.util';
import { warnIfNoErrorButExpectedToFail } from 'test/integration/metadata/utils/warn-if-no-error-but-expected-to-fail.util';

// Regie fork: standard objects are provisioned without any views (UI metadata is
// skipped during tenant provisioning), so a suite's sole view on a standard object is
// the object's only view. Twenty forbids deleting the only view, so afterAll cleanup
// that destroys it hits this rule. Tolerate only that specific rule so cleanup is a
// no-op instead of failing the suite; every other error still asserts as before.
const CANNOT_DELETE_ONLY_VIEW_MESSAGE =
  'Cannot delete the only view for this object';

const isCannotDeleteOnlyViewError = (errors: unknown): boolean => {
  if (!Array.isArray(errors) || errors.length === 0) {
    return false;
  }

  return errors.every(
    (error) =>
      error?.extensions?.userFriendlyMessage ===
      CANNOT_DELETE_ONLY_VIEW_MESSAGE,
  );
};

export const destroyOneView = async ({
  viewId,
  expectToFail,
}: {
  viewId: string;
  expectToFail?: boolean;
}): CommonResponseBody<{
  destroyView: boolean;
}> => {
  const graphqlOperation = destroyViewQueryFactory({
    viewId,
  });

  const response = await makeMetadataAPIRequest(graphqlOperation);

  if (expectToFail === true) {
    warnIfNoErrorButExpectedToFail({
      response,
      errorMessage: 'View destruction should have failed but did not',
    });
  }

  if (
    expectToFail === false &&
    !isCannotDeleteOnlyViewError(response.body.errors)
  ) {
    warnIfErrorButNotExpectedToFail({
      response,
      errorMessage: 'View destruction has failed but should not',
    });
  }

  return { data: response.body.data, errors: response.body.errors };
};
