import createDOMPurify from 'dompurify';
import { convert, HtmlToTextOptions } from 'html-to-text';
import { JSDOM } from 'jsdom';
import * as planer from 'planer';
import { isNonEmptyString } from '@sniptt/guards';

import { normalizeMessageText } from 'src/modules/messaging/message-import-manager/utils/normalize-message-text.util';

const CONVERT_OPTIONS = {
  wordwrap: false,
  preserveNewlines: true,
} satisfies HtmlToTextOptions;

// planer re-serialises every element once per ancestor in jsdom, so a large
// html email blocks the worker thread for seconds and starves BullMQ lock
// renewal. Above this size we keep the quotes instead.
const PLANER_MAX_HTML_LENGTH = 100_000;

// What planer.extractFromHtml cuts on. With none of these present it returns
// its input unchanged, so newsletters and other non-replies can skip it.
const PLANER_REPLY_MARKERS = new RegExp(
  [
    // quote containers: Gmail, <blockquote>, Outlook ids and divider styles
    'gmail_quote',
    '<blockquote',
    'divRplyFwdMsg',
    'OLK_SRC_BODY_SECTION',
    'border-top:solid #(B5C4DF|E1E1E1)',
    'border-top-color: rgb\\(229, 229, 229\\)',
    // "From:" / "Date:" reply headers and their translations
    '\\b(from|van|de|von|fra|från|date|datum|envoyé|skickat|sendt)(\\s|&nbsp;)?:',
    // "-----Original Message-----" and its translations
    'original message|reply message|ursprüngliche nachricht|antwort nachricht|oprindelig meddelelse',
    // "On <date>, <person> wrote:" and its translations (no trailing \b:
    // it is ASCII-only and never matches after "ł")
    '\\b(wrote|a écrit|napisał|schreef|verzond|geschreven|schrieb|skrev)|\\bsent:',
    // "<date> ... <person>@" header lines; bounded so a crafted body
    // cannot make this check itself quadratic
    '\\d{1,4}[/.]\\d{1,4}[/.]\\d{1,4}[^<\\n@]{0,200}@',
    // ">"-quoted lines; sanitised html serialises text ">" as "&gt;"
    '(^|[>\\n])&gt;',
  ].join('|'),
  'i',
);

export const createHtmlToTextConverter = (): ((html: string) => string) => {
  const jsdom = new JSDOM('');
  const purify = createDOMPurify(jsdom.window);

  const toText = (html: string) =>
    normalizeMessageText(convert(html, CONVERT_OPTIONS));

  return (html: string): string => {
    const sanitizedHtml = purify.sanitize(html);

    if (
      sanitizedHtml.length > PLANER_MAX_HTML_LENGTH ||
      !PLANER_REPLY_MARKERS.test(sanitizedHtml)
    ) {
      return toText(sanitizedHtml);
    }

    const text = toText(
      planer.extractFromHtml(sanitizedHtml, jsdom.window.document),
    );

    // planer can strip an entirely-quoted (e.g. forwarded) body to nothing;
    // fall back to the un-stripped sanitized html so the body is not lost.
    return isNonEmptyString(text) ? text : toText(sanitizedHtml);
  };
};
