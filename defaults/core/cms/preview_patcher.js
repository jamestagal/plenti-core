import { pendingMedia } from './pending_media.js';

// Keeps the LIVE PAGE preview truthful while media is deferred (#364 D13):
// a content edit puts a derivative PATH into the page markup immediately, but
// the file only reaches media/ at the page-save commit — so the page's own
// <img>/<embed> elements would render broken until then. While an entry is
// pending, matching elements are swapped to its in-memory object URL; the
// original path is remembered on the element and restored when the entry
// leaves the store. After a successful save the entry survives markCommitted()
// with its object URL, so the blob keeps covering the just-written file until
// reload (the same freshly-written-path race pending_media.js documents).
//
// The field widget (media.svelte displaySrc) does its own pendingMedia lookup;
// this module covers markup the CMS does not own — the user's page layout.
const ATTR = 'data-plenti-pending-src';

// Content stores bare 'media/…' paths; layouts may render them with a leading
// slash or baseurl prefix, so match on the exact value or a '/'-suffix.
const entryFor = (list, src) =>
    src ? list.find(i => src === i.file || src.endsWith('/' + i.file)) : null;

function applyPending(list) {
    document.querySelectorAll('img, embed').forEach(el => {
        const src = el.getAttribute('src') || '';
        const original = el.getAttribute(ATTR);
        if (original !== null) {
            const entry = entryFor(list, original);
            if (!entry) {
                el.setAttribute('src', original);   // no longer pending
                el.removeAttribute(ATTR);
            } else if (src !== entry.url) {
                // A rerender restored the raw path, or a re-crop replaced the
                // blob — point back at the current preview URL.
                el.setAttribute('src', entry.url);
            }
            return;
        }
        const entry = entryFor(list, src);
        if (entry) {
            el.setAttribute(ATTR, src);
            el.setAttribute('src', entry.url);
        }
    });
}

// Client-only: call from onMount. Returns a stop() that restores every
// original src. Re-entry settles in one pass — a patched element's src equals
// the entry URL, so the observer callback makes no further mutations.
export function startPreviewPatcher() {
    let current = [];
    const run = () => applyPending(current);
    const unsubscribe = pendingMedia.subscribe(list => { current = list; run(); });
    const observer = new MutationObserver(run);
    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src'],
    });
    return () => {
        observer.disconnect();
        unsubscribe();
        applyPending([]);
    };
}
