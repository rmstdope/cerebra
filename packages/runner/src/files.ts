import { open, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, normalize, sep } from 'node:path';

import type { RunFile } from '@cerebra/shared';

export type CheckoutFilesAnswer =
  { readonly files: readonly RunFile[] } | { readonly error: string };

const contentTypes: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.md': 'text/markdown; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
};

export function contentTypeFor(path: string): string {
  return (
    contentTypes[extname(path).toLowerCase()] ?? 'application/octet-stream'
  );
}

function sizeText(bytes: number): string {
  const mebibyte = 1024 * 1024;
  return bytes % mebibyte === 0 ? `${bytes / mebibyte} MiB` : `${bytes} bytes`;
}

class Refusal extends Error {}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Where `path` really is, refusing anything that is not a regular file inside `root`. */
async function locate(root: string, path: string): Promise<string> {
  if (path === '') throw new Refusal('An empty path names no file.');
  if (path.includes('\u0000')) {
    throw new Refusal('A path may not contain a NUL character.');
  }
  const outside = `The path ${path} is outside the checkout.`;
  const relative = normalize(path);
  if (
    isAbsolute(path) ||
    relative === '..' ||
    relative.startsWith(`..${sep}`)
  ) {
    throw new Refusal(outside);
  }
  let real: string;
  try {
    real = await realpath(join(root, relative));
  } catch (error) {
    if (isMissing(error)) {
      throw new Refusal(`There is no file ${path} in the checkout.`);
    }
    throw error;
  }
  if (real !== root && !real.startsWith(`${root}${sep}`)) {
    throw new Refusal(outside);
  }
  if (!(await stat(real)).isFile()) {
    throw new Refusal(`The path ${path} is not a file.`);
  }
  return real;
}

/**
 * Reads named files of the checkout for the backend (architecture §5.2): all of them, or none
 * with the reason. Symlinks are followed only while they stay inside the checkout.
 */
export async function readCheckoutFiles(
  checkout: string,
  paths: readonly string[],
  limitBytes: number,
): Promise<CheckoutFilesAnswer> {
  const tooLarge = `The files asked for come to more than ${sizeText(limitBytes)}.`;
  try {
    const root = await realpath(checkout);
    const located: string[] = [];
    let total = 0;
    for (const path of paths) {
      const real = await locate(root, path);
      total += (await stat(real)).size;
      if (total > limitBytes) throw new Refusal(tooLarge);
      located.push(real);
    }
    const files: RunFile[] = [];
    let read = 0;
    for (const [index, real] of located.entries()) {
      const handle = await open(real, 'r');
      let bytes: Buffer;
      try {
        // Read one byte past what is left, so a file that grew is noticed rather than cut.
        const room = limitBytes - read;
        const buffer = Buffer.alloc(room + 1);
        const { bytesRead } = await handle.read(buffer, 0, room + 1, 0);
        if (bytesRead > room) throw new Refusal(tooLarge);
        bytes = buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
      read += bytes.length;
      const path = paths[index] as string;
      files.push({
        content: bytes.toString('base64'),
        contentType: contentTypeFor(path),
        path,
      });
    }
    return { files };
  } catch (error) {
    if (error instanceof Refusal) return { error: error.message };
    return {
      error: `The files could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
