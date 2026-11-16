import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Files pasted or dropped into a chat: images, and plain-text files (logs, code, notes, Pine Script…).
 * Stored as <uuid>__<original-name>.<ext>, so names can't reach other files but still read nicely.
 * Images are checked by their first bytes; text must be valid UTF-8 with no binary content.
 * Everything is served back as an image or as plain text, never as HTML/script.
 */

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
/** Upload size the server accepts at all (the per-kind limits above apply after). */
export const MAX_ATTACHMENT_BYTES = MAX_IMAGE_BYTES;

const IMAGES: { ext: string; mime: string; test: (b: Buffer) => boolean }[] = [
  { ext: 'png', mime: 'image/png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'jpg', mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'gif', mime: 'image/gif', test: (b) => b.subarray(0, 4).toString('ascii') === 'GIF8' },
  { ext: 'webp', mime: 'image/webp', test: (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP' },
];

/** Text extensions accepted (keep in sync with TEXT_EXTS in web/app.js). */
export const TEXT_EXTS = [
  'txt', 'md', 'log', 'json', 'jsonl', 'csv', 'tsv', 'yaml', 'yml', 'toml', 'ini', 'xml', 'html', 'css', 'scss',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs',
  'swift', 'php', 'sh', 'bash', 'zsh', 'ps1', 'sql', 'diff', 'patch', 'pine',
];

const EXTS = [...IMAGES.map((i) => i.ext), ...TEXT_EXTS];
const NAME_RE = new RegExp(`^[0-9a-f-]{36}(?:__[A-Za-z0-9._-]{1,80})?\\.(${EXTS.join('|')})$`);

export function isAttachmentName(name: unknown): name is string {
  return typeof name === 'string' && NAME_RE.test(name);
}

export function isImage(name: string): boolean {
  return IMAGES.some((i) => name.endsWith('.' + i.ext));
}

export function mimeOf(name: string): string {
  // Text (including .html/.js) is always served as plain text so the browser never runs it.
  return IMAGES.find((i) => name.endsWith('.' + i.ext))?.mime ?? 'text/plain; charset=utf-8';
}

/** The name to show in the chat: the original file name, or "image.png" for pasted screenshots. */
export function displayName(name: string): string {
  const m = name.match(/^[0-9a-f-]{36}(?:__(.+))?\.([a-z0-9]+)$/);
  return m ? `${m[1] ?? (isImage(name) ? 'image' : 'file')}.${m[2]}` : name;
}

function extOf(filename: string): string {
  return filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
}

function looksLikeText(data: Buffer): boolean {
  if (data.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data);
    return true;
  } catch {
    return false;
  }
}

/** Save an uploaded file into `dir`; returns its new file name. Throws with a readable reason if refused. */
export function saveAttachment(dir: string, data: Buffer, originalName = ''): string {
  if (!data.length) throw new Error('The file is empty.');
  const image = IMAGES.find((s) => s.test(data));
  let ext: string;
  if (image) {
    if (data.length > MAX_IMAGE_BYTES) throw new Error('Images can be up to 10 MB.');
    ext = image.ext;
  } else {
    ext = extOf(originalName);
    if (!TEXT_EXTS.includes(ext)) {
      throw new Error(`Only images (PNG, JPG, GIF, WebP) and text files (${TEXT_EXTS.map((e) => '.' + e).join(' ')}) can be attached.`);
    }
    if (data.length > MAX_TEXT_BYTES) throw new Error('Text files can be up to 2 MB.');
    if (!looksLikeText(data)) throw new Error(`That ".${ext}" file isn't plain text, so it can't be attached.`);
  }
  const base = originalName
    .replace(/\.[^.]*$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  const name = `${randomUUID()}${base ? `__${base}` : ''}.${ext}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), data);
  return name;
}

/** Keep only well-formed names that actually exist in `dir` (anything else from the browser is dropped). */
export function validAttachments(dir: string | undefined, names: unknown): string[] {
  if (!dir || !Array.isArray(names)) return [];
  return names.filter(isAttachmentName).filter((n) => existsSync(join(dir, n))).slice(0, 10);
}

/**
 * How attached files are described to an agent: paths, plus what to do with them.
 * Images need opening with an image-capable tool; text files are just read.
 */
export function describeAttachments(dir: string, names: string[]): string {
  if (!names.length) return '';
  const images = names.filter(isImage).map((n) => join(dir, n));
  const files = names.filter((n) => !isImage(n)).map((n) => join(dir, n));
  return [
    images.length ? `[attached image${images.length > 1 ? 's' : ''}: ${images.join(', ')}]` : '',
    files.length ? `[attached file${files.length > 1 ? 's' : ''}: ${files.join(', ')}]` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export const ATTACHMENT_NOTE =
  'The paths above are files the user attached (images and/or text files). Open each one and look at it before answering.';
