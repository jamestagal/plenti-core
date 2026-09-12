// Run: node scripts/test-cms-transitions.mjs
// Or: deno run --allow-read --allow-env=TEST scripts/test-cms-transitions.mjs
// Synthetic component-transition evidence; see the harness's scope note.
import assert from 'node:assert/strict';
import { component, controlledImages, pendingMedia, settle } from './helpers/cms-transition-harness.mjs';

let passed = 0, failed = 0;
async function test(name, run) {
    const images = controlledImages();
    const originalDocument = globalThis.document;
    pendingMedia.clear();
    try { await run(images); passed++; console.log('PASS ' + name); }
    catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
    finally { images.restore(); globalThis.document = originalDocument; pendingMedia.clear(); }
}

const mediaField = (props = {}) => component('fields/media.svelte', {
    field: 'media/original.webp', localMediaList: [], changingMedia: '',
    showMediaModal: false, uploadContext: { kind: 'standalone' }, parentKeys: 'image',
    schema: { image: { type: 'media', options: [{ crop: false, scale: false }] } },
    ...props,
}, `
    pick(path) { swapMedia(); flush(); changingMedia = path; flush(); },
    reopen() { swapMedia(); flush(); },
    read() { flush(); return { field, cropError, showCropModal, processing }; }
`);

await test('latest field selection wins when image A decodes after B', async images => {
    const field = await mediaField();
    field.pick('media/a.webp');
    field.pick('media/b.webp');
    images.resolve(images.loads[1]); await settle();
    assert.equal(field.read().field, 'media/b.webp');
    images.resolve(images.loads[0]); await settle();
    assert.equal(field.read().field, 'media/b.webp');
    field.destroy();
});

await test('reopening the picker invalidates an unfinished selection', async images => {
    const field = await mediaField();
    field.pick('media/a.webp');
    field.reopen();
    images.resolve(images.loads[0]); await settle();
    assert.equal(field.read().field, 'media/original.webp');
    field.destroy();
});

await test('destroyed field ignores its unfinished selection', async images => {
    const field = await mediaField();
    field.pick('media/a.webp');
    field.destroy();
    images.resolve(images.loads[0]); await settle();
    assert.equal(field.read().field, 'media/original.webp');
});

const upload = () => component('file_upload.svelte', {
    media: [], localMediaList: [], mediaPrefix: '', showMediaModal: true,
    uploadContext: { kind: 'field' }, changingMedia: '',
}, `choose: selectFile, read() { return { showCropModal, cropError }; }`);
const stagedPaths = () => {
    let list; pendingMedia.subscribe(value => list = value)();
    return list.map(item => item.file);
};

await test('closing upload while decoding stages nothing and emits no handoff', async images => {
    const view = await upload();
    view.choose([new File(['image'], 'a.webp', { type: 'image/webp' })]);
    view.destroy();
    images.resolve(images.loads[0]); await settle();
    assert.deepEqual({ paths: stagedPaths(), events: view.events }, { paths: [], events: [] });
});

await test('changing upload owner during decode cannot hand A to field B', async images => {
    const view = await upload();
    view.choose([new File(['image'], 'a.webp', { type: 'image/webp' })]);
    view.set({ uploadContext: { kind: 'field' } });
    images.resolve(images.loads[0]); await settle();
    assert.deepEqual({ paths: stagedPaths(), events: view.events }, { paths: [], events: [] });
    view.destroy();
});

await test('replacing a pending image upload with a PDF drops the late image', async images => {
    const view = await upload();
    view.choose([new File(['image'], 'a.webp', { type: 'image/webp' })]);
    view.choose([new File(['pdf'], 'b.pdf', { type: 'application/pdf' })]);
    images.resolve(images.loads[0]); await settle();
    assert.deepEqual(stagedPaths(), ['media/b.pdf']);
    assert.deepEqual(view.events, [{ type: 'saved', detail: 'media/b.pdf' }]);
    view.destroy();
});

await test('latest selection also wins while the older image is being encoded', async images => {
    let finishEncoding;
    globalThis.document = { createElement: () => ({
        getContext: () => ({ drawImage() {}, fillRect() {} }),
        toBlob: (callback, type) => { finishEncoding = () => callback(new Blob(['pixels'], { type })); },
    }) };
    const field = await mediaField({
        schema: { image: { type: 'media', options: [{ crop: false, scale: false, convert: 'webp' }] } },
    });
    field.pick('media/a.png');
    images.resolve(images.loads[0]); await settle();
    assert.equal(typeof finishEncoding, 'function');
    field.pick('media/b.webp');
    images.resolve(images.loads[1]); await settle();
    finishEncoding(); await settle();
    assert.equal(field.read().field, 'media/b.webp');
    assert.deepEqual(stagedPaths(), []);
    assert.equal(field.read().processing, false);
    field.destroy();
});

await test('an active conforming upload stages the original file and hands off its path', async images => {
    const view = await upload();
    const file = new File(['original bytes'], 'active.webp', { type: 'image/webp' });
    view.choose([file]);
    images.resolve(images.loads[0]); await settle();
    let entries; pendingMedia.subscribe(value => entries = value)();
    assert.equal(entries[0].blob, file);
    assert.equal(entries[0].action, 'create');
    assert.deepEqual(view.events, [{ type: 'saved', detail: 'media/active.webp' }]);
    view.destroy();
});

await test('an active nonconforming upload still opens the optimise modal', async images => {
    const view = await upload();
    view.choose([new File(['image'], 'active.png', { type: 'image/png' })]);
    images.resolve(images.loads[0]); await settle();
    assert.equal(view.read().showCropModal, true);
    assert.deepEqual(stagedPaths(), []);
    view.destroy();
});

await test('an older decode failure cannot put an error on the newer selection', async images => {
    const field = await mediaField();
    field.pick('media/a.webp'); field.pick('media/b.webp');
    images.resolve(images.loads[1]); await settle();
    images.reject(images.loads[0]); await settle();
    assert.deepEqual([field.read().field, field.read().cropError], ['media/b.webp', '']);
    field.destroy();
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
