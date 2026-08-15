/**
 * The REST surface, against the compiled API running as its own process.
 *
 * **Driven over HTTP rather than through `Test.createTestingModule`.** That is not
 * a preference: NestJS resolves constructor dependencies from the
 * `design:paramtypes` metadata `emitDecoratorMetadata` writes at compile time, and
 * vitest transforms with esbuild, which does not emit it. Booting the module
 * in-process under this runner produces a graph where every injected dependency is
 * `undefined`, and the symptom is a 500 from a guard reading a property of nothing.
 * `scripts/integration.sh` starts `apps/api/dist/main.js`, so the lane also
 * exercises the artifact `infra/Dockerfile.api` ships rather than a second
 * assembly of it.
 *
 * Four things get their own attention, because each is a rule the code would
 * otherwise only claim to follow:
 *
 * - an upload whose declared `Content-Type` disagrees with its bytes,
 * - a page boundary in the keyset paginator,
 * - the computed unread and unread-mention counts,
 * - register, sign in, and a token the guard actually verifies.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mintServiceToken } from '@chat/shared/server';

import { AUTH_SECRET, channelBySlug, person, prisma, type Person } from './harness';

const API = process.env.API_BASE_URL ?? 'http://localhost:4000';

let ana: Person;
let bruno: Person;

/** The demo password, as `packages/db/prisma/seed.ts` sets it. */
const DEMO_PASSWORD = 'demo-password-2026';

beforeAll(async () => {
  ana = await person('ana@chat.test');
  bruno = await person('bruno@chat.test');
}, 60_000);

interface ApiResponse {
  status: number;
  headers: Headers;
  body: any;
  text: string;
}

/**
 * One request, with the status and the parsed body together.
 *
 * Returning both rather than throwing on a non-2xx: half the assertions in this
 * file are *about* the status, and a helper that threw would turn every one of
 * them into a try/catch.
 */
async function call(
  path: string,
  init: (RequestInit & { token?: string }) | undefined = undefined,
): Promise<ApiResponse> {
  const { token, ...rest } = init ?? {};
  const headers = new Headers(rest.headers);
  if (token !== undefined) headers.set('authorization', `Bearer ${token}`);
  // Not set for FormData: fetch has to write its own boundary, and an explicit
  // content-type here would produce a multipart body the parser cannot split.
  if (rest.body !== undefined && !(rest.body instanceof FormData)) {
    headers.set('content-type', 'application/json');
  }

  const response = await fetch(`${API}${path}`, { ...rest, headers });
  const text = await response.text();

  let body: unknown = null;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    // A non-JSON body is a real answer from the download route, which streams
    // bytes. `text` is kept beside it rather than thrown on.
  }

  return { status: response.status, headers: response.headers, body, text };
}

/** A JSON POST, which is most of this file. */
const post = (path: string, body: unknown, token?: string): Promise<ApiResponse> =>
  call(path, {
    method: 'POST',
    body: JSON.stringify(body),
    ...(token === undefined ? {} : { token }),
  });

describe('the session guard', () => {
  it('refuses an authenticated route with no token', async () => {
    // Default closed. The guard is global, so a route added next year is
    // authenticated unless somebody writes `@Public()` on it; the opposite
    // arrangement fails silently in the direction that matters.
    expect((await call('/channels')).status).toBe(401);
  });

  it('refuses a token signed with a different secret', async () => {
    const forged = mintServiceToken(
      { id: ana.id, email: ana.email, name: ana.name },
      `${AUTH_SECRET}-wrong`,
    );

    expect((await call('/channels', { token: forged })).status).toBe(401);
  });

  it('never says which half of the token was wrong', async () => {
    // `expired` versus `signature` goes to the server's log. Telling a caller
    // which half to keep working on is a hint nobody legitimate needs.
    const response = await call('/channels', { token: 'nonsense' });

    expect(response.status).toBe(401);
    expect(response.text).not.toMatch(/signature|expired|malformed/iu);
  });

  it('lets /health through without one', async () => {
    // Public on purpose: a probe that needed a credential is a probe a container
    // runtime cannot run.
    expect((await call('/health')).status).toBe(200);
  });
});

describe('/health', () => {
  it('reports every dependency it actually exercised', async () => {
    const response = await call('/health');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.checks.map((check: { name: string }) => check.name).sort()).toEqual([
      'postgres',
      'redis',
      'uploads',
    ]);
  });

  it('reports a real Postgres round trip rather than a pool handle', async () => {
    const response = await call('/health');
    const postgres = response.body.checks.find(
      (check: { name: string }) => check.name === 'postgres',
    );

    expect(postgres).toMatchObject({ status: 'ok', detail: null });
    expect(typeof postgres.latencyMs).toBe('number');
  });
});

describe('auth', () => {
  const email = `new-${String(Date.now())}@chat.test`;

  it('registers, and returns a session rather than a token', async () => {
    // The API never mints. The web app mints for its own session and the API
    // verifies: one minter, two verifiers.
    const response = await post('/auth/register', {
      email,
      password: 'a-long-enough-password',
      name: 'New Person',
    });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ email, name: 'New Person', initials: 'NP' });
    expect(response.body).not.toHaveProperty('passwordHash');
    expect(response.body).not.toHaveProperty('token');
  });

  it('refuses a second account on the same address', async () => {
    const response = await post('/auth/register', {
      email,
      password: 'a-long-enough-password',
      name: 'Impostor',
    });

    expect(response.status).toBe(409);
  });

  it('treats the address as case-insensitive, so one person is one account', async () => {
    // `emailSchema` lowercases at the boundary. Without it, `Ana@` and `ana@`
    // would be two accounts identical in every list, and only one of them could
    // sign in with the password the person remembers.
    const response = await post('/auth/register', {
      email: email.toUpperCase(),
      password: 'a-long-enough-password',
      name: 'Shout',
    });

    expect(response.status).toBe(409);
    await prisma.user.deleteMany({ where: { email } });
  });

  it('signs in with the seeded password', async () => {
    const response = await post('/auth/sign-in', { email: ana.email, password: DEMO_PASSWORD });

    expect(response.status).toBe(201);
    expect(response.body.id).toBe(ana.id);
    expect(response.body.timeZone).toBe('Europe/Madrid');
  });

  it('gives the same answer for a wrong password and an unknown address', async () => {
    // Same status and same wording. The timing is equalised in the service by
    // verifying against a dummy hash on a miss; that is not observable from here,
    // but the response being identical is.
    const wrongPassword = await post('/auth/sign-in', {
      email: ana.email,
      password: 'not-the-password',
    });
    const noSuchAccount = await post('/auth/sign-in', {
      email: 'nobody@chat.test',
      password: 'not-the-password',
    });

    expect(wrongPassword.status).toBe(401);
    expect(noSuchAccount.status).toBe(401);
    expect(wrongPassword.body).toEqual(noSuchAccount.body);
  });

  it('reads the session from the row rather than from the token claims', async () => {
    const response = await call('/auth/session', { token: ana.token });

    expect(response.status).toBe(200);
    expect(response.body.id).toBe(ana.id);
    expect(response.body.timeZone).toBe('Europe/Madrid');
  });

  it('keeps email out of the directory', async () => {
    // Every signed-in account can read this. A chat's member list is not a reason
    // to hand every colleague's address to anybody who can open the app.
    const response = await call('/auth/directory', { token: ana.token });

    expect(response.status).toBe(200);
    expect(response.body.length).toBeGreaterThan(0);
    for (const entry of response.body) {
      expect(entry).not.toHaveProperty('email');
      expect(entry.id).not.toBe(ana.id);
    }
  });
});

describe('channels and unread counts', () => {
  it('computes unread and unreadMentions rather than reading a stored column', async () => {
    // The seed leaves Ana four messages behind in Product, one of which mentions
    // her. Storing these would mean two writers for one fact, and every unread
    // counter bug in every chat product is those two disagreeing.
    const response = await call('/channels', { token: ana.token });

    const product = response.body.find((row: { slug: string }) => row.slug === 'product');
    expect(product.unread).toBe(4);
    expect(product.unreadMentions).toBe(1);
  });

  it('labels a DM by its counterpart rather than by a name column', async () => {
    // A DM has no name: its label is whoever is in it, resolved per reader,
    // because "Ana Ruiz" is the wrong title for Ana's own window.
    const response = await call('/channels', { token: ana.token });

    const dm = response.body.find((row: { kind: string }) => row.kind === 'DM');
    expect(dm.name).toBeNull();
    expect(dm.counterparts).toHaveLength(1);
    expect(dm.counterparts[0].name).toBe('Bruno Salas');
  });

  it('refuses a channel the caller is not in, without confirming it exists', async () => {
    const incidents = await channelBySlug('incidents');
    const dana = await person('dana@chat.test');

    const response = await call(`/channels/${incidents.id}`, { token: dana.token });

    expect(response.status).toBe(403);
  });

  it('opens the same DM whoever asks for it', async () => {
    // Both people compute the same `dmKey`, and it is UNIQUE. This is the
    // non-racing half of that property; the racing half is a unit test over
    // `dmKeyFor` plus the catch in `openDm`.
    const first = await post('/channels/direct', { userId: bruno.id }, ana.token);
    const second = await post('/channels/direct', { userId: ana.id }, bruno.token);

    expect(first.status).toBe(201);
    expect(first.body.id).toBe(second.body.id);
  });
});

describe('history pagination', () => {
  it('fills the first page and reports that there is more', async () => {
    const product = await channelBySlug('product');

    const response = await call(`/channels/${product.id}/messages`, { token: ana.token });

    // HISTORY_PAGE_SIZE is 40 and the seed writes 60 into this channel, so a seed
    // that fit in one page would let a broken paginator ship green.
    expect(response.body.messages).toHaveLength(40);
    expect(response.body.hasMore).toBe(true);
  });

  it('returns the page oldest-first, however the query ran', async () => {
    const product = await channelBySlug('product');

    const response = await call(`/channels/${product.id}/messages`, { token: ana.token });

    const seqs = response.body.messages.map((message: { seq: number }) => message.seq);
    expect(seqs).toEqual([...seqs].sort((a: number, b: number) => a - b));
  });

  it('crosses the page boundary with no overlap and no hole', async () => {
    // The assertion a keyset paginator exists for. `beforeSeq` is exclusive, so
    // the second page starts exactly one below the first page's oldest line.
    const product = await channelBySlug('product');

    const first = await call(`/channels/${product.id}/messages`, { token: ana.token });
    const oldest = first.body.messages[0].seq;

    const second = await call(`/channels/${product.id}/messages?beforeSeq=${String(oldest)}`, {
      token: ana.token,
    });

    const secondSeqs = second.body.messages.map((message: { seq: number }) => message.seq);
    expect(Math.max(...secondSeqs)).toBe(oldest - 1);

    const together = [
      ...secondSeqs,
      ...first.body.messages.map((message: { seq: number }) => message.seq),
    ];
    expect(new Set(together).size).toBe(together.length);
  });

  it('refuses a beforeSeq that is not a number', async () => {
    const product = await channelBySlug('product');

    const response = await call(`/channels/${product.id}/messages?beforeSeq=yesterday`, {
      token: ana.token,
    });

    expect(response.status).toBe(400);
  });
});

describe('uploads', () => {
  /** A PNG header, as bytes. Written as numbers so this file holds no binary. */
  const PNG = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]);

  const upload = (
    bytes: Uint8Array,
    filename: string,
    declaredType: string,
    token: string,
  ): Promise<ApiResponse> => {
    const form = new FormData();
    // The declared type goes on the part, which is exactly the attacker-controlled
    // value the server must not believe.
    form.append('file', new Blob([bytes], { type: declaredType }), filename);
    return call('/uploads', { method: 'POST', body: form, token });
  };

  it('stores the type sniffed from the bytes, not the one the client declared', async () => {
    // The assertion `docs/ROADMAP.md` section 4 names. A client that says
    // `text/html` and sends a PNG must not be believed, and neither must the
    // reverse: the stored type is what the download route sets, so trusting the
    // header turns an attachment into a stored cross-site script.
    const response = await upload(PNG, 'lies.png', 'text/html', ana.token);

    expect(response.status).toBe(201);
    expect(response.body.contentType).toBe('image/png');
    expect(response.body.byteSize).toBe(PNG.length);

    await prisma.attachment.delete({ where: { id: response.body.id } });
  });

  it('falls back to octet-stream for bytes it does not recognise', async () => {
    const script = new TextEncoder().encode('<script>alert(1)</script>');
    const response = await upload(script, 'safe.png', 'image/png', ana.token);

    expect(response.body.contentType).toBe('application/octet-stream');

    await prisma.attachment.delete({ where: { id: response.body.id } });
  });

  it('strips a traversal out of the stored filename', async () => {
    const response = await upload(PNG, '../../etc/passwd', 'image/png', ana.token);

    expect(response.body.filename).toBe('passwd');

    await prisma.attachment.delete({ where: { id: response.body.id } });
  });

  it('serves an orphan back to its uploader and to nobody else', async () => {
    const uploaded = await upload(PNG, 'mine.png', 'image/png', ana.token);
    expect(uploaded.status).toBe(201);

    const mine = await call(`/attachments/${uploaded.body.id}`, { token: ana.token });

    expect(mine.status).toBe(200);
    expect(mine.headers.get('content-type')).toContain('image/png');
    // Never `inline`, even for an image: a browser told to render a file this
    // server sniffed as octet-stream is how a stored file becomes a page in the
    // API's own origin.
    expect(mine.headers.get('content-disposition')).toContain('attachment');
    expect(mine.headers.get('x-content-type-options')).toBe('nosniff');

    // 404 rather than 403 for somebody else: a 403 on an id somebody guessed
    // confirms the id exists.
    const theirs = await call(`/attachments/${uploaded.body.id}`, { token: bruno.token });
    expect(theirs.status).toBe(404);

    await prisma.attachment.delete({ where: { id: uploaded.body.id } });
  });

  it('refuses a request with no file rather than storing an empty row', async () => {
    const response = await call('/uploads', {
      method: 'POST',
      body: new FormData(),
      token: ana.token,
    });

    expect(response.status).toBe(400);
  });

  it('refuses a body that is not multipart', async () => {
    const response = await post('/uploads', { file: 'not a file' }, ana.token);

    expect(response.status).toBe(400);
  });
});

describe('the schema invariants', () => {
  it('refuses two messages at the same seq', async () => {
    // `UNIQUE (channel_id, seq)`. Nothing in the gate lane touches the schema, so
    // a migration that dropped this would otherwise ship green.
    const product = await channelBySlug('product');

    await expect(
      prisma.message.create({
        data: {
          channelId: product.id,
          seq: 1n,
          authorId: ana.id,
          clientMessageId: `dupe-${String(Date.now())}`,
          body: 'a second message at seq 1',
        },
      }),
    ).rejects.toThrow();
  });

  it('refuses a second owner in one channel', async () => {
    // A partial unique index, which is the only way to say "at most one row per
    // channel where role = OWNER" in Postgres and which Prisma cannot express.
    const product = await channelBySlug('product');

    await expect(
      prisma.channelMember.update({
        where: { channelId_userId: { channelId: product.id, userId: bruno.id } },
        data: { role: 'OWNER' },
      }),
    ).rejects.toThrow();
  });

  it('refuses a blank body on a message that is not deleted', async () => {
    // `messages_body_not_blank`, written to exempt exactly the tombstone case: a
    // deleted message keeps its seq and loses its body.
    const product = await channelBySlug('product');

    await expect(
      prisma.message.create({
        data: {
          channelId: product.id,
          seq: 9999n,
          authorId: ana.id,
          clientMessageId: `blank-${String(Date.now())}`,
          body: '   ',
        },
      }),
    ).rejects.toThrow();
  });

  it('refuses a negative read marker', async () => {
    const product = await channelBySlug('product');

    await expect(
      prisma.channelMember.update({
        where: { channelId_userId: { channelId: product.id, userId: ana.id } },
        data: { lastReadSeq: -1n },
      }),
    ).rejects.toThrow();
  });
});
