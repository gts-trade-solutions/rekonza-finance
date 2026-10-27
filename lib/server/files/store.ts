import 'server-only';

// Where an attachment's bytes live.
//
// The database holds the index (files table) and never the bytes, so a backup
// stays small enough to restore quickly. The store is an interface because the
// disk on this server is the stand-in: a hosted deployment swaps in object
// storage in an Indian region without anything above this file changing.

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface FileStore {
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

/** Files under one directory, keyed by a relative path. */
export class DiskStore implements FileStore {
  constructor(private readonly root: string) {}

  private resolve(key: string) {
    // Keys are made by this app, but a key is still never allowed out of the root.
    const full = path.resolve(this.root, key);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) throw new Error('Bad storage key.');
    return full;
  }

  async put(key: string, bytes: Buffer) {
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    // Written beside and renamed, so a crash never leaves half a file under the real name.
    const tmp = `${full}.part`;
    await writeFile(tmp, bytes, { flag: 'wx' });
    await rename(tmp, full);
  }

  async get(key: string) {
    return readFile(this.resolve(key));
  }

  async remove(key: string) {
    await unlink(this.resolve(key)).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
    });
  }
}

/**
 * Files in Vercel Blob, private: read only with the store's own token, never
 * by a link alone. Used wherever the platform's disk does not last (Vercel),
 * chosen by BLOB_READ_WRITE_TOKEN being set. Create the store in Mumbai, so
 * the books stay in India.
 */
export class BlobStore implements FileStore {
  async put(key: string, bytes: Buffer) {
    const { put } = await import('@vercel/blob');
    await put(key, bytes, { access: 'private', addRandomSuffix: false, contentType: 'application/octet-stream' });
  }

  async get(key: string) {
    const { get } = await import('@vercel/blob');
    const found = await get(key, { access: 'private', useCache: false });
    if (!found || found.statusCode !== 200) throw new Error('That file is no longer in storage.');
    return Buffer.from(await new Response(found.stream).arrayBuffer());
  }

  async remove(key: string) {
    const { del } = await import('@vercel/blob');
    await del(key);
  }
}

let store: FileStore | null = null;

export function fileStore(): FileStore {
  store ??= process.env.BLOB_READ_WRITE_TOKEN
    ? new BlobStore()
    : new DiskStore(process.env.FILE_STORAGE_DIR || path.join(process.cwd(), 'storage', 'files'));
  return store;
}

/** For tests: put the bytes somewhere disposable. */
export function setFileStore(s: FileStore) {
  store = s;
}
