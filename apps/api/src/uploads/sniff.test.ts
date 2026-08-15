/**
 * Content-type sniffing and filename cleaning.
 *
 * Both are pure, both take attacker-controlled input, and both are the difference
 * between an attachment and a stored cross-site script. The integration lane sends
 * a real multipart body whose declared type disagrees with its bytes; this lane
 * is where the signature table itself is pinned.
 */
import { describe, expect, it } from 'vitest';

import { safeFilename, sniffContentType } from './sniff';

/** A header, as bytes. Written as numbers so the file has no binary in it. */
const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);

const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46);
const GIF = bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00);
const WEBP = bytes(0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50);
const PDF = bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37);
/** `<script>a` in ASCII. What a client claiming `image/png` might actually send. */
const HTML = bytes(0x3c, 0x73, 0x63, 0x72, 0x69, 0x70, 0x74, 0x3e, 0x61);

describe('sniffContentType', () => {
  it.each([
    ['image/png', PNG],
    ['image/jpeg', JPEG],
    ['image/gif', GIF],
    ['image/webp', WEBP],
    ['application/pdf', PDF],
  ])('recognises %s', (expected, head) => {
    expect(sniffContentType(head)).toBe(expected);
  });

  it('does not confuse WebP with another RIFF container', () => {
    // "RIFF" alone also starts a WAV and an AVI. Matching on the prefix would
    // label both as an image, and a browser told an AVI is `image/webp` renders
    // nothing while the person who uploaded it is told it worked.
    const wav = bytes(0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45);

    expect(sniffContentType(wav)).toBe('application/octet-stream');
  });

  it('falls back rather than guessing on something it does not know', () => {
    // `application/octet-stream` is what a browser downloads instead of
    // rendering. That is the safe default and it is also the honest one.
    expect(sniffContentType(HTML)).toBe('application/octet-stream');
  });

  it('falls back on an empty head, which is what a zero-byte upload produces', () => {
    expect(sniffContentType(bytes())).toBe('application/octet-stream');
  });

  it('falls back on a head too short to hold the signature', () => {
    // A one-byte file whose byte happens to be 0xff must not be read as the
    // start of a JPEG.
    expect(sniffContentType(bytes(0xff))).toBe('application/octet-stream');
  });

  it('ignores the declared type entirely, because it has no way to see it', () => {
    // The assertion is structural: this function takes bytes and nothing else.
    // A signature that accepted a hint would be a signature somebody could pass
    // the request header into.
    expect(sniffContentType(HTML)).not.toBe('image/png');
  });
});

describe('safeFilename', () => {
  it('keeps an ordinary name', () => {
    expect(safeFilename('diagram.png')).toBe('diagram.png');
  });

  it('strips a directory traversal', () => {
    // The name is never used as a path -- the storage key is generated
    // server-side -- but stripping it here means the value echoed back in
    // `Content-Disposition` cannot describe somebody else's filesystem either.
    expect(safeFilename('../../etc/passwd')).toBe('passwd');
  });

  it('strips a Windows path', () => {
    expect(safeFilename('C:\\Users\\ana\\report.pdf')).toBe('report.pdf');
  });

  it('removes the quote that would break out of the header', () => {
    // `Content-Disposition: attachment; filename="..."`. A quote here ends the
    // value early and everything after it becomes header syntax the client never
    // sent.
    expect(safeFilename('a"; x=y.png')).toBe('a; x=y.png');
  });

  it('removes control characters', () => {
    // A CR or an LF in a header value is header injection. Written as escapes,
    // never as the characters themselves: `scripts/invisible-chars.mjs` blocks
    // the literal at commit time for exactly this reason.
    expect(safeFilename('report\u000d\u000aX-Injected: yes.pdf')).toBe('reportX-Injected: yes.pdf');
  });

  it('names an empty result rather than sending filename=""', () => {
    expect(safeFilename('   ')).toBe('attachment');
  });

  it('names a result that cleaned down to dots', () => {
    expect(safeFilename('..')).toBe('attachment');
  });

  it('bounds the length, because the value reaches a header', () => {
    expect(safeFilename('a'.repeat(500))).toHaveLength(200);
  });
});
