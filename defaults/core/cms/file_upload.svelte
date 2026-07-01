<script>
    import MediaFilters from './media_filters.svelte';
    import MediaGrid from './media_grid.svelte';
    import ButtonWrapper from './button_wrapper.svelte';
    import Button from './button.svelte';
    import { createEventDispatcher } from 'svelte';
    import ImageCropModal from './fields/image_crop_modal.svelte';
    import { transformImage, blobToDataURL, sourceExtension, LIBRARY_OPTIMISE_DEFAULTS } from './crop-engine.js';
    import { libraryFingerprint, libraryOutputPath } from './library_optimise.js';
    import { commit } from './providers/commit.js';
    import { STANDALONE_UPLOAD_CONTEXT } from './upload_context.js';
    import { createUploadQueue } from './upload_queue.js';
    import { onDestroy } from 'svelte';

    export let media, changingMedia, showMediaModal, localMediaList, mediaPrefix, user;
    const dispatch = createEventDispatcher();   // 'saved' (filePath) on a field-launched save
    // Explicit upload context — NEVER inferred from changingMedia (a field with no
    // current image has changingMedia === '', which would wrongly read as standalone).
    //   { kind: 'standalone' }                         — top-nav Media library
    //   { kind: 'field', onSavedPath(path) { … } }     — a field's "Change Media"
    export let uploadContext = STANDALONE_UPLOAD_CONTEXT;
    $: isFieldUpload = uploadContext?.kind === 'field';   // REACTIVE, not a cached const
    let enabledFilters = [];

    // Only raster formats the canvas can encode go through the optimise gateway.
    // MIME first; fall back to the filename extension ONLY when the MIME is absent
    // or generic (a valid JPEG can have an empty type; but application/pdf named
    // "x.jpg" must NOT be treated as an image).
    function isCanvasCandidate(file) {
        const mime = String(file?.type || '').toLowerCase();
        const ext = sourceExtension(file?.name);
        const MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];
        const EXTS = ['jpg', 'jpeg', 'png', 'webp', 'avif'];
        if (MIMES.includes(mime)) return true;
        if (mime && mime !== 'application/octet-stream') return false;
        return EXTS.includes(ext);
    }

    // A committed transport item is deduped by its PATH so one save never carries
    // two actions for the same file (new Set on media[] only dedupes the display).
    function addOrReplaceCommitItem(item) {
        const i = localMediaList.findIndex(x => x.file === item.file);
        localMediaList = i === -1
            ? [...localMediaList, item]
            : localMediaList.map((x, k) => (k === i ? item : x));
    }

    // Build a data URL from a File without a canvas (raw passthrough: PDF/SVG/GIF).
    function fileToDataURL(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = e => resolve(e.target.result);
            reader.onerror = () => reject(reader.error || new Error('The file could not be read.'));
            reader.readAsDataURL(file);
        });
    }

    // Derive the persisted TRANSPORT item for an optimised image derivative.
    // Shared by both entry points: field-launched (single) and the standalone queue.
    async function buildDerivativeItem({ image, selection, overrides, file, sourcePath }) {
        const options = { ...LIBRARY_OPTIMISE_DEFAULTS, ...(overrides || {}) };
        const result = await transformImage(image, selection, options, sourcePath);
        const fingerprint = await libraryFingerprint({ file, sourceRect: result.sourceRect, options });
        const filePath = libraryOutputPath({
            sourcePath, fingerprint,
            width: result.width, height: result.height, mime: result.actualMime,
        });
        // A data URL in `contents` (the provider strips the prefix); derivative → upsert.
        return { action: 'upsert', encoding: 'base64', file: filePath, contents: await blobToDataURL(result.blob) };
    }

    // ── the optimise-gateway modal driver ─────────────────────────────────────
    let showCropModal = false;
    let cropSourceUrl = '';   // object URL the modal LOADS (revoked on confirm/cancel/next)
    let cropSourceFile = null; // the File being optimised (for the fingerprint)
    let sourcePath = '';      // media/<name> the OUTPUT path is derived from
    let cropError = '';
    let processing = false;

    // ── STANDALONE multi-file queue (field-launched stays single-file) ─────────
    // The queue owns lifecycle/order/canSave; this component owns the DOM + transform.
    // One item is active at a time; its object URL feeds the modal. See upload_queue.js.
    let queue = null;
    let currentItem = null;   // the queue item the modal is currently showing
    let abort = null;         // AbortController for the active transform (real cancel)
    // The queue is a plain (non-reactive) object; bump this after every mutation so
    // Svelte recomputes canSave / unresolvedCount / queuePosition off it.
    let queueVersion = 0;
    const bump = () => { queueVersion++; };

    $: canSave = (queueVersion, queue) ? queue.canSave : localMediaList.length > 0;
    $: unresolvedCount = (queueVersion, queue) ? queue.unresolvedCount : 0;
    // "Image X of Y" over image-type items only (passthrough is not modal-driven).
    $: queuePosition = (() => {
        void queueVersion;
        if (!queue || !currentItem || currentItem.type !== 'image') return null;
        const images = queue.items.filter(i => i.type === 'image');
        const index = images.indexOf(currentItem) + 1;
        return index > 0 ? { index, total: images.length } : null;
    })();

    function revokeCropUrl() {
        if (cropSourceUrl) { URL.revokeObjectURL(cropSourceUrl); cropSourceUrl = null; }
    }

    // Advance the standalone queue: prepare the next item, or finish when drained.
    // Images open the modal (awaiting_decision); passthrough resolves immediately.
    async function advanceQueue() {
        if (!queue) return;
        const item = queue.current;
        if (!item) { currentItem = null; showCropModal = false; bump(); return; }   // drained
        currentItem = item;
        if (item.type === 'passthrough') {
            // Raw bytes + original extension; no modal, no canvas, no object URL.
            queue.process(item);
            bump();
            try {
                const contents = await fileToDataURL(item.file);
                const filePath = mediaPrefix + "media/" + item.file.name;
                const transport = { action: 'create', encoding: 'base64', file: filePath, contents };
                if (queue.resolve(item, transport)) addOrReplaceCommitItem(transport);
            } catch (error) {
                queue.fail(item, error);
                cropError = error instanceof Error ? error.message : 'The file could not be saved.';
            }
            bump();
            advanceQueue();
            return;
        }
        // Processable image → make a preview URL and drive the modal off this item.
        queue.prepare(item);              // sets item.objectUrl (the queue owns its lifecycle)
        cropError = '';
        cropSourceFile = item.file;
        cropSourceUrl = item.objectUrl;
        sourcePath = mediaPrefix + "media/" + item.file.name;
        queue.awaitDecision(item);
        showCropModal = true;
        bump();
    }

    async function onLibraryCropConfirm(event) {
        if (processing) return;
        processing = true;
        cropError = '';
        // A fresh signal per confirm; "Cancel current"/"Cancel all" abort it.
        abort = new AbortController();
        const signal = abort.signal;
        try {
            const transport = await buildDerivativeItem({
                image: event.detail.image, selection: event.detail.selection,
                overrides: event.detail.overrides, file: cropSourceFile, sourcePath,
            });
            if (signal.aborted) return;   // cancelled mid-transform → drop the result
            if (isFieldUpload) {
                // ONE click: eager commit now (no "Save Media"), then EMIT the persisted
                // path to the modal owner (admin_menu) which adds it to the library,
                // closes+resets the context, and hands it to the field. Once the commit
                // succeeds, the UPLOAD has succeeded — field processing is the parent's.
                await commit([transport], null, transport.action, transport.encoding, user);
                if (signal.aborted) return;
                revokeCropUrl();
                dispatch('saved', transport.file);
            } else {
                // Standalone: mark this queue item resolved (its URL is revoked by the
                // queue), stage the transport for the "Save Media" batch, advance.
                processing = false;
                if (queue && currentItem && queue.resolve(currentItem, transport)) {
                    cropSourceUrl = '';           // ownership handed to the queue (already revoked)
                    addOrReplaceCommitItem(transport);
                }
                bump();
                await advanceQueue();
                return;
            }
        } catch (error) {
            if (!signal.aborted) {
                cropError = error instanceof Error ? error.message : 'The image could not be processed.';
                if (queue && currentItem) { queue.fail(currentItem, error); bump(); }   // blocks Save until retried/removed
            }
        } finally {
            processing = false;
        }
    }

    // Modal "Cancel" = Cancel CURRENT in the standalone queue: abort the active
    // transform, drop this item, advance to the next. Field-launched just closes.
    function onLibraryCropCancel() {
        if (abort) { abort.abort(); abort = null; }
        cropError = '';
        if (isFieldUpload || !queue) {
            revokeCropUrl();
            showCropModal = false;
            return;
        }
        if (currentItem) queue.cancelCurrent(currentItem);   // marks cancelled + revokes URL
        cropSourceUrl = '';
        bump();
        advanceQueue();
    }

    // Cancel ALL queued files: abort, mark/revoke everything, clear queue + modal.
    function cancelAllUploads() {
        if (abort) { abort.abort(); abort = null; }
        if (queue) queue.cancelAll();
        cropSourceUrl = '';       // its URL was revoked by cancelAll
        currentItem = null;
        showCropModal = false;
        cropError = '';
        processing = false;
        bump();
    }

    // After a successful "Save Media" batch: the queue's resolved items are now
    // persisted, so tear it down (all URLs already revoked on resolve) and drop the
    // staged commit list. media[] keeps the paths added by addUploadsToLibrary().
    function resetQueueAfterSave() {
        if (queue) { queue.destroy(); queue = null; }
        currentItem = null;
        bump();
    }

    // Belt-and-braces: never leak an object URL if the component unmounts mid-queue
    // (e.g. the parent Media modal closes). Idempotent — destroy() re-revokes safely.
    onDestroy(() => {
        if (abort) { abort.abort(); abort = null; }
        if (queue) queue.destroy();
        revokeCropUrl();
    });

    // ── FIELD-LAUNCHED single-file path (unchanged semantics; no queue) ────────
    function optimiseLibraryFile(file) {
        cropError = '';
        cropSourceFile = file;
        cropSourceUrl = URL.createObjectURL(file);
        sourcePath = mediaPrefix + "media/" + file.name;
        showCropModal = true;
    }
    async function passthroughFieldFile(file) {
        const filePath = mediaPrefix + "media/" + file.name;
        try {
            const contents = await fileToDataURL(file);
            const item = { action: 'create', encoding: 'base64', file: filePath, contents };
            await commit([item], null, item.action, item.encoding, user);
            dispatch('saved', filePath);
        } catch (error) {
            cropError = error instanceof Error ? error.message : 'The file could not be saved.';
        }
    }

    // Entry point for BOTH input-change and drag-drop. Field-launched is single-file
    // (input enforces it); standalone builds a queue and processes one item at a time.
    const selectFile = files => {
        const list = Array.from(files || []);
        if (!list.length) return;
        if (isFieldUpload) {
            const file = list[0];
            if (isCanvasCandidate(file)) optimiseLibraryFile(file);
            else passthroughFieldFile(file);
            return;
        }
        // Standalone: (re)build the queue. Appending to an in-flight queue is not
        // supported yet — a new selection starts a fresh batch.
        if (queue) queue.destroy();
        queue = createUploadQueue(list, f => URL.createObjectURL(f));
        advanceQueue();
    }

    let filePrefix = mediaPrefix + "media/";
    $: if (enabledFilters) {
        if (enabledFilters.length > 0) {
            // Convert filter array to path
            let filterPath = enabledFilters[0].join('/') + "/";
            let newPrefix = mediaPrefix + "media/" + filterPath;
            localMediaList.forEach(mediaFile => {
                mediaFile.file = mediaFile.file.replace(filePrefix, newPrefix);
            });
            // Set new prefix in case filter is switched and needs to be replaced
            filePrefix = newPrefix;
        }
    }

    let drag;
    const toggleDrag = () => {
        drag = !drag;
    }
    const dropFile = ev => {
        if (!ev.dataTransfer) return;
        // Collect dropped files, then route through the SAME entry point as the input
        // (selectFile) so field/standalone branching + the queue apply identically.
        const files = [];
        if (ev.dataTransfer.items) {
            for (let i = 0; i < ev.dataTransfer.items.length; i++) {
                if (ev.dataTransfer.items[i].kind === 'file') {
                    const file = ev.dataTransfer.items[i].getAsFile();
                    if (file) files.push(file);
                }
            }
        } else if (ev.dataTransfer.files) {
            for (let i = 0; i < ev.dataTransfer.files.length; i++) files.push(ev.dataTransfer.files[i]);
        }
        if (files.length) selectFile(files);
    }

    let selectedMedia = [];
    const removeSelectedMedia = () => {
        selectedMedia.forEach(file => {
            localMediaList = localMediaList.filter(i => i.contents !== file);
            selectedMedia = [];
        });
    }

    const getThumbnails = mediaList => mediaList.map(i => i.contents);

    // UNIVERSAL fix: every saved item enters the library as its PERSISTED PATH
    // (item.file), never its transport data URL (item.contents). Dedupe by path.
    // Covers optimised derivatives AND raw passthrough (PDF/SVG/GIF/ordinary).
    const addUploadsToLibrary = () => {
        const savedPaths = localMediaList.map(item => item.file).filter(Boolean);
        media = [...new Set([...media, ...savedPaths])];
    }
</script>

<div class="upload-wrapper">
    {#if localMediaList.length > 0}
        <MediaFilters bind:media bind:enabledFilters singleSelect={true} {changingMedia} />
        <MediaGrid files={getThumbnails(localMediaList)} bind:selectedMedia={selectedMedia} />
        {#if queue && queue.unresolvedCount > 0}
            <div class="queue-status">
                {queue.unresolvedCount} file{queue.unresolvedCount === 1 ? '' : 's'} still to review — finish or cancel them before saving.
            </div>
        {/if}
        <ButtonWrapper>
            <Button
                on:click={() => {
                    addUploadsToLibrary();
                    resetQueueAfterSave();
                    enabledFilters=[];
                    filePrefix = mediaPrefix + "media/";
                    if(changingMedia) {
                        changingMedia = localMediaList[0].file;
                        showMediaModal = false;
                    }
                }}
                bind:commitList={localMediaList}
                buttonText="Save Media"
                action="create"
                encoding="base64"
                disabled={!canSave}
                {user}
            />
            {#if selectedMedia.length > 0}
                <Button
                    on:click="{removeSelectedMedia}"
                    buttonText="Discard selected"
                    buttonStyle="secondary"
                />
            {:else}
                <Button
                    on:click="{() => { cancelAllUploads(); localMediaList=[]; }}"
                    buttonText="Discard all"
                    buttonStyle="secondary"
                />
            {/if}
        </ButtonWrapper>
    {:else}
        <div class="upload-widgets">
            <div class="drop{drag ? ' active' : ''}"
                on:dragenter={toggleDrag} 
                on:dragleave={toggleDrag}  
                on:drop|preventDefault={event => dropFile(event)} 
                on:dragover|preventDefault
            >
                <div class="drop-icon">
                    <svg xmlns="http://www.w3.org/2000/svg" class="icon icon-tabler icon-tabler-cloud-upload" width="44" height="44" viewBox="0 0 24 24" stroke-width="1.5" stroke="#2c3e50" fill="none" stroke-linecap="round" stroke-linejoin="round">
                        <path stroke="none" d="M0 0h24v24H0z" fill="none"/>
                        <path d="M7 18a4.6 4.4 0 0 1 0 -9a5 4.5 0 0 1 11 2h1a3.5 3.5 0 0 1 0 7h-1" />
                        <polyline points="9 15 12 12 15 15" />
                        <line x1="12" y1="12" x2="12" y2="21" />
                    </svg>
                </div>
                <div class="drop-text">Drag a file here to upload</div>
            </div>
            <div class="or">Or</div>
            <div class="choose" on:change={event => selectFile(event.target.files)}>
                <label class="file">
                    <input type="file" multiple={!isFieldUpload} aria-label="File browser">
                    <span class="file-custom"></span>
                </label>
            </div>
        </div>
    {/if}
</div>

{#if showCropModal}
    <ImageCropModal
        imageUrl={cropSourceUrl}
        options={LIBRARY_OPTIMISE_DEFAULTS}
        libraryMode={true}
        allowCropToggle={!isFieldUpload}
        confirmLabel={isFieldUpload ? 'Use optimised image' : 'Add optimised image'}
        queuePosition={queuePosition}
        cancelLabel={!isFieldUpload && queuePosition && queuePosition.total > 1 ? 'Skip this file' : 'Cancel'}
        showCancelAll={!isFieldUpload && queuePosition && queuePosition.total > 1}
        error={cropError}
        {processing}
        on:confirm={onLibraryCropConfirm}
        on:cancel={onLibraryCropCancel}
        on:cancelAll={cancelAllUploads}
    />
{/if}

<style>
    .upload-wrapper {
        display: flex;
        flex-direction: column;
        overflow: hidden;
        height: 100%;
    }
    .queue-status {
        margin: 8px 0;
        padding: 8px 12px;
        background: #fff8e1;
        border: 1px solid #f0e0a0;
        border-radius: 4px;
        color: #7a6000;
        font-size: .85rem;
        text-align: center;
    }
    .upload-widgets {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 100%;
        box-sizing: border-box;
    }
    .drop {
        width: 100%;
        height: 40%;
        box-sizing: border-box;
        justify-content: center;
        border: 2px dashed;
        display: flex;
        flex-direction: column;
        align-items: center;
    }
    .drop.active {
        border-color: #1c7fc7;
        background-color: gainsboro;
    }
    .or {
        margin: 20px;
    }
    .file {
        position: relative;
        cursor: pointer;
    }
    .file input {
        border-radius: 50%;
    }
    .file-custom {
        position: absolute;
        top: 0;
        right: 0;
        left: 0;
        z-index: 5;
        padding: 0.5rem 1rem;
        background-color: #fff;
        border: 0.075rem solid #ddd;
        border-radius: 0.25rem;
        -webkit-user-select: none;
        -moz-user-select: none;
        -ms-user-select: none;
        user-select: none;
    }
    .file-custom:before {
        position: absolute;
        top: -0.075rem;
        right: -0.075rem;
        bottom: -0.075rem;
        content: "Browse";
        padding: 0.5rem 1rem;
        background-color: #eee;
        border: 0.075rem solid #ddd;
        border-radius: 0 0.25rem 0.25rem 0;
    }
    .file-custom:after {
        content: "Choose file...";
    }
</style>