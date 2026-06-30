<script>
    import { isImagePath, isDocPath } from '../media_checker.js';
    import { parseImageOptions, transformImage } from '../crop-engine.js';
    import { pendingMedia } from '../pending_media.js';
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

    let showCropModal = false;
    let cropSourceUrl = '';
    let cropError = '';
    let processing = false;
    let cropRevertTo;   // value to restore if an auto-opened crop is cancelled

    function cancelCrop() {
        showCropModal = false;
        if (cropRevertTo !== undefined) {
            field = cropRevertTo;        // a cancelled auto-crop keeps the previous image
            cropRevertTo = undefined;
        }
    }

    function loadImage(src) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('Could not load the source image.'));
            img.src = src;
        });
    }

    // #364 core: when a NEW image is selected/uploaded into this field, enforce
    // the field's schema automatically — crop:true opens the modal, crop:false
    // optimises immediately, no options just assigns.
    let lastHandled;
    $: if (changingMedia && field === originalMedia && changingMedia !== fieldSrc && changingMedia !== lastHandled) {
        lastHandled = changingMedia;
        handleNewSelection(changingMedia);
    }
    function handleNewSelection(newPath) {
        if (!imageOptions || !isImagePath(newPath)) {
            setFieldSrc(newPath);                      // ordinary field / non-image
        } else if (imageOptions.crop !== false) {
            cropRevertTo = field;                      // restore this if the crop is cancelled
            setFieldSrc(newPath);                      // candidate; modal enforces the crop
            // Use newPath directly — fieldSrc hasn't reactively updated yet.
            cropSourceUrl = pendingMedia.sourceOf(newPath) ?? newPath;
            cropError = '';
            showCropModal = true;
        } else {
            autoOptimise(newPath);                     // crop:false -> optimise now
        }
    }

    function openCrop() {
        cropError = '';
        cropRevertTo = undefined;                       // manual re-crop: cancel keeps current
        // Re-crop/optimise from the ORIGINAL source (within this session).
        cropSourceUrl = pendingMedia.sourceOf(fieldSrc) ?? fieldSrc;
        showCropModal = true;
    }
    async function onCropConfirm(e) {
        if (processing) return;
        processing = true;
        cropError = '';
        try {
            const { image, selection } = e.detail;
            const result = await transformImage(image, selection, imageOptions, cropSourceUrl);
            pendingMedia.add(result.filePath, result.blob, cropSourceUrl);
            setFieldSrc(result.filePath);
            cropRevertTo = undefined;
            showCropModal = false;
        } catch (error) {
            cropError = error instanceof Error ? error.message : 'The image could not be processed.';
        } finally {
            processing = false;
        }
    }

    // crop:false automatic optimisation (contain/convert), no modal. Keeps the
    // previous field value untouched if the transform fails.
    async function autoOptimise(newPath) {
        if (processing) return;
        const previous = field;
        processing = true;
        cropError = '';
        try {
            const image = await loadImage(newPath);
            const result = await transformImage(image, null, imageOptions, newPath);
            pendingMedia.add(result.filePath, result.blob, newPath);
            setFieldSrc(result.filePath);
        } catch (error) {
            field = previous;
            cropError = error instanceof Error ? error.message : 'The image could not be processed.';
        } finally {
            processing = false;
        }
    }

    // --- existing media-swap entry point ---
    let originalMedia;
    const swapMedia = () => {
        originalMedia = field;
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
