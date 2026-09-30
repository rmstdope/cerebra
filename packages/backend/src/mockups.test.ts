import { mockupEscapeMessage } from '@cerebra/shared';
import type { Kysely } from 'kysely';
import { describe, expect, test } from 'vitest';

import type { Database } from './database.js';
import {
  createMockupStore,
  drawingContentProblem,
  drawingTypeOf,
  MockupError,
  mockupContentSecurityPolicy,
  mockupDocument,
} from './mockups.js';
import { registerTestProject, withTestDatabase } from './test-support.js';

async function itemAndRun(
  database: Kysely<Database>,
): Promise<{ itemId: string; runId: string }> {
  const projectId = await registerTestProject(database);
  const itemId = crypto.randomUUID();
  await database
    .insertInto('work_items')
    .values({
      attempts: 0,
      description: '',
      id: itemId,
      priority: 'P1',
      project_id: projectId,
      rounds: 0,
      state: 'design_ready',
      title: 'Export invoices as CSV',
    })
    .execute();
  const runId = crypto.randomUUID();
  await database
    .insertInto('runs')
    .values({
      agent_name: 'Iris',
      id: runId,
      project_id: projectId,
      role: 'designer',
      status: 'active',
      work_item_id: itemId,
    })
    .execute();
  return { itemId, runId };
}

describe('what counts as a drawing', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]);
  const gif = Buffer.from('GIF89a\0\0');
  const webp = Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.from([1, 0, 0, 0]),
    Buffer.from('WEBPVP8 '),
  ]);

  test("names a drawing's type by its extension", () => {
    expect(drawingTypeOf('mockups/a.html')).toBe('text/html');
    expect(drawingTypeOf('mockups/A.HTM')).toBe('text/html');
    expect(drawingTypeOf('a.png')).toBe('image/png');
    expect(drawingTypeOf('a.jpg')).toBe('image/jpeg');
    expect(drawingTypeOf('a.jpeg')).toBe('image/jpeg');
    expect(drawingTypeOf('a.gif')).toBe('image/gif');
    expect(drawingTypeOf('a.webp')).toBe('image/webp');
    expect(drawingTypeOf('a.svg')).toBe('image/svg+xml');
    expect(drawingTypeOf('notes.txt')).toBeNull();
    expect(drawingTypeOf('script.js')).toBeNull();
    expect(drawingTypeOf('html')).toBeNull();
  });

  test('accepts real HTML, SVG and images', () => {
    expect(
      drawingContentProblem(
        'a.html',
        'text/html',
        Buffer.from('<!doctype html><p>Export – CSV</p>'),
      ),
    ).toBeNull();
    expect(
      drawingContentProblem(
        'a.svg',
        'image/svg+xml',
        Buffer.from('<?xml version="1.0"?><svg xmlns="x"></svg>'),
      ),
    ).toBeNull();
    expect(drawingContentProblem('a.png', 'image/png', png)).toBeNull();
    expect(drawingContentProblem('a.jpg', 'image/jpeg', jpeg)).toBeNull();
    expect(drawingContentProblem('a.gif', 'image/gif', gif)).toBeNull();
    expect(drawingContentProblem('a.webp', 'image/webp', webp)).toBeNull();
  });

  test('refuses bytes that are not what the name says', () => {
    expect(drawingContentProblem('a.png', 'image/png', jpeg)).toBe(
      'a.png is not a PNG image.',
    );
    expect(drawingContentProblem('b.jpg', 'image/jpeg', png)).toBe(
      'b.jpg is not a JPEG image.',
    );
    expect(drawingContentProblem('c.gif', 'image/gif', png)).toBe(
      'c.gif is not a GIF image.',
    );
    expect(drawingContentProblem('d.webp', 'image/webp', png)).toBe(
      'd.webp is not a WebP image.',
    );
    expect(
      drawingContentProblem('e.svg', 'image/svg+xml', Buffer.from('<p>hi</p>')),
    ).toBe('e.svg is not an SVG image.');
    expect(drawingContentProblem('f.html', 'text/html', png)).toBe(
      'f.html is not a web page: it is not UTF-8 text.',
    );
    expect(drawingContentProblem('g.html', 'text/html', Buffer.alloc(0))).toBe(
      'g.html is empty.',
    );
  });
});

describe('the mockup store', () => {
  test('keeps a drawing with its item and finds it by id', async () => {
    await withTestDatabase(async (database) => {
      const { itemId, runId } = await itemAndRun(database);
      const mockups = createMockupStore(database);
      const content = new TextEncoder().encode('<p>A</p>');

      const id = await mockups.save({
        content,
        contentType: 'text/html',
        path: 'drawings/a.html',
        runId,
        workItemId: itemId,
      });

      const found = await mockups.find(id);
      expect(found?.contentType).toBe('text/html');
      expect(Buffer.from(found!.content).toString()).toBe('<p>A</p>');
    });
  });

  test('finds nothing for an unknown or malformed id', async () => {
    await withTestDatabase(async (database) => {
      const mockups = createMockupStore(database);
      expect(await mockups.find(crypto.randomUUID())).toBeNull();
      expect(await mockups.find('not-an-id')).toBeNull();
      expect(await mockups.find("'; drop table mockups; --")).toBeNull();
    });
  });

  test('refuses a file that is neither a web page nor an image', async () => {
    await withTestDatabase(async (database) => {
      const { itemId, runId } = await itemAndRun(database);
      const mockups = createMockupStore(database);

      const saving = mockups.save({
        content: new Uint8Array([1, 2, 3]),
        contentType: 'application/javascript',
        path: 'drawings/a.js',
        runId,
        workItemId: itemId,
      });

      await expect(saving).rejects.toBeInstanceOf(MockupError);
      expect(
        await database.selectFrom('mockups').select('id').execute(),
      ).toEqual([]);
    });
  });

  test("an item's drawings go with it", async () => {
    await withTestDatabase(async (database) => {
      const { itemId, runId } = await itemAndRun(database);
      const mockups = createMockupStore(database);
      const id = await mockups.save({
        content: new Uint8Array([137, 80, 78, 71]),
        contentType: 'image/png',
        path: 'a.png',
        runId,
        workItemId: itemId,
      });

      await database.deleteFrom('runs').where('id', '=', runId).execute();
      await database
        .deleteFrom('work_items')
        .where('id', '=', itemId)
        .execute();

      expect(await mockups.find(id)).toBeNull();
    });
  });
});

describe('a served drawing', () => {
  const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8');

  test('a web page is served as written, with the Escape forward after it', () => {
    const page = '<!doctype html><html><body><p>A</p></body></html>';

    const served = text(
      mockupDocument({
        content: Buffer.from(page),
        contentType: 'text/html',
      }),
    );

    expect(served.startsWith(page)).toBe(true);
    const script = served.slice(page.length);
    expect(script).toMatch(/^<script>.*<\/script>$/s);
    expect(script).toContain('Escape');
    expect(script).toContain(JSON.stringify(mockupEscapeMessage));
  });

  test('an image is wrapped in a page that holds it inline', () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

    const served = text(
      mockupDocument({ content: png, contentType: 'image/png' }),
    );

    expect(served.startsWith('<!doctype html>')).toBe(true);
    expect(served).toContain(
      `<img alt="" src="data:image/png;base64,${png.toString('base64')}">`,
    );
    expect(served).toContain(JSON.stringify(mockupEscapeMessage));
  });

  test('an SVG is shown as an image, never run as a document', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>';

    const served = text(
      mockupDocument({
        content: Buffer.from(svg),
        contentType: 'image/svg+xml',
      }),
    );

    expect(served).not.toContain('<svg');
    expect(served).toContain(
      `src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"`,
    );
  });

  test('the policy lets scripts run but gives them no origin and no network', () => {
    const directives = new Map(
      mockupContentSecurityPolicy.split(';').map((directive) => {
        const [name = '', ...values] = directive.trim().split(/\s+/);
        return [name, values] as const;
      }),
    );

    expect(directives.get('sandbox')).toEqual(['allow-scripts']);
    expect(directives.get('default-src')).toEqual(["'none'"]);
    expect(directives.get('connect-src')).toEqual(["'none'"]);
    expect(directives.get('form-action')).toEqual(["'none'"]);
    expect(directives.get('base-uri')).toEqual(["'none'"]);
    // Nothing outside the document itself: no scheme, host or 'self' source anywhere.
    const sources = [...directives.values()].flat();
    expect(
      sources.filter((source) => /^(https?:|\*|'self'|ws)/.test(source)),
    ).toEqual([]);
  });
});
