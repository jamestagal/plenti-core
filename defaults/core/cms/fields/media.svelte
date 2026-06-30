<script>
    import { isImagePath, isDocPath } from '../media_checker.js';
    import { parseImageOptions, transformImage } from '../crop-engine.js';
    import { pendingMedia } from '../pending_media.js';
    import { fieldUploadHandler } from '../field_upload.js';
    import ImageCropModal from './image_crop_modal.svelte';

    export let field, showMediaModal, changingMedia, localMediaList;
    export let schema = null, parentKeys = null;

    // Resolve THIS field's schema config: the top-level key, else the parent
    // object key (one level of nesting). Read-only — never mutates siblings.
    function resolveFieldKey(schema, parentKeys) {
        if (!schema || !parentKeys) return null;
        if (schema[parentKeys]) return parentKeys;
        const dot = parentKeys.lastIndexOf('.');
        if (dot > -1 && schema[parentKeys.slice(0, dot)]) return parentKeys.slice(0, dot);
        return null;
    }
    // null when the field has no image options -> behaves as an ordinary field.
    $: imageOptions = parseImageOptions(schema, resolveFieldKey(schema, parentKeys));

    // A media value is a string path OR an object { src, alt, ... }. fieldSrc is
    // the path; setFieldSrc writes it back format-preservingly (keeps alt etc.).
    $: fieldSrc = typeof field === 'string' ? field : (field?.src ?? '');
    function setFieldSrc(newSrc) {
        field = (field && typeof field === 'object') ? { ...field, src: newSrc } : newSrc;
    }
    $: canReprocess = !!imageOptions && isImagePath(fieldSrc);
    // Show a pending derivative's in-memory preview until it's saved to disk.
    $: displaySrc = ($pendingMedia, pendingMedia.previewUrl(fieldSrc)) || fieldSrc;

    // Stop claiming field-scoped uploads once the media modal closes, so the
    // standalone library / non-crop uploads keep their eager behaviour.
    $: if (!showMediaModal) fieldUploadHandler.set(null);

    let showCropModal = false;
    let cropSourceUrl = '';   // URL the modal/transform LOADS (a path or blob: object URL)
    let cropNamePath = '';    // path the OUTPUT filename is derived from
    let cropRecrop = null;    // re-crop source stored in pendingMedia (a real path), or null
    let cropObjectUrl = null; // object URL to revoke when the crop modal closes
    let cropError = '';
    let processing = false;
    let cropRevertTo;         // value to restore if an auto-opened crop is cancelled

    function loadImage(src) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('Could not load the source image.'));
            img.src = src;
        });
    }
    function revokeCropUrl() {
        if (cropObjectUrl) { URL.revokeObjectURL(cropObjectUrl); cropObjectUrl = null; }
    }
    function openCropFor(loadUrl, namePath, recrop, objectUrl) {
        cropError = '';
        cropSourceUrl = loadUrl;
        cropNamePath = namePath;
        cropRecrop = recrop;
        cropObjectUrl = objectUrl;
        showCropModal = true;
    }

    // #364 core: enforce the field's schema when a NEW image enters the field —
    // an existing library pick (a path) handled here, or a fresh upload (a File)
    // handled by handleUploadedFile below.
    let lastHandled;
    $: if (changingMedia && field === originalMedia && changingMedia !== fieldSrc && changingMedia !== lastHandled) {
        lastHandled = changingMedia;
        fieldUploadHandler.set(null);              // a library pick happened, not an upload
        handleNewSelection(changingMedia);
    }
    function handleNewSelection(newPath) {
        const recrop = pendingMedia.sourceOf(newPath) ?? newPath;
        if (!imageOptions || !isImagePath(newPath)) {
            setFieldSrc(newPath);                  // ordinary field / non-image
        } else if (imageOptions.crop !== false) {
            cropRevertTo = field;
            setFieldSrc(newPath);                  // candidate; modal enforces the crop
            openCropFor(newPath, newPath, recrop, null);
        } else {
            optimiseToField(newPath, newPath, recrop, null);
        }
    }

    // A configured field's FRESH upload (registered via fieldUploadHandler): the
    // field enforces its schema and queues ONLY the derivative — the original is
    // never eager-saved to media/.
    async function handleUploadedFile(file) {
        fieldUploadHandler.set(null);
        showMediaModal = false;
        if (!imageOptions) return;
        const loadUrl = URL.createObjectURL(file); // load the not-yet-saved file
        const namePath = 'media/' + file.name;      // name the output after the file
        if (imageOptions.crop !== false) {
            cropRevertTo = field;
            openCropFor(loadUrl, namePath, null, loadUrl);
        } else {
            await optimiseToField(loadUrl, namePath, null, loadUrl);
        }
    }

    function openCrop() {
        // Manual re-crop/optimise from the field's current value (cancel keeps it).
        const src = pendingMedia.sourceOf(fieldSrc) ?? fieldSrc;
        cropRevertTo = undefined;
        openCropFor(src, src, src, null);
    }
    async function onCropConfirm(e) {
        if (processing) return;
        processing = true;
        cropError = '';
        try {
            const { image, selection } = e.detail;
            const result = await transformImage(image, selection, imageOptions, cropNamePath);
            // Only after BOTH transform and queue succeed do we touch the field.
            pendingMedia.add(result.filePath, result.blob, cropRecrop ?? result.filePath);
            setFieldSrc(result.filePath);
            cropRevertTo = undefined;
            revokeCropUrl();
            showCropModal = false;
        } catch (error) {
            cropError = error instanceof Error ? error.message : 'The image could not be processed.';
        } finally {
            processing = false;
        }
    }
    function cancelCrop() {
        showCropModal = false;
        revokeCropUrl();
        if (cropRevertTo !== undefined) {
            field = cropRevertTo;          // a cancelled auto-crop keeps the previous image
            cropRevertTo = undefined;
        }
    }

    // crop:false automatic optimisation (contain/convert), no modal. Keeps the
    // previous field value untouched if the transform fails.
    async function optimiseToField(loadUrl, namePath, recrop, objectUrl) {
        if (processing) return;
        const previous = field;
        processing = true;
        cropError = '';
        try {
            const image = await loadImage(loadUrl);
            const result = await transformImage(image, null, imageOptions, namePath);
            pendingMedia.add(result.filePath, result.blob, recrop ?? result.filePath);
            setFieldSrc(result.filePath);
        } catch (error) {
            field = previous;
            cropError = error instanceof Error ? error.message : 'The image could not be processed.';
        } finally {
            if (objectUrl) URL.revokeObjectURL(objectUrl);
            processing = false;
        }
    }

    // --- media-swap entry point ---
    let originalMedia;
    const swapMedia = () => {
        originalMedia = field;
        // Claim field-scoped uploads when this field enforces a schema, so a
        // fresh upload is processed (not eager-saved). Cleared on modal close.
        fieldUploadHandler.set(imageOptions ? handleUploadedFile : null);
        changingMedia = fieldSrc;
        showMediaModal = true;
    }

    // If an img path is 404, load the data image instead
    const loadDataImage = imgEl => {
        let src = imgEl.target.attributes.src.nodeValue;
        let allImg = document.querySelectorAll('img[src="' + src + '"]');
        allImg.forEach(i => {
            localMediaList.forEach(mediaItem => {
                if(mediaItem.file === fieldSrc) {
                    i.src = mediaItem.contents;
                }
            });
        });
    }
</script>

<div class="thumbnail-wrapper">
    {#if isImagePath(fieldSrc)}
        <img src="{displaySrc}" alt="click to change thumbnail" class="thumbnail" on:error={imgEl => loadDataImage(imgEl)} />
    {:else if isDocPath(fieldSrc)}
        <embed src="{displaySrc}" class="thumbnail" />
    {/if}
    <button class="swap" on:click|preventDefault={swapMedia}>Change Media</button>
    {#if canReprocess}
        <button class="crop" on:click|preventDefault={openCrop}>{imageOptions.crop !== false ? 'Crop' : 'Optimise'}</button>
    {/if}
    {#if processing && !showCropModal}
        <div class="processing">Optimising…</div>
    {/if}
</div>
{#if cropError && !showCropModal}
    <div class="field-error">⚠️ {cropError}</div>
{/if}

{#if showCropModal}
    <ImageCropModal
        imageUrl={cropSourceUrl}
        options={imageOptions}
        error={cropError}
        {processing}
        on:confirm={onCropConfirm}
        on:cancel={cancelCrop}
    />
{/if}

<style>
    .thumbnail-wrapper {
        height: 115px;
        overflow: hidden;
        position: relative;
    }
    .thumbnail {
        max-width: 200px;
    }
    button.swap {
        cursor: pointer;
        position: absolute;
        top: 0;
        left: 0;
        width: 200px;
        height: 115px;
        border: 0;
        background-color: transparent;
        color: transparent;
        font-size: 1.25rem;
        transition: all .15s;
    }
    button.swap:hover {
        background-color: rgba(0, 0, 0, .75);
        color: white;
    }
    button.crop {
        cursor: pointer;
        position: absolute;
        bottom: 6px;
        right: 6px;
        border: 0;
        border-radius: 4px;
        padding: 5px 10px;
        font-weight: bold;
        background-color: #1c7fc7;
        color: white;
    }
    button.crop:hover {
        background-color: #15679f;
    }
    .processing {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(0, 0, 0, .6);
        color: white;
        font-weight: bold;
    }
    .field-error {
        color: darkred;
        font-size: .85rem;
        margin-top: 4px;
    }
</style>
