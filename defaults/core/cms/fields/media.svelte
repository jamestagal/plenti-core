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
    $: canCrop = !!imageOptions && isImagePath(fieldSrc);
    // Show a pending derivative's in-memory preview until it's saved to disk.
    $: displaySrc = ($pendingMedia, pendingMedia.previewUrl(fieldSrc)) || fieldSrc;

    let showCropModal = false;
    let cropSourceUrl = '';
    let cropError = '';
    let processing = false;

    function openCrop() {
        cropError = '';
        // Re-crop from the ORIGINAL source (within this session), never a prior
        // compressed derivative.
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
            // Only after BOTH the transform and the queue succeed do we touch the
            // field — a failure leaves field, selection, and pending untouched.
            pendingMedia.add(result.filePath, result.blob, cropSourceUrl);
            setFieldSrc(result.filePath);
            showCropModal = false;
        } catch (error) {
            cropError = error instanceof Error ? error.message : 'The image could not be processed.';
        } finally {
            processing = false;
        }
    }

    // --- existing media-swap behaviour, made format-preserving ---
    let originalMedia;
    const swapMedia = () => {
        originalMedia = field;
        changingMedia = fieldSrc;
        showMediaModal = true;
    }
    $: if (changingMedia) {
        if (field === originalMedia && changingMedia !== fieldSrc) {
            setFieldSrc(changingMedia);
        }
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
    {#if canCrop}
        <button class="crop" on:click|preventDefault={openCrop}>{imageOptions.crop !== false ? 'Crop' : 'Optimise'}</button>
    {/if}
</div>

{#if showCropModal}
    <ImageCropModal
        imageUrl={cropSourceUrl}
        options={imageOptions}
        error={cropError}
        {processing}
        on:confirm={onCropConfirm}
        on:cancel={() => showCropModal = false}
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
</style>
