// Dependency-free regression tests for defaults/core/cms/crop-engine.js.
//
//   Run:  node scripts/test-crop-engine.mjs
//
// No test framework, no npm install. The engine is an ESM file that lives under
// defaults/core/ (embedded into the binary), and this repo has no root
// package.json marking .js as ESM, so we load the engine *source* through a
// data: URL import — which always parses as a module regardless of config.
//
// Covers the ADR test checklist (crop x scale matrix, format fallback, the
// null-selection regression, etc.). Canvas/FileReader are mocked just enough to
// drive the transformation paths.

import { readFile } from 'node:fs/promises';

let drawCall = null, fillRectCalled = false, forcePng = false;
const resetDraw = () => { drawCall = null; };
const resetFill = () => { fillRectCalled = false; };
const setForcePng = v => { forcePng = v; };

globalThis.document = {
    createElement() {
        const c = { width: 0, height: 0 };
        c.getContext = () => ({
            imageSmoothingEnabled: false, imageSmoothingQuality: '',
            set fillStyle(_) {}, get fillStyle() { return ''; },
            fillRect() { fillRectCalled = true; },
            drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh) { drawCall = { sx, sy, sw, sh, dw, dh }; },
        });
        c.toBlob = (cb, format) => {
            let type = format;
            if (forcePng && (format === 'image/webp' || format === 'image/avif')) type = 'image/png';
            cb({ type, size: (c.width * c.height) || 1 });
        };
        c.toDataURL = format => `data:${format};base64,AAAA`;
        return c;
    },
};

const src = await readFile(new URL('../defaults/core/cms/crop-engine.js', import.meta.url), 'utf8');
const { sourceExtension, extToMime, parseImageOptions, renderImage, outputFilename, transformImage } =
    await import('data:text/javascript,' + encodeURIComponent(src));

let pass = 0, fail = 0;
const eq = (actual, expected, name) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n    got      ${JSON.stringify(actual)}\n    expected ${JSON.stringify(expected)}`}`);
    ok ? pass++ : fail++;
};
const throwsAsync = async (fn, name) => {
    try { await fn(); console.log(`✗ ${name} (expected a throw)`); fail++; }
    catch { console.log(`✓ ${name} (threw as expected)`); pass++; }
};

const img = { naturalWidth: 800, naturalHeight: 600 };

console.log('--- pure logic ---');
eq(sourceExtension('media/perry.JPG?v=2'), 'jpg', 'sourceExtension');
eq([extToMime('webp'), extToMime('zzz')], ['image/webp', 'image/png'], 'extToMime');
eq(parseImageOptions({ hero: { type: 'media', options: [{ width: 500, height: 300, scale: true, crop: true, convert: 'webp' }] } }, 'hero'),
   { enabled: true, width: 500, height: 300, scale: true, crop: true, convert: 'webp', quality: 0.82, background: null, aspectRatio: '500:300', lockAspectRatio: false, minWidth: null, minHeight: null, showGrid: true, showCoordinates: true },
   'parseImageOptions maintainer options[]');
eq(parseImageOptions({ t: { type: 'media', crop: { enabled: true, aspectRatio: '1:1', minWidth: 200, minHeight: 200 } } }, 't'),
   { enabled: true, width: null, height: null, scale: true, crop: true, convert: null, quality: 0.82, background: null, aspectRatio: '1:1', lockAspectRatio: false, minWidth: 200, minHeight: 200, showGrid: true, showCoordinates: true },
   'parseImageOptions prototype crop{}');
eq(parseImageOptions({ x: { type: 'media' } }, 'x'), null, 'parseImageOptions no config -> null');
eq(parseImageOptions({ x: { type: 'media', options: [{ convert: 'gif' }] } }, 'x').convert, null, 'normalizeFormat rejects gif output');
eq(parseImageOptions({ x: { type: 'media', options: [{ convert: 'IMAGE/WEBP' }] } }, 'x').convert, 'webp', 'normalizeFormat anchored (no fooimage bug)');
eq(outputFilename('media/perry-cropped-1x1.webp', { width: 500, height: 300, ext: 'png' }), 'media/perry-500x300.png', 'outputFilename strips prior suffix');

console.log('\n--- renderImage / transformImage (ADR test checklist 1-10) ---');

// 1. null & undefined selection -> whole image
resetDraw(); let r = await renderImage(img, null, { format: 'image/png' });
eq([drawCall.sw, drawCall.sh, r.width, r.height], [800, 600, 800, 600], 'C1a null selection -> whole image');
resetDraw(); await renderImage(img, undefined, { format: 'image/png' });
eq([drawCall.sw, drawCall.sh], [800, 600], 'C1b undefined selection -> whole image');

// 2. selection at/beyond edge -> never zero dims
resetDraw(); await renderImage(img, { x: 800, y: 600, width: 100, height: 100 }, { format: 'image/png' });
eq([drawCall.sw >= 1, drawCall.sh >= 1], [true, true], 'C2 edge selection -> non-zero source rect');

// 3. scale:false preserves selected source-pixel dims
let res = await transformImage(img, { x: 10, y: 10, width: 400, height: 300 }, { crop: true, scale: false }, 'media/p.png');
eq([res.width, res.height], [400, 300], 'C3 scale:false preserves selection dims');

// 4. crop:false ignores selection, whole-image contain (800x600 within 500x500 = 500x375)
resetDraw(); res = await transformImage(img, { x: 10, y: 10, width: 400, height: 300 }, { crop: false, scale: true, width: 500, height: 500 }, 'media/p.png');
eq([drawCall.sw, drawCall.sh, res.width, res.height], [800, 600, 500, 375], 'C4 crop:false contain, ignores selection');

// 5. crop:true with no selection -> error
await throwsAsync(() => transformImage(img, null, { crop: true, scale: true, width: 400, height: 300 }, 'media/p.png'), 'C5 crop:true no selection throws');

// 6. fractional dims -> integers
res = await transformImage(img, { x: 0, y: 0, width: 400, height: 400 }, { crop: true, scale: true, width: 250.7, height: 250.7 }, 'media/p.png');
eq([Number.isInteger(res.width), res.width], [true, 251], 'C6 fractional dims -> integer');

// 7. aspect mismatch (both dims) -> rejected
await throwsAsync(() => transformImage(img, { x: 0, y: 0, width: 400, height: 200 }, { crop: true, scale: true, width: 300, height: 300 }, 'media/p.png'), 'C7 aspect mismatch rejected');

// 8. unsupported webp encode -> named PNG + formatFallback
setForcePng(true);
res = await transformImage(img, { x: 0, y: 0, width: 400, height: 300 }, { crop: true, scale: true, width: 400, height: 300, convert: 'webp' }, 'media/p.jpg');
eq([res.filePath, res.formatFallback], ['media/p-400x300.png', true], 'C8 webp fallback -> named PNG + flagged');
setForcePng(false);

// 9. .jpeg -> image/jpeg not marked converted
res = await transformImage(img, { x: 0, y: 0, width: 400, height: 300 }, { crop: true, scale: true, width: 400, height: 300, convert: 'jpg' }, 'media/photo.jpeg');
eq(res.converted, false, 'C9 .jpeg -> jpg not converted');

// 10. transparent -> JPEG gets background fill (webp does not)
resetFill(); await transformImage(img, { x: 0, y: 0, width: 400, height: 300 }, { crop: true, scale: true, width: 400, height: 300, convert: 'jpg' }, 'media/p.png');
eq(fillRectCalled, true, 'C10a JPEG output fills background');
resetFill(); await transformImage(img, { x: 0, y: 0, width: 400, height: 300 }, { crop: true, scale: true, width: 400, height: 300, convert: 'webp' }, 'media/p.png');
eq(fillRectCalled, false, 'C10b non-JPEG output does not fill');

// locked return contract
res = await transformImage(img, { x: 0, y: 0, width: 400, height: 300 }, { crop: true, scale: true, width: 400, height: 300 }, 'media/p.png');
eq(Object.keys(res), ['blob', 'filePath', 'width', 'height', 'requestedMime', 'actualMime', 'formatFallback', 'converted', 'bytes'], 'transformImage return shape is the frozen contract');
eq(res.bytes > 0, true, 'transformImage returns bytes (size-win proof)');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
