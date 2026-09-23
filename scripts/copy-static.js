import { cp, copyFile, mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await cp('public/media', 'dist/media', { recursive: true });
await copyFile('public/tracks.json', 'dist/tracks.json');
