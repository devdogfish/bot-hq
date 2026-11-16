import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from './env.js';

export const libraryRoot = (botId: string) => path.join(env.libraryDir, botId);

export async function libraryPath(botId: string, relative: string): Promise<string> {
  const base = await fs.realpath(env.libraryDir);
  const root = await fs.realpath(libraryRoot(botId));
  if (path.dirname(root) !== base || path.basename(root) !== botId) throw new Error('Invalid Library directory');
  const target = await fs.realpath(path.join(root, relative));
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error('Outside the Library');
  return target;
}

export async function writeLibraryFile(botId: string, filename: string, contents: string) {
  await fs.mkdir(libraryRoot(botId), { recursive: true, mode: 0o700 });
  const root = await libraryPath(botId, '');
  const file = path.join(root, filename);
  const handle = await fs.open(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_TRUNC, 0o600);
  try { await handle.writeFile(contents); }
  finally { await handle.close(); }
}
