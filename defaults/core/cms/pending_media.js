import { writable, get } from 'svelte/store';
import { blobToDataURL } from './crop-engine.js';

// Image derivatives produced by the crop engine, held IN MEMORY as Blobs until
// the page is saved (deferred persistence). Nothing is written until the
// page-save commit; cancelling the edit discards these. Blobs (not data URLs)
// are kept so the larger base64 isn't carried through UI state — conversion to
// a data URL happens only in toCommitItems(), at payload-build time.
function createPendingMedia() {
    const store = writable([]); // [{ file, blob, action }]
    const { subscribe, set, update } = store;
    return {
        subscribe,
        // Add or REPLACE a derivative, deduped by output path so re-cropping the
        // same target replaces the pending item rather than adding a duplicate.
        add(file, blob, action = 'create') {
            update(list => [...list.filter(item => item.file !== file), { file, blob, action }]);
        },
        remove(file) {
            update(list => list.filter(item => item.file !== file));
        },
        clear() {
            set([]);
        },
        // Commit items for the page-save payload — Blob -> base64 data URL HERE,
        // not while editing. Each item carries its own action/encoding so it
        // merges into the content commit without overriding the content item.
        async toCommitItems() {
            return Promise.all(get(store).map(async item => ({
                action: item.action,
                encoding: 'base64',
                file: item.file,
                contents: await blobToDataURL(item.blob),
            })));
        },
    };
}

export const pendingMedia = createPendingMedia();
