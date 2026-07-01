// upload_queue.js — the standalone Media-Library multi-file upload queue.
//
// A small deterministic state machine for a batch of selected files. It owns
// ONLY queue/lifecycle state — no DOM, no provider calls, no transforms. The
// component drives it (advance, resolve, fail, cancel) and reads it (current,
// canSave, unresolvedCount). Field-launched uploads do NOT use this queue: they
// are single-file with their own mandatory placement-crop path.
//
// Per-item states:
//   queued -> preparing -> awaiting_decision -> processing -> resolved -> saved
// Terminal: failed, cancelled.
//
// File TYPE is a classification, not a state:
//   'image'       — JPEG/PNG/WebP/AVIF (canvas-processable: optimise/crop)
//   'passthrough' — PDF/SVG/GIF (byte-preserving: original bytes + extension)
//
// Invariants the state machine guarantees (the component honours the rest):
//   - deterministic order (insertion order, never reordered)
//   - one active item at a time (`current` is the single in-flight item)
//   - Save disabled while ANY item is unresolved (queued/preparing/
//     awaiting_decision/processing, or failed-without-removal)
//   - a resolved/saved item is never re-processed on revisit
//   - a cancelled item's late result is ignored (state !== the expected one)
//   - object-URL revocation is idempotent (revoke() clears the ref)

const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];
const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'avif'];

function extOf(name) {
    const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)(?:[?#].*)?$/);
    return m ? m[1] : '';
}

/**
 * Classify a File: 'image' (canvas-processable) or 'passthrough' (byte-preserving).
 * MIME first; extension fallback ONLY when MIME is absent/generic — a real non-image
 * MIME (e.g. application/pdf named "x.jpg") is NOT treated as an image.
 */
export function classifyFile(file) {
    const mime = String(file?.type || '').toLowerCase();
    const ext = extOf(file?.name);
    if (IMAGE_MIMES.includes(mime)) return 'image';
    if (mime && mime !== 'application/octet-stream') return 'passthrough';
    return IMAGE_EXTS.includes(ext) ? 'image' : 'passthrough';
}

// States that mean "not yet done" — Save must stay disabled while any item is here.
// 'failed' is unresolved too: it blocks Save until removed or retried.
const UNRESOLVED = new Set(['queued', 'preparing', 'awaiting_decision', 'processing', 'failed']);

let _seq = 0; // monotonic id source (module-local; fine for a browser session)

/**
 * Build a queue from a FileList/array. Each item: { id, file, type, state, objectUrl, result, error }.
 * `makeObjectUrl` is injected (URL.createObjectURL) so the module stays DOM-free and testable.
 */
export function createUploadQueue(files, makeObjectUrl) {
    const items = Array.from(files || []).map(file => ({
        id: ++_seq,
        file,
        type: classifyFile(file),
        state: 'queued',
        objectUrl: null,
        result: null,   // the resolved transport item (or passthrough item)
        error: null,
    }));

    const idx = () => items.findIndex(i => i.state !== 'resolved' && i.state !== 'saved'
        && i.state !== 'cancelled' && i.state !== 'failed');

    const revoke = (item) => {
        if (item && item.objectUrl) {
            try { URL.revokeObjectURL(item.objectUrl); } catch (_) { /* idempotent */ }
            item.objectUrl = null;
        }
    };

    return {
        items,
        // The next item to work, or null when the queue is drained of actionable items.
        get current() {
            const i = idx();
            return i === -1 ? null : items[i];
        },
        // Move an item forward: create its preview URL and mark it preparing. Returns the item.
        prepare(item) {
            if (!item) return null;
            item.state = 'preparing';
            item.objectUrl = makeObjectUrl ? makeObjectUrl(item.file) : null;
            return item;
        },
        awaitDecision(item) { if (item) item.state = 'awaiting_decision'; return item; },
        process(item) { if (item) item.state = 'processing'; return item; },
        // A successful derivative/passthrough result. Ignored if the item was cancelled
        // meanwhile (guards the "late result must not insert" invariant).
        resolve(item, result) {
            if (!item || item.state === 'cancelled') return false;
            item.result = result;
            item.state = 'resolved';
            revoke(item);
            return true;
        },
        markSaved(item) { if (item) item.state = 'saved'; },
        fail(item, error) {
            if (!item || item.state === 'cancelled') return;
            item.error = error;
            item.state = 'failed';
            revoke(item);
        },
        // Cancel the CURRENT item: abort semantics are the caller's (AbortController);
        // here we just mark it cancelled + revoke, so any late result is dropped by resolve().
        cancelCurrent(item) {
            if (!item) return;
            item.state = 'cancelled';
            revoke(item);
        },
        remove(item) {
            if (!item) return;
            revoke(item);
            const i = items.indexOf(item);
            if (i !== -1) items.splice(i, 1);
        },
        // Cancel ALL: mark every non-terminal item cancelled + revoke everything.
        cancelAll() {
            for (const item of items) {
                if (item.state !== 'saved') item.state = 'cancelled';
                revoke(item);
            }
        },
        // Idempotent teardown — revoke every URL (safe to call more than once).
        destroy() { for (const item of items) revoke(item); },
        // Resolved-but-not-yet-saved transport items, in order, for the batch commit.
        resolvedItems() { return items.filter(i => i.state === 'resolved').map(i => i.result); },
        // Save may proceed only when NOTHING is unresolved AND at least one item resolved.
        get canSave() {
            const anyUnresolved = items.some(i => UNRESOLVED.has(i.state));
            const anyResolved = items.some(i => i.state === 'resolved');
            return !anyUnresolved && anyResolved;
        },
        get unresolvedCount() { return items.filter(i => UNRESOLVED.has(i.state)).length; },
        get done() { return this.current === null; },
    };
}
