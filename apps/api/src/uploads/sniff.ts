/**
 * The content type of a file, from its bytes.
 *
 * **Never from the request header.** `Content-Type` on a multipart part is
 * attacker-controlled: a client that says `image/png` and sends an HTML document
 * gets that document served back with `Content-Type: image/png` if the header is
 * trusted, and a browser that sniffs will happily execute it in the API's origin.
 * The stored type is what the download route sets, so this function is the
 * difference between an attachment and a stored XSS.
 *
 * Magic numbers only, and a deliberately short list: the formats a chat actually
 * attaches. Anything unrecognised becomes `application/octet-stream`, which
 * browsers download rather than render. That is the safe default and it is also
 * the honest one -- "I do not know what this is" should not be answered with the
 * uploader's guess.
 *
 * PDF is included because it is the one non-image people attach constantly. SVG
 * is deliberately **not**: it is an XML document that can carry script, and there
 * is no byte signature that separates a safe SVG from a hostile one.
 */

/** The longest signature below, so a caller knows how many bytes to buffer. */
export const SNIFF_BYTES = 12;

const FALLBACK = 'application/octet-stream';

interface Signature {
  type: string;
  /** Byte values, with `null` for "any byte here". */
  bytes: (number | null)[];
  offset?: number;
}

const SIGNATURES: Signature[] = [
  // PNG: \x89PNG\r\n\x1a\n
  { type: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  // JPEG: FF D8 FF. The fourth byte varies by encoder, so it is not checked.
  { type: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  // GIF87a / GIF89a
  { type: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  // WebP is a RIFF container: "RIFF" then four size bytes then "WEBP". The size
  // is what the nulls skip, and checking only "RIFF" would also match WAV and AVI.
  {
    type: 'image/webp',
    bytes: [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50],
  },
  // %PDF-
  { type: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
];

export function sniffContentType(head: Uint8Array): string {
  for (const signature of SIGNATURES) {
    const offset = signature.offset ?? 0;
    if (head.length < offset + signature.bytes.length) continue;

    const matches = signature.bytes.every(
      (byte, index) => byte === null || head[offset + index] === byte,
    );
    if (matches) return signature.type;
  }
  return FALLBACK;
}

/**
 * A filename safe to store and to put in a `Content-Disposition`.
 *
 * The uploaded name arrives from a browser and can contain `../`, a null byte, or
 * a quote that breaks out of the header. It is never used as a path -- the storage
 * key is generated server-side -- but it *is* echoed back on download, so it is
 * cleaned rather than trusted.
 */
export function safeFilename(raw: string): string {
  const base = raw.split(/[/\\]/u).pop() ?? '';
  const cleaned = base
    // Control characters and the quoting characters a header cares about.
    // `no-control-regex` is disabled here rather than worked around: control
    // characters are exactly what this line exists to remove, and a filename
    // carrying a CR or an LF is how a value breaks out of a `Content-Disposition`
    // header into one the client never sent.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"\\]/gu, '')
    .trim();
  // A name that cleaned down to nothing, or to a bare `..`, gets a neutral one
  // rather than an empty `filename=""` the browser resolves however it likes.
  return cleaned === '' || /^\.+$/u.test(cleaned) ? 'attachment' : cleaned.slice(0, 200);
}
