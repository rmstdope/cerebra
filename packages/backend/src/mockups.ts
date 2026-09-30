import { mockupEscapeMessage } from '@cerebra/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';

import type { Database } from './database.js';

/** What a drawing may be: a web page or an image (spec §6.4). */
export const mockupContentTypes = [
  'text/html',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
] as const;

export type MockupContentType = (typeof mockupContentTypes)[number];

export interface Mockup {
  readonly contentType: MockupContentType;
  readonly content: Buffer;
}

export class MockupError extends Error {
  constructor(
    readonly code: 'unsupported_type',
    message: string,
  ) {
    super(message);
    this.name = 'MockupError';
  }
}

/** A designer's drawings, kept with their item and found by an unguessable id. */
export interface MockupStore {
  save(input: {
    readonly workItemId: string;
    readonly runId: string;
    readonly path: string;
    readonly contentType: string;
    readonly content: Uint8Array;
  }): Promise<string>;
  find(id: string): Promise<Mockup | null>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isMockupContentType(type: string): type is MockupContentType {
  return (mockupContentTypes as readonly string[]).includes(type);
}

const drawingExtensions: Readonly<Record<string, MockupContentType>> = {
  gif: 'image/gif',
  htm: 'text/html',
  html: 'text/html',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
};

/** What a file in a designer's checkout is shown as, by its name; null when it is not a drawing. */
export function drawingTypeOf(path: string): MockupContentType | null {
  const extension = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase();
  return extension === undefined
    ? null
    : (drawingExtensions[extension] ?? null);
}

function startsWith(content: Uint8Array, ...bytes: number[]): boolean {
  return bytes.every((byte, index) => content[index] === byte);
}

function utf8(content: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return null;
  }
}

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

/**
 * Why a fetched file is not the drawing its name says, or null when it is. The runner's own
 * content type is not trusted; the bytes are checked against the name.
 */
export function drawingContentProblem(
  path: string,
  type: MockupContentType,
  content: Uint8Array,
): string | null {
  if (content.length === 0) return `${path} is empty.`;
  switch (type) {
    case 'text/html':
      return utf8(content) === null
        ? `${path} is not a web page: it is not UTF-8 text.`
        : null;
    case 'image/svg+xml': {
      const text = utf8(content);
      return text === null || !text.includes('<svg')
        ? `${path} is not an SVG image.`
        : null;
    }
    case 'image/png':
      return startsWith(content, 0x89, ...ascii('PNG\r\n'), 0x1a, 0x0a)
        ? null
        : `${path} is not a PNG image.`;
    case 'image/jpeg':
      return startsWith(content, 0xff, 0xd8, 0xff)
        ? null
        : `${path} is not a JPEG image.`;
    case 'image/gif':
      return startsWith(content, ...ascii('GIF87a')) ||
        startsWith(content, ...ascii('GIF89a'))
        ? null
        : `${path} is not a GIF image.`;
    case 'image/webp':
      return startsWith(content, ...ascii('RIFF')) &&
        startsWith(content.subarray(8), ...ascii('WEBP'))
        ? null
        : `${path} is not a WebP image.`;
  }
}

export function createMockupStore(database: Kysely<Database>): MockupStore {
  return {
    async save({ content, contentType, path, runId, workItemId }) {
      if (!isMockupContentType(contentType)) {
        throw new MockupError(
          'unsupported_type',
          'A drawing is a web page or an image.',
        );
      }
      const id = crypto.randomUUID();
      await database
        .insertInto('mockups')
        .values({
          content: Buffer.from(content),
          content_type: contentType,
          id,
          path,
          run_id: runId,
          work_item_id: workItemId,
        })
        .execute();
      return id;
    },

    async find(id) {
      // Checked here, so a malformed id never reaches Postgres as a failing uuid cast.
      if (!uuid.test(id)) return null;
      const row = await database
        .selectFrom('mockups')
        .select(['content', 'content_type'])
        .where('id', '=', id)
        .executeTakeFirst();
      if (row === undefined || !isMockupContentType(row.content_type)) {
        return null;
      }
      return { content: row.content, contentType: row.content_type };
    },
  };
}

/**
 * Served with every drawing (architecture §11): its scripts run, but in an opaque origin of their
 * own — no cookies, storage or parent page — and nothing outside the document loads.
 */
export const mockupContentSecurityPolicy = [
  'sandbox allow-scripts',
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

// Keys pressed inside the frame never reach the page, so the dialog hears Escape by message.
const escapeForward = `<script>addEventListener('keydown',function(e){if(e.key==='Escape')parent.postMessage(${JSON.stringify(mockupEscapeMessage)},'*')},true)</script>`;

/**
 * The document a drawing is served as. A web page is kept as written, the script appended after
 * it so a doctype stays first; an image is held inline in a page of its own, so an SVG is only
 * ever an image and nothing is fetched.
 */
export function mockupDocument(mockup: Mockup): Buffer {
  if (mockup.contentType === 'text/html') {
    return Buffer.concat([mockup.content, Buffer.from(escapeForward)]);
  }
  const source = `data:${mockup.contentType};base64,${mockup.content.toString('base64')}`;
  return Buffer.from(
    '<!doctype html><meta charset="utf-8">' +
      '<style>html,body{margin:0;height:100%;background:#fff}body{display:grid;place-items:center}img{max-width:100%;max-height:100%}</style>' +
      `<img alt="" src="${source}">` +
      escapeForward,
  );
}

/** The origin drawings are served from: the second listener's address. */
export function mockupOrigin(address: string): string {
  return new URL(address).origin;
}

const servedHeaders = {
  'cache-control': 'no-store',
  'content-security-policy': mockupContentSecurityPolicy,
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

/**
 * The second listener, on a port of its own so drawings have an origin of their own
 * (architecture §11). It serves drawings by id and nothing else; it reads no cookie.
 */
export function createMockupServer({
  mockups,
}: {
  readonly mockups: Pick<MockupStore, 'find'>;
}): FastifyInstance {
  const server = Fastify();

  server.addHook('onSend', async (_request, reply) => {
    reply.headers(servedHeaders);
  });

  server.get<{ Params: { id: string } }>(
    '/mockups/:id',
    async (request, reply) => {
      const mockup = await mockups.find(request.params.id);
      if (mockup === null) {
        return reply
          .status(404)
          .type('text/plain; charset=utf-8')
          .send('This drawing couldn’t be shown.');
      }
      return reply
        .type('text/html; charset=utf-8')
        .send(mockupDocument(mockup));
    },
  );

  return server;
}
