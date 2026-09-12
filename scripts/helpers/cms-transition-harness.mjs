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
    const exported = [], destroys = [], events = [];
    const hooks = {
        onMount: () => {},
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
            declarations.push(source.slice(node.declaration.start, node.declaration.end));
            for (const d of node.declaration.declarations) exported.push(d.id.name);
        } else if (node.type === 'LabeledStatement' && node.label.name === '$') {
            reactive.push(source.slice(node.body.start, node.body.end));
            const expression = node.body.expression;
            if (expression?.type === 'AssignmentExpression' && expression.left.type === 'Identifier') {
                implicit.add(expression.left.name);
            }
        } else declarations.push(source.slice(node.start, node.end));
    }
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
    return { ...api, events, destroy: () => destroys.forEach(fn => fn()) };
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
