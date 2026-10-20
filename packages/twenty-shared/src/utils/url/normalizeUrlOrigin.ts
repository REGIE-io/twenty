import { getUrlSafely } from '@/utils/getUrlSafely';
import { isDefined } from '@/utils/validation';

const SCHEME_PATTERN = /^\s*[a-z][a-z\d+.-]*:\/\//i;
const SCHEMELESS_HOST_PATTERN = /^[a-z\d-]+(\.[a-z\d-]+)+(?=(:\d+)?([/?#]|$))/i;

// Lowercases the URL origin (scheme + host) and removes a trailing slash.
// URL() already lowercases the origin and preserves percent-encoded sequences
// in the path, query, and hash (e.g. %2F stays %2F, %2520 stays %2520).
// Without "scheme://", URL() fails or reads "host:port" as a scheme, so only
// the host is lowercased there.
export const normalizeUrlOrigin = (rawUrl: string) => {
  if (!SCHEME_PATTERN.test(rawUrl)) {
    return rawUrl.replace(SCHEMELESS_HOST_PATTERN, (host) =>
      host.toLowerCase(),
    );
  }

  const url = getUrlSafely(rawUrl);

  if (!isDefined(url)) {
    return rawUrl;
  }

  return (url.origin + url.pathname + url.search + url.hash).replace(/\/$/, '');
};
