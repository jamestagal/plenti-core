<script>
    import { createEventDispatcher } from 'svelte';

    // Presentation + interaction only. The parent owns transformation, the
    // pending queue, the field value, and the source-path distinction.
    //   imageUrl : the source image to crop (the ORIGINAL, resolved by the parent)
    //   options  : normalized parseImageOptions() output for this field
    //   error    : message shown when the parent's transform fails (modal stays open)
    // Dispatches: confirm { image, selection } ; cancel
    export let imageUrl;
    export let options = {};
    export let error = '';
    export let processing = false;

    const dispatch = createEventDispatcher();
    const MAX = 360; // max crop-box display edge (px)

    $: doCrop = options?.crop !== false;
    $: doScale = options?.scale !== false;
    $: showGrid = options?.showGrid !== false;
    $: showCoords = options?.showCoordinates !== false;
    $: locked = !!(options?.width && options?.height) || (!!options?.aspectRatio && !!options?.lockAspectRatio);

    function aspectOf(o) {
        if (!o) return null;
        if (o.width && o.height) return o.width / o.height;
        if (o.aspectRatio) {
            const [w, h] = String(o.aspectRatio).split(':').map(Number);
            if (w > 0 && h > 0) return w / h;
        }
        return null;
    }
    $: aspect = aspectOf(options);
    // Crop box: matches the locked output aspect; square for free crop; square
    // preview frame when not cropping (image is contained inside).
    $: cropSize = doCrop && aspect
        ? (aspect >= 1 ? { width: MAX, height: Math.round(MAX / aspect) }
                       : { width: Math.round(MAX * aspect), height: MAX })
        : { width: MAX, height: MAX };

    let imageElement;
    let natural = { w: 0, h: 0 };
    let scale = 1;
    let pos = { x: 0, y: 0 };
    let isDragging = false, dragStart = { x: 0, y: 0 }, startPos = { x: 0, y: 0 };

    // Centre the source: cover the crop box (crop mode) or contain it (preview).
    function fit() {
        if (!imageElement) return;
        natural = { w: imageElement.naturalWidth, h: imageElement.naturalHeight };
        if (!natural.w || !natural.h) return;
        scale = doCrop
            ? Math.max(cropSize.width / natural.w, cropSize.height / natural.h)
            : Math.min(cropSize.width / natural.w, cropSize.height / natural.h);
        pos = { x: (cropSize.width - natural.w * scale) / 2, y: (cropSize.height - natural.h * scale) / 2 };
    }

    function startDrag(e) {
        if (!doCrop) return;
        e.preventDefault();
        isDragging = true;
        dragStart = { x: e.clientX, y: e.clientY };
        startPos = { ...pos };
    }
    function onMove(e) {
        if (!isDragging) return;
        pos = { x: startPos.x + (e.clientX - dragStart.x), y: startPos.y + (e.clientY - dragStart.y) };
    }
    function onUp() { isDragging = false; }
    function zoom(delta) {
        if (!doCrop) return;
        const next = Math.max(0.05, Math.min(scale + delta, 20));
        const k = next / scale;
        const cx = cropSize.width / 2, cy = cropSize.height / 2;
        pos = { x: cx - (cx - pos.x) * k, y: cy - (cy - pos.y) * k };
        scale = next;
    }

    // Source-pixel rect currently framed by the crop box (null = whole image).
    function selectionRect() {
        if (!doCrop || !natural.w) return null;
        const sx = Math.max(0, Math.round(-pos.x / scale));
        const sy = Math.max(0, Math.round(-pos.y / scale));
        const sw = Math.min(Math.round(cropSize.width / scale), natural.w - sx);
        const sh = Math.min(Math.round(cropSize.height / scale), natural.h - sy);
        return { x: sx, y: sy, width: Math.max(1, sw), height: Math.max(1, sh) };
    }
    // Reactive: recompute when pan/zoom/size change (deps referenced explicitly).
    $: sel = (pos, scale, natural, cropSize, imageElement ? selectionRect() : null);

    // Displayed output dimensions per the crop x scale matrix.
    function outputDims(s) {
        const cfgW = options?.width, cfgH = options?.height;
        if (doScale) {
            if (doCrop) {
                const r = s || { width: cropSize.width, height: cropSize.height };
                if (cfgW && cfgH) return { w: cfgW, h: cfgH };
                if (cfgW) return { w: cfgW, h: Math.round(cfgW * r.height / r.width) };
                if (cfgH) return { h: cfgH, w: Math.round(cfgH * r.width / r.height) };
                return { w: r.width, h: r.height };
            }
            let k = 1;
            if (cfgW) k = Math.min(k, cfgW / natural.w);
            if (cfgH) k = Math.min(k, cfgH / natural.h);
            k = Math.min(1, k);
            return { w: Math.max(1, Math.round(natural.w * k)), h: Math.max(1, Math.round(natural.h * k)) };
        }
        if (doCrop && s) return { w: s.width, h: s.height };
        return { w: natural.w, h: natural.h };
    }
    $: dims = natural.w ? outputDims(sel) : null;

    const confirm = () => dispatch('confirm', { image: imageElement, selection: selectionRect() });
    const cancel = () => dispatch('cancel');

    // Render at <body> level so the fixed overlay escapes the CMS edit-tray's
    // transform (which would otherwise become its containing block / clip it).
    function portal(node) {
        document.body.appendChild(node);
        return { destroy() { if (node.parentNode) node.parentNode.removeChild(node); } };
    }
</script>

<svelte:window on:mousemove={onMove} on:mouseup={onUp} />

<div class="crop-modal" use:portal on:mousedown|self={cancel}>
    <div class="panel">
        <h3>{doCrop ? 'Crop image' : 'Optimise image'}</h3>
        <p class="hint">{doCrop ? 'Drag to pan • scroll or buttons to zoom' : 'Preview of the optimised output'}</p>

        <div class="stage" class:dragging={isDragging} style="width:{cropSize.width}px;height:{cropSize.height}px;"
             on:mousedown|stopPropagation={startDrag}
             on:wheel|preventDefault|stopPropagation={(e) => zoom(e.deltaY > 0 ? -0.1 : 0.1)}>
            <img bind:this={imageElement} src={imageUrl} alt="crop source" class="src"
                 style="transform:translate({pos.x}px,{pos.y}px) scale({scale});transform-origin:0 0;"
                 on:load={fit} draggable="false" />
            {#if doCrop && showGrid}
                <div class="grid">{#each Array(9) as _}<i></i>{/each}</div>
            {/if}
        </div>

        {#if showCoords && dims}
            <div class="readout">
                {#if doScale}Output: {dims.w}×{dims.h}px{:else}Size: {dims.w}×{dims.h}px (source){/if}
                {#if options?.convert} → {options.convert.toUpperCase()}{/if}
                {#if locked} • aspect locked{/if}
            </div>
        {/if}

        {#if doCrop}
            <div class="zoom">
                <button type="button" on:click|preventDefault={() => zoom(-0.2)}>−</button>
                <span>{Math.round(scale * 100)}%</span>
                <button type="button" on:click|preventDefault={() => zoom(0.2)}>+</button>
                <button type="button" class="reset" on:click|preventDefault={fit}>Reset</button>
            </div>
        {/if}

        {#if error}<div class="err">⚠️ {error}</div>{/if}

        <div class="actions">
            <button type="button" class="secondary" on:click|preventDefault={cancel} disabled={processing}>Cancel</button>
            <button type="button" class="primary" on:click|preventDefault={confirm} disabled={processing}>
                {processing ? 'Processing…' : (doCrop ? 'Apply crop' : 'Apply')}
            </button>
        </div>
    </div>
</div>

<style>
    .crop-modal {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, .6);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 2000;
    }
    .panel {
        background: #fff;
        border-radius: 8px;
        padding: 20px;
        max-width: 90vw;
        box-shadow: 0 10px 40px rgba(0, 0, 0, .3);
        text-align: center;
    }
    h3 { margin: 0 0 4px; }
    .hint { margin: 0 0 14px; color: #666; font-size: .85rem; }
    .stage {
        position: relative;
        margin: 0 auto;
        overflow: hidden;
        border: 2px solid #1c7fc7;
        background: #f4f4f4 repeating-conic-gradient(#e9e9e9 0% 25%, #fff 0% 50%) 0 / 20px 20px;
        cursor: grab;
    }
    .stage.dragging { cursor: grabbing; }
    .src { position: absolute; top: 0; left: 0; user-select: none; pointer-events: none; max-width: none; }
    .grid {
        position: absolute;
        inset: 0;
        display: grid;
        grid-template: repeat(3, 1fr) / repeat(3, 1fr);
        pointer-events: none;
    }
    .grid i { border: 1px solid rgba(255, 255, 255, .4); }
    .readout { margin: 10px 0 0; font-size: .8rem; color: #333; }
    .zoom { display: flex; align-items: center; justify-content: center; gap: 8px; margin: 12px 0; }
    .zoom button { width: 32px; height: 32px; border: 1px solid #ccc; border-radius: 4px; background: #fff; cursor: pointer; }
    .zoom .reset { width: auto; padding: 0 12px; }
    .zoom span { min-width: 48px; }
    .err { color: darkred; margin: 8px 0; font-size: .85rem; }
    .actions { display: flex; gap: 10px; margin-top: 14px; }
    .actions button { flex: 1; padding: 10px; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; }
    .actions .primary { background: #1c7fc7; color: #fff; }
    .actions .secondary { background: #e7e7e7; }
</style>
