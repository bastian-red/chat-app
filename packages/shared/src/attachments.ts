/**
 * Where an attachment is fetched from, as a path rather than a URL.
 *
 * Same reasoning as `rooms.ts`, one level up: **three processes have to agree on
 * this string and none of them can see the others.** `apps/api` serves the bytes,
 * `apps/realtime` puts the path into every `message.new` it broadcasts, and
 * `apps/web` renders it. A version that drifts by a character produces a broken
 * image and no error anywhere.
 *
 * A path and not an absolute URL, deliberately. The two servers know
 * `API_BASE_URL`, which is server-to-server (`http://api:4000` inside compose);
 * the browser knows `NEXT_PUBLIC_API_BASE_URL`, which is the host-visible one.
 * Baking either into a broadcast gets it wrong for the other, and baking the
 * server-side one into a payload the browser renders produces an image that loads
 * on the server and 404s in every tab. The client joins the path to the base it
 * already has.
 *
 * The API serves this behind the session (`docs/SPECS.md` section 1.1), which is
 * why the path carries an id and not the storage key: the key is the disk layout,
 * and putting it on the wire would let anybody who saw one message's attachment
 * enumerate the upload directory.
 */
export function attachmentPath(attachmentId: string): string {
  return `/attachments/${attachmentId}`;
}
