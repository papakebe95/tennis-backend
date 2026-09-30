import { describe, expect, it, vi } from 'vitest';
import { MediaService } from './media.service.js';

const PUBLIC = 'https://media.example.com';
const ours = (folder: string, n: number) => `${PUBLIC}/${folder}/00000000-0000-4000-8000-00000000000${n}.jpg`;

function setup() {
  const uploads = {
    keyOf: (url: string | null | undefined) =>
      url && url.startsWith(`${PUBLIC}/`) && /\/[0-9a-f-]{36}\.jpg$/.test(url) ? url.slice(PUBLIC.length + 1) : null,
    remove: vi.fn(async () => undefined),
  };
  return { media: new MediaService(uploads as never), uploads };
}

describe('MediaService', () => {
  it('accepts our uploads and images already on the record', () => {
    const { media } = setup();
    const seeded = 'https://images.unsplash.com/photo-1';
    expect(() => media.assertOwn([seeded], [seeded, ours('clubs', 1)])).not.toThrow();
    expect(() => media.assertOwn(null, null)).not.toThrow();
  });

  it('refuses a new image linked from elsewhere', () => {
    const { media } = setup();
    expect(() => media.assertOwn([], ['https://evil.example/x.jpg'])).toThrow();
    expect(() => media.assertOwn(ours('clubs', 1), `${PUBLIC}/../secrets.txt`)).toThrow();
  });

  it('deletes only our images the change dropped', async () => {
    const { media, uploads } = setup();
    const seeded = 'https://images.unsplash.com/photo-1';
    await media.release([ours('clubs', 1), ours('clubs', 2), seeded], [ours('clubs', 2)]);
    expect(uploads.remove).toHaveBeenCalledWith(['clubs/00000000-0000-4000-8000-000000000001.jpg']);
  });

  it('deletes nothing when nothing changed', async () => {
    const { media, uploads } = setup();
    await media.release(ours('avatars', 3), ours('avatars', 3));
    expect(uploads.remove).toHaveBeenCalledWith([]);
  });
});
