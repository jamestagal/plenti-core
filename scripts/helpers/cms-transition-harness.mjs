// DOM-less handler harness. Uses the bundled Svelte parser to run the ACTUAL
// instance script; it does not copy handlers or model Svelte's scheduler/DOM.
// Tests explicitly flush reactive statements after public prop changes. Browser
// checks remain necessary for event binding, scheduling, and rendering evidence.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const { parse } = createRequire(import.meta.url)('../../defaults/node_modules/svelte/compiler.js');
const cms = new URL('../../defaults/core/cms/', import.meta.url);
export const moduleURL = async (file, replacements = {}) => {
    let source = await readFile(new URL(file, cms), 'utf8');
    for (const [from, to] of Object.entries(replacements)) source = source.replaceAll(from, to);
    return 'data:text/javascript,' + encodeURIComponent(source);
};
const engineURL = await moduleURL('crop-engine.js');
const pendingURL = await moduleURL('pending_media.js', {
    "'./crop-engine.js'": JSON.stringify(engineURL),
    "'svelte/store'": JSON.stringify(new URL('../../defaults/node_modules/svelte/store/index.mjs', import.meta.url).href),
});
export const { pendingMedia } = await import(pendingURL);
const modules = {
    'crop-engine.js': await import(engineURL),
    'pending_media.js': { pendingMedia },
    'media_checker.js': await import(await moduleURL('media_checker.js')),
    'upload_context.js': await import(await moduleURL('upload_context.js')),
    'upload_queue.js': await import(await moduleURL('upload_queue.js')),
    'library_optimise.js': await import(await moduleURL('library_optimise.js')),
};

export async function component(file, props, bridge) {
    const source = await readFile(new URL(file, cms), 'utf8');
    const nodes = parse(source).instance.content.body;
    const bindings = {}, declarations = [], reactive = [], implicit = new Set();
    const exported = [], mounts = [], destroys = [], events = [];
    const hooks = {
        onMount: fn => mounts.push(fn),
        onDestroy: fn => destroys.push(fn),
        createEventDispatcher: () => (type, detail) => events.push({ type, detail }),
    };
    for (const node of nodes) {
        if (node.type === 'ImportDeclaration') {
            const name = node.source.value.split('/').pop();
            const module = node.source.value === 'svelte' ? hooks : modules[name];
            for (const specifier of node.specifiers) {
                if (name.endsWith('.svelte')) bindings[specifier.local.name] = null;
                else {
                    const value = module?.[specifier.imported?.name];
                    if (value === undefined) throw new Error('Unmapped import: ' + specifier.local.name);
                    bindings[specifier.local.name] = value;
                }
            }
        } else if (node.type === 'ExportNamedDeclaration') {
            for (const d of node.declaration.declarations) {
                const name = d.id.name;
                const fallback = d.init ? source.slice(d.init.start, d.init.end) : 'undefined';
                declarations.push(`let ${name} = Object.hasOwn(props, '${name}') ? props.${name} : (${fallback});`);
                exported.push(name);
            }
        } else if (node.type === 'LabeledStatement' && node.label.name === '$') {
            reactive.push(source.slice(node.body.start, node.body.end));
            const expression = node.body.expression;
            if (expression?.type === 'AssignmentExpression' && expression.left.type === 'Identifier') {
                implicit.add(expression.left.name);
            }
        } else declarations.push(source.slice(node.start, node.end));
    }
    bindings.pendingMedia = pendingMedia;
    const script = `
        ${declarations.join('\n')}
        let ${[...implicit, '$pendingMedia'].join(', ')};
        const propSetters = { ${exported.map(n => `${n}: value => ${n} = value`).join(',')} };
        const flush = () => { $pendingMedia = []; pendingMedia.subscribe(v => $pendingMedia = v)();
            ${reactive.join('\n')}
        };
        for (const [key, value] of Object.entries(props)) propSetters[key](value);
        flush();
        return { ${bridge}, set(props) {
            for (const [key, value] of Object.entries(props)) propSetters[key](value);
            flush();
        } };
    `;
    const api = new Function(...Object.keys(bindings), 'props', script)(...Object.values(bindings), props);
    return { ...api, events, mount: () => mounts.forEach(fn => fn()), destroy: () => destroys.forEach(fn => fn()) };
}

export function controlledImages() {
    const original = globalThis.Image;
    const loads = [];
    globalThis.Image = class {
        set src(src) { this.url = src; loads.push(this); }
        get src() { return this.url; }
    };
    return {
        loads,
        resolve(image, width = 500, height = 300) {
            image.naturalWidth = width; image.naturalHeight = height; image.onload();
        },
        reject(image) { image.onerror(); },
        restore() { globalThis.Image = original; },
    };
}

// Drain handler promise continuations without wall-clock sleeps.
export const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

// Minimal DOM boundary for the real preview patcher: src mutations are delivered
// asynchronously, like MutationObserver. No browser rendering is simulated.
export async function previewPage() {
    const originalDocument = globalThis.document;
    const originalObserver = globalThis.MutationObserver;
    const elements = [], observers = new Set();
    const changed = () => {
        for (const observer of observers) {
            if (observer.queued) continue;
            observer.queued = true;
            queueMicrotask(() => {
                observer.queued = false;
                if (observers.has(observer)) observer.callback();
            });
        }
    };
    globalThis.MutationObserver = class {
        constructor(callback) { this.callback = callback; }
        observe() { observers.add(this); }
        disconnect() { observers.delete(this); }
    };
    globalThis.document = { body: {}, querySelectorAll: () => elements.filter(el => el.isConnected) };
    const patcher = await import(await moduleURL('preview_patcher.js', {
        "'./pending_media.js'": JSON.stringify(pendingURL),
    }));
    let stop;
    return {
        element(src, tagName = 'IMG') {
            const attributes = new Map([['src', src]]);
            const el = {
                tagName, isConnected: true,
                getAttribute: name => attributes.get(name) ?? null,
                setAttribute(name, value) {
                    const previous = attributes.get(name); attributes.set(name, value);
                    if (name === 'src' && previous !== value) changed();
                },
                removeAttribute(name) { attributes.delete(name); if (name === 'src') changed(); },
            };
            elements.push(el); changed(); return el;
        },
        start() { stop = patcher.startPreviewPatcher(); },
        stop() { stop?.(); stop = null; },
        restore() {
            stop?.();
            globalThis.document = originalDocument;
            globalThis.MutationObserver = originalObserver;
        },
    };
}
