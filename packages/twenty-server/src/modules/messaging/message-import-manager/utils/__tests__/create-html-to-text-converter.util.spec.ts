import { createHtmlToTextConverter } from 'src/modules/messaging/message-import-manager/utils/create-html-to-text-converter.util';

describe('createHtmlToTextConverter', () => {
  const convertHtmlToText = createHtmlToTextConverter();

  it('should convert basic HTML to plain text', () => {
    expect(convertHtmlToText('<p>Hello world</p>')).toBe('Hello world');
  });

  it('should preserve newlines from block elements', () => {
    const result = convertHtmlToText('<p>First</p><p>Second</p>');

    expect(result).toContain('First');
    expect(result).toContain('Second');
  });

  it('should replace non-breaking spaces with regular spaces', () => {
    expect(convertHtmlToText('<p>Hello\u00A0world</p>')).toBe('Hello world');
  });

  it('should return empty string for empty input', () => {
    expect(convertHtmlToText('')).toBe('');
  });

  it('should keep the body when planer strips an entirely-quoted message to empty', () => {
    // Regression: forwarded/fully-quoted html was stripped to empty by planer.
    const result = convertHtmlToText(
      '<div class="gmail_quote"><p>Only quoted content here</p></div>',
    );

    expect(result).toBe('Only quoted content here');
  });

  it('should strip the quoted part of a gmail reply', () => {
    const result = convertHtmlToText(
      '<div>Sounds good, thanks!</div><div class="gmail_quote">On Mon, Oct 13, 2026 at 9:00 AM John wrote:<blockquote><p>Can we meet?</p></blockquote></div>',
    );

    expect(result).toContain('Sounds good, thanks!');
    expect(result).not.toContain('Can we meet?');
  });

  it('should skip quote stripping on html too large for planer', () => {
    // Regression: planer froze the worker for seconds on large html emails.
    const filler = '<p>newsletter paragraph</p>'.repeat(5_000);
    const result = convertHtmlToText(
      `<div>Reply</div>${filler}<div class="gmail_quote"><p>Old quote</p></div>`,
    );

    expect(result).toContain('Reply');
    expect(result).toContain('Old quote');
  });

  it('should strip a non-ascii reply header without a quote container', () => {
    const result = convertHtmlToText(
      'Dzięki!<br><br>W dniu 13.10.2026 o 09:00 użytkownik Jan napisał:<br>Czy możemy się spotkać?',
    );

    expect(result).toContain('Dzięki!');
    expect(result).not.toContain('Czy możemy');
  });

  it('should check reply markers in linear time on crafted input', () => {
    const start = Date.now();

    convertHtmlToText('1.1.1'.repeat(19_800));

    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it('should sanitize malicious HTML', () => {
    const result = convertHtmlToText(
      '<p>Hello</p><script>alert("xss")</script>',
    );

    expect(result).not.toContain('script');
    expect(result).not.toContain('alert');
    expect(result).toContain('Hello');
  });
});
