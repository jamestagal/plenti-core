// Dependency-free tests for the standalone upload queue state machine
// (defaults/core/cms/upload_queue.js). Run: node scripts/test-upload-queue.mjs (or deno run -A).

import { readFile } from 'node:fs/promises';

let pass = 0, fail = 0;
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? (console.log(`  PASS  ${n}`), pass++) : (console.log(`  FAIL  ${n}\n        got ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`), fail++));
const ok = (n, v, d) => (v ? (console.log(`  PASS  ${n}`), pass++) : (console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`), fail++));

// Read the module BEFORE we stub URL (readFile needs the real URL constructor).
const src = await readFile(new URL('../defaults/core/cms/upload_queue.js', import.meta.url), 'utf8');

// URL.revokeObjectURL must exist for the module's revoke(); track calls.
// Augment the real URL (keep it a constructor) rather than replacing it.
let revoked = [];
URL.revokeObjectURL = (u) => revoked.push(u);
const { classifyFile, createUploadQueue } = await import('data:text/javascript,' + encodeURIComponent(src));

const F = (name, type) => ({ name, type: type ?? '' });
let urlSeq = 0;
const makeUrl = () => `blob:${++urlSeq}`;

console.log('=== classifyFile (MIME first, extension fallback) ===');
eq('jpeg mime -> image', classifyFile(F('x', 'image/jpeg')), 'image');
eq('png/webp/avif -> image', [classifyFile(F('a', 'image/png')), classifyFile(F('b', 'image/webp')), classifyFile(F('c', 'image/avif'))], ['image', 'image', 'image']);
eq('pdf -> passthrough', classifyFile(F('x.pdf', 'application/pdf')), 'passthrough');
eq('svg -> passthrough', classifyFile(F('x.svg', 'image/svg+xml')), 'passthrough');
eq('gif -> passthrough', classifyFile(F('x.gif', 'image/gif')), 'passthrough');
eq('pdf named .jpg (real MIME wins) -> passthrough', classifyFile(F('trick.jpg', 'application/pdf')), 'passthrough');
eq('empty MIME, .jpg ext -> image', classifyFile(F('photo.jpg', '')), 'image');
eq('octet-stream, .png ext -> image', classifyFile(F('photo.png', 'application/octet-stream')), 'image');
eq('empty MIME, .pdf ext -> passthrough', classifyFile(F('doc.pdf', '')), 'passthrough');

console.log('=== queue order + classification ===');
let q = createUploadQueue([F('a.jpg', 'image/jpeg'), F('b.pdf', 'application/pdf'), F('c.png', 'image/png')], makeUrl);
eq('deterministic order preserved', q.items.map(i => i.file.name), ['a.jpg', 'b.pdf', 'c.png']);
eq('types classified', q.items.map(i => i.type), ['image', 'passthrough', 'image']);
eq('all start queued', q.items.every(i => i.state === 'queued'), true);
ok('current is first item', q.current === q.items[0]);

console.log('=== canSave gating (unresolved blocks) ===');
ok('canSave false at start (nothing resolved)', q.canSave === false);
// resolve first
q.resolve(q.items[0], { file: 'media/a-hash-100x100.webp' });
ok('canSave still false (others unresolved)', q.canSave === false);
ok('unresolvedCount = 2', q.unresolvedCount === 2);
// resolve the rest
q.resolve(q.items[1], { file: 'media/b.pdf' });
q.resolve(q.items[2], { file: 'media/c-hash-50x50.webp' });
ok('canSave true when all resolved', q.canSave === true);
eq('resolvedItems in order', q.resolvedItems().map(r => r.file), ['media/a-hash-100x100.webp', 'media/b.pdf', 'media/c-hash-50x50.webp']);
ok('done (no current)', q.done === true);

console.log('=== object-URL lifecycle + idempotent revoke ===');
revoked = [];
q = createUploadQueue([F('a.jpg', 'image/jpeg')], makeUrl);
const it = q.prepare(q.current);          // creates objectUrl
ok('prepare set objectUrl', !!it.objectUrl && it.state === 'preparing');
q.resolve(it, { file: 'media/a.webp' });   // resolve revokes
ok('resolve revoked the url', revoked.length === 1 && it.objectUrl === null);
q.destroy();                               // idempotent — already null, no throw/extra
ok('destroy idempotent (no double revoke of a cleared url)', revoked.length === 1);

console.log('=== cancellation: late result ignored ===');
q = createUploadQueue([F('a.jpg', 'image/jpeg')], makeUrl);
const item = q.prepare(q.current); q.process(item);
q.cancelCurrent(item);                     // user cancels mid-processing
ok('item marked cancelled', item.state === 'cancelled');
const inserted = q.resolve(item, { file: 'media/a.webp' }); // a LATE result arrives
ok('late resolve on a cancelled item is REJECTED', inserted === false);
ok('cancelled item did NOT become resolved', item.state === 'cancelled' && item.result === null);
ok('canSave false (nothing resolved, item cancelled)', q.canSave === false);

console.log('=== cancelAll clears everything ===');
revoked = [];
q = createUploadQueue([F('a.jpg', 'image/jpeg'), F('b.png', 'image/png'), F('c.pdf', 'application/pdf')], makeUrl);
q.prepare(q.items[0]); q.prepare(q.items[1]); // give two of them urls
q.cancelAll();
ok('all non-saved -> cancelled', q.items.every(i => i.state === 'cancelled'));
ok('every url revoked', revoked.length === 2);
ok('current is null after cancelAll', q.current === null);

console.log('=== resolved item is not re-processed on revisit ===');
q = createUploadQueue([F('a.jpg', 'image/jpeg'), F('b.png', 'image/png')], makeUrl);
q.resolve(q.items[0], { file: 'media/a.webp' });
ok('current skips the resolved item -> points at b', q.current === q.items[1]);
q.markSaved(q.items[0]);
ok('saved item also skipped', q.current === q.items[1]);

console.log('=== failed blocks Save until removed ===');
q = createUploadQueue([F('a.jpg', 'image/jpeg'), F('b.png', 'image/png')], makeUrl);
q.resolve(q.items[0], { file: 'media/a.webp' });
q.fail(q.items[1], new Error('boom'));
ok('canSave false while a failed item remains', q.canSave === false);
q.remove(q.items[1]);
ok('canSave true after removing the failed item', q.canSave === true);

console.log(`\n${pass} passed, ${fail} failed`);
if (typeof process !== 'undefined') process.exit(fail ? 1 : 0);
else if (typeof Deno !== 'undefined') Deno.exit(fail ? 1 : 0);
