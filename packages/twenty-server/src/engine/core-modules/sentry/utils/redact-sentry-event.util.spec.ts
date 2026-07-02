import { redactSentryEvent } from 'src/engine/core-modules/sentry/utils/redact-sentry-event.util';

describe('redactSentryEvent', () => {
  it('redacts secrets from request, extra, and contexts while keeping tenant-safe ids', () => {
    const redacted = redactSentryEvent({
      request: {
        headers: {
          authorization: 'Bearer access-token',
          cookie: 'sid=session-cookie',
          'x-regie-internal-token': 'internal-token',
          'content-type': 'application/json',
        },
        cookies: {
          session: 'session-cookie',
        },
        data: {
          apiKey: 'api-key',
          nested: {
            access_token: 'access-token',
            refresh_token: 'refresh-token',
            workspaceId: 'workspace-id',
          },
        },
      },
      extra: {
        publicValue: 'visible',
        clientSecret: 'client-secret',
      },
      contexts: {
        twenty: {
          workspace_id: 'workspace-id',
          user_workspace_id: 'user-workspace-id',
        },
        auth: {
          Authorization: 'Bearer context-token',
        },
      },
    });

    expect(redacted.request?.headers).toEqual({
      authorization: '[Filtered]',
      cookie: '[Filtered]',
      'x-regie-internal-token': '[Filtered]',
      'content-type': 'application/json',
    });
    expect(redacted.request?.cookies).toEqual({
      session: '[Filtered]',
    });
    expect(redacted.request?.data).toEqual({
      apiKey: '[Filtered]',
      nested: {
        access_token: '[Filtered]',
        refresh_token: '[Filtered]',
        workspaceId: 'workspace-id',
      },
    });
    expect(redacted.extra).toEqual({
      publicValue: 'visible',
      clientSecret: '[Filtered]',
    });
    expect(redacted.contexts).toEqual({
      twenty: {
        workspace_id: 'workspace-id',
        user_workspace_id: 'user-workspace-id',
      },
      auth: {
        Authorization: '[Filtered]',
      },
    });
  });
});
