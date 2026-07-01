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

    // ── the optimise-gateway modal driver ─────────────────────────────────────
    let showCropModal = false;
    let cropSourceUrl = '';   // object URL the modal LOADS (revoked on confirm/cancel)
    let cropSourceFile = null; // the File being optimised (for the fingerprint)
    let sourcePath = '';      // media/<name> the OUTPUT path is derived from
    let cropError = '';
    let processing = false;

    function revokeCropUrl() {
        if (cropSourceUrl) { URL.revokeObjectURL(cropSourceUrl); cropSourceUrl = null; }
    }
    function optimiseLibraryFile(file) {
        cropError = '';
        cropSourceFile = file;
        cropSourceUrl = URL.createObjectURL(file);
        sourcePath = mediaPrefix + "media/" + file.name;
        showCropModal = true;
    }

    async function onLibraryCropConfirm(event) {
        if (processing) return;
        processing = true;
        cropError = '';
        try {
            const options = { ...LIBRARY_OPTIMISE_DEFAULTS, ...(event.detail.overrides || {}) };
            const result = await transformImage(event.detail.image, event.detail.selection, options, sourcePath);
            const fingerprint = await libraryFingerprint({ file: cropSourceFile, sourceRect: result.sourceRect, options });
            const filePath = libraryOutputPath({
                sourcePath, fingerprint,
                width: result.width, height: result.height, mime: result.actualMime,
            });
            // The transport item — a data URL in `contents` (the provider strips the
            // prefix); the derivative carries per-item action:'upsert'.
            const item = {
                action: 'upsert', encoding: 'base64',
                file: filePath, contents: await blobToDataURL(result.blob),
            };
            if (isFieldUpload) {
                // ONE click: eager commit now (no "Save Media"), then EMIT the persisted
                // path to the modal owner (admin_menu) which adds it to the library,
                // closes+resets the context, and hands it to the field. Once the commit
                // succeeds, the UPLOAD has succeeded — field processing is the parent's.
                await commit([item], null, item.action, item.encoding, user);
                revokeCropUrl();
                dispatch('saved', filePath);
            } else {
                addOrReplaceCommitItem(item);   // standalone: queue for the "Save Media" batch
                revokeCropUrl();
                showCropModal = false;
            }
        } catch (error) {
            cropError = error instanceof Error ? error.message : 'The image could not be processed.';
        } finally {
            processing = false;
        }
    }
    function onLibraryCropCancel() {
        revokeCropUrl();
        showCropModal = false;
        cropError = '';
    }

    // A raw (non-canvas) file: PDF/SVG/GIF. Standalone queues it for "Save Media";
    // a field-launched passthrough eager-commits (create) then emits the path, the
    // same one-click ownership order as an optimised image (admin_menu finishes it).
    function passthroughFile(file) {
        const filePath = mediaPrefix + "media/" + file.name;
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = async e => {
            const item = { action: 'create', encoding: 'base64', file: filePath, contents: e.target.result };
            if (isFieldUpload) {
                try {
                    await commit([item], null, item.action, item.encoding, user);
                    dispatch('saved', filePath);
                } catch (error) {
                    cropError = error instanceof Error ? error.message : 'The file could not be saved.';
                }
            } else {
                addOrReplaceCommitItem(item);
            }
        };
    }

    const createMediaList = file => {
        // Images pass through the optimise gateway; everything else is saved raw.
        if (isCanvasCandidate(file)) optimiseLibraryFile(file);
        else passthroughFile(file);
    }
    const selectFile = files => {
        Array.from(files).forEach(file => {
            createMediaList(file);
        });
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
        if (ev.dataTransfer.items) {
            // Use DataTransferItemList interface to access the file(s)
            for (let i = 0; i < ev.dataTransfer.items.length; i++) {
                // If dropped items aren't files, reject them
                if (ev.dataTransfer.items[i].kind === 'file') {
                    let file = ev.dataTransfer.items[i].getAsFile();
                    createMediaList(file);
                }
            }
        }
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
        <ButtonWrapper>
            <Button
                on:click={() => {
                    addUploadsToLibrary();
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
                    on:click="{() => localMediaList=[]}"
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
        error={cropError}
        {processing}
        on:confirm={onLibraryCropConfirm}
        on:cancel={onLibraryCropCancel}
    />
{/if}

<style>
    .upload-wrapper {
        display: flex;
        flex-direction: column;
        overflow: hidden;
        height: 100%;
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