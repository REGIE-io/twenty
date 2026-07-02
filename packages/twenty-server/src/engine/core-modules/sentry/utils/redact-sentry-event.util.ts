import { type Event } from '@sentry/node';

const FILTERED_VALUE = '[Filtered]';

const SENSITIVE_KEY_PARTS = [
  'authorization',
  'cookie',
  'dsn',
  'password',
  'secret',
  'token',
  'api_key',
  'apikey',
  'x_api_key',
  'x_regie_internal_token',
  'regie_internal_token',
  'internal_token',
];

export const redactSentryEvent = (event: Event): Event => {
  return redactValue(event) as Event;
};

const redactValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }

  if (!isPlainRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [
      key,
      redactEntry(key, nestedValue),
    ]),
  );
};

const redactEntry = (key: string, value: unknown): unknown => {
  if (!isSensitiveKey(key)) {
    return redactValue(value);
  }

  if (isCookieContainer(key) && isPlainRecord(value)) {
    return Object.fromEntries(
      Object.keys(value).map((cookieName) => [cookieName, FILTERED_VALUE]),
    );
  }

  return FILTERED_VALUE;
};

const isSensitiveKey = (key: string): boolean => {
  const normalizedKey = key.replaceAll('-', '_').toLowerCase();

  return SENSITIVE_KEY_PARTS.some((sensitiveKeyPart) =>
    normalizedKey.includes(sensitiveKeyPart),
  );
};

const isCookieContainer = (key: string): boolean => {
  return key.toLowerCase() === 'cookies';
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  return (
    typeof value === 'object' &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
};
