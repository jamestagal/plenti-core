# ADR 0001 — Client-side image crop / scale / convert for Plenti

- **Status:** Proposed
- **Date:** 2026-06-30
- **Author:** Ben Waller
- **Upstream issue:** [plentico/plenti#364 — "Crop and scale images"](https://github.com/plentico/plenti/issues/364) (opened by @jimafisk, 2025-05-30)
- **Related work in flight:** [plentico/plenti#375 — CMS auth/token/endpoint overrides](https://github.com/plentico/plenti/pull/375) (from `plenti-core`, awaiting review — see "Interaction with #375")
- **Prototype reference:** the `Plenti-image-crop` site (`CROP_INTEGRATION_CHANGELOG.md`, `IMAGECROP_IMPLEMENTATION_PLAN.md`) — the original ejected prototype this feature ports from

---

## Context

### Origin of the prototype
A working image-crop prototype was built into the `Plenti-image-crop` **site** by ejecting Plenti's core CMS files and inlining the crop logic. It was authored against **Plenti v0.7.14** (Oct 30 2024). The prototype proved the concept but:

- inlined ~2,800 lines into two core files — `core/cms/fields/media.svelte` (71 → 1,346) and `core/cms/file_upload.svelte` (205 → 1,727) — because **Plenti cannot import *new* `.svelte` files into an ejected site** (only files that shadow an existing default are compiled);
- carries ~96 `console.log` debug statements;
- has a known unresolved binding bug for object-format media nested through `Fieldset`;
- **outputs at the on-screen crop-box size (~400 px), not schema-defined dimensions**, and **preserves the source format** rather than converting — i.e. the two things #364 actually wants (`scale`, `convert`) are the gaps.

### Why it broke (the trigger for this work)
Homebrew bumped the local `plenti` binary from v0.7.14 → **v0.7.21**. Two upstream changes broke the ejected site:
1. **v0.7.15** refactored publishing: `publish.js` + `post_local.js` → `core/cms/providers/{gitlab,gitea,local}.js`. The ejected `button.svelte` still imported the old paths → Gopack build failure.
2. A **`/postlocal` `file-path` validator was added after v0.7.14** (`cmd/serve.go`), restricting writes to `content/**.json`. The crop feature writes `media/*.webp` → rejected at runtime with a plain-text Go validator error (`Key: 'localChange.File'…`), which the client mis-parses as JSON.

> **Discovered during review:** because the existing media **upload** path also writes to `media/` through `Button → provider → /postlocal`, that validator has been silently rejecting **all local media uploads** since it was added, not just crop. Mirroring `media_checker.js`'s media set in the validator (D6) therefore *restores local uploads* in addition to enabling crop.

### Version boundary (established by inspecting upstream tags)
| Version | `publish.js`/`post_local.js` | `providers/` | `/postlocal` `file-path` validator |
|---|---|---|---|
| v0.7.14 (fork base) | ✅ present | ❌ | ❌ none (media writes allowed) |
| v0.7.15 | ❌ removed | ✅ | — |
| v0.7.21 (was installed) / v0.7.25 (latest) | ❌ | ✅ | ✅ `content/**.json` only |

`media.svelte` / `file_upload.svelte` / `dynamic_form_input.svelte` are **byte-identical across v0.7.14 → v0.7.25** — the media components never moved, so the work layers cleanly onto current Plenti.

### Maintainer intent
#364 (by Jim) asks for **exactly this**: client-side `<canvas>` crop/scale/convert, configured in `_schema.json`, written to Git before placement. His primary motivation is **performance** (a 5,000 px upload served where 500 px is needed). His sketched schema:
```json
{ "my_image_field": { "type": "media",
  "options": [ { "width": 500, "height": 300, "scale": true, "crop": true, "convert": "webp" } ] } }
```

### Future-architecture constraint (Pico/Pattr)
Plenti is migrating off Svelte to a native Go templating stack:
- **Pico** — Go compiler; `.pico` → `markup`/`script`/`style`; fence JS runs server-side via Goja. **No bundler, no ESM module resolution.** Client JS ships as plain static `<script>` assets.
- **Pattr** — Alpine-like reactive runtime (`pattr.js`); reactivity via `p-*` attributes / inline `onclick="{expr}"`.
- The new CMS (`pico-tests/site/views/cms.pico`) is a **generic key/value form generator with no media/upload/crop surface yet**, and **no save/commit mechanism yet**.
- **Cropping is client-side (Canvas); the migration is server-side rendering — orthogonal.** The transformation module never touches Pico's Go renderer.

---

## Decisions

**D1 — Do not pin/downgrade Plenti.** `brew pin` is global, would freeze every project and block `brew upgrade`. Target current Plenti instead. *(The local site was migrated to build on v0.7.21 — done.)*

**D2 — Build the feature in the `plenti-core` fork, not as ejected site files.** Only the source repo's `defaults/` allows adding *new* files (killing the inline-2,800-line constraint) and only it can carry the Go change. Branch `feat/image-crop` off `master`, isolated from `feat/cms-endpoint-overrides` (#375).

**D3 — Architecture = a browser *transformation module* + a thin host shell.** `crop-engine.js` is dependency-free and framework-agnostic, but it is **not "pure"**: it depends on the browser Canvas/DOM API and attaches one guarded `window` global. It **transforms only** — crop/scale/convert + filename — and **does not persist**. Validated against Pico/Pattr: the module survives the Svelte→Pico migration untouched; only the shell is rewritten.

**D4 — Delivery shape:** single dependency-free file, **ESM named exports + a non-clobbering `window.PlentiImage` attach** (`Object.assign(window.PlentiImage ||= {}, …)`), loadable as `<script type="module">`.
- Today (Svelte CMS): `import { transformImage, parseImageOptions } from './crop-engine.js'`.
- Future (Pico CMS): copy to `static/`, `<script type="module" src="/crop-engine.js">` beside `pattr.js`; inline Pattr handlers reach `PlentiImage.*`.

**D5 — Persistence is owned by the host, through Plenti's existing provider pipeline.** The module returns an encoded result (`{ blob, filePath, … }`); the **shell** converts the blob into the existing commit-item shape (`{ file, contents }`) and submits it through the provider-aware `Button → { postLocal | commitGitlab | commitGitea }`. This reuses Plenti's authentication, save-status UI, and per-provider commit logic, and works on local **and** GitLab/Gitea deployments — which a module-owned `/postlocal` call never would.
- The local provider (`providers/local.js`) currently parses failed `/postlocal` responses as JSON though the server returns plain text — a real existing bug; fix it to read `.text()` on `!res.ok`.
- **Eager vs deferred write is a Part-3 decision.** Default: **deferred** into the normal page-save commit (preserves provider behaviour, avoids orphaned cropped files when an editor cancels). Eager write (immediate media-library availability) is defensible but must call a **shared provider-dispatch helper**, not reproduce `Button` logic.

**D6 — The server change is required, and is *local-provider-only*.** GitLab/Gitea commit media through their Git APIs and never hit `/postlocal`; only the local dev provider does. So the `cmd/serve.go` change affects local serving only. Replace the single regex (which also wrongly matched `mediaevil.webp` / `contentbackup.json` — no required slash) with explicit validation that mirrors `media_checker.js`'s media set:
- `content/…\.json`, **or** `media/…\.<ext>` where `<ext>` ∈ the `media_checker.js` image+doc set (`jpg jpeg png webp gif svg avif apng pdf msword`). Mirroring `media_checker` keeps server and client agreeing on "what is media" and restores local uploads. *(Keep the two lists in sync — flag as a maintenance note in the PR.)* This **restores the existing upload policy** rather than asserting every type is safe: SVG can carry script and is served as-is, so sanitising user-uploaded SVG is a separate, out-of-scope concern flagged for the maintainer.
- Reject empty/absolute paths and any path that changes under `filepath.Clean` (blocks `..`).
- **Handler hardening (same commit, hunks splittable for Jim):** return non-2xx on JSON-decode / base64-decode / write failures (today it logs and still returns 200, so a client sees success after a failed write); `http.MaxBytesReader` with a named `maxPostLocalRequestBytes = 64 << 20` (base64 inflates a ~30 MiB image to ~40 MiB + JSON overhead — the limit is on the request, not the decoded image); `405` for non-POST; create the validator **once** (not per request); write files `0644` (not `os.ModePerm`); all errors via plain-text `http.Error` so `providers/local.js`'s `.text()` reader gets a clean message.

**D7 — Scope = crop + scale + convert (the #364 core),** governed by the crop×scale matrix below. Output filename encodes **output dimensions + actual output extension**: `media/perry-500x300.webp` (re-crops strip a prior `-WxH` / `-cropped-WxH` suffix instead of stacking).

**D8 — Schema shape is the one open maintainer call.** `parseImageOptions(schema, fieldKey)` accepts **both** Jim's `options:[{…}]` and the prototype's `crop:{…}`, so the demo runs today and the final shape is decoupled from the module core.

**D9 — Output formats & browser fallback.** Supported **output** encoders: `jpeg`, `png`, `webp`, `avif`. **WebP/AVIF encoding is browser-dependent**; PNG is the guaranteed canvas fallback, and the **actual `blob.type` is authoritative** for the saved filename (so a webp request that silently falls back to PNG is saved—and named—as PNG, and the UI is told). **GIF is not an output target** (canvas cannot encode it). **Animated sources (gif/apng) flatten to a single still frame** when transformed — documented behaviour. (The server media-write allowlist in D6 is broader than this output set because it must also accept existing *uploads*.)

---

## Crop × scale semantics (the behaviour contract)

| `crop` | `scale` | behaviour |
|---|---|---|
| true | true | crop to the selection, then resize to configured `width`×`height`. **Reject** if the selection aspect ≠ output aspect (small tolerance). |
| true | false | crop to the selection; output = the selection's source-pixel dimensions (no resize). |
| false | true | whole image, **contain** within `width`×`height` — preserve aspect, **no padding, no upscale**. |
| false | false | whole image at original dimensions; format conversion only. |

**Edge cases:**
- `width` only → derive `height`; `height` only → derive `width`; **neither** → original dimensions; **both** → fit within the bounding box.
- `crop:true` **requires** a selection — error if absent; never silently fall back to the whole image.
- `crop:true` + `scale:true` with **only one** output dimension → derive the other from the selection ratio (no mismatch rejection needed).
- **contain** (`crop:false`+`scale:true`) treats `width`/`height` as **maximum** bounds, not a mandatory canvas: `5000×3000` into `500×500` → `500×300`; never letterboxes, never upscales beyond the source.
- Converting a transparent source (e.g. PNG) to JPEG fills a configurable `background` (default `#ffffff`) before drawing, since JPEG has no alpha.
- Output dimensions are always positive integers; an over-large request (`> MAX_OUTPUT_PIXELS`) is rejected.

---

## Architecture

```
crop-engine.js  (dependency-free browser transformation module — the durable asset; D3)
  parseImageOptions(schema, fieldKey)         -> normalized opts | null            // adapter (D8)
  renderImage(img, selection, output)         -> { blob, mime, width, height }     // crop+scale+convert, 1 drawImage
  outputFilename(srcPath, {width,height,ext}) -> "media/perry-500x300.webp"
  transformImage(img, selection, opts, src)   -> { blob, filePath, width, height,  // applies the matrix; NO save (D5)
                                                   requestedMime, actualMime,
                                                   formatFallback, converted, bytes }

host shell (thin, per-framework)
  - now:   Svelte modal in defaults/core/cms/fields/ — crop UI, calls transformImage,
           builds { file, contents } and submits via Button -> provider (D5)
  - later: a .pico component + Pattr attributes + global-attach glue, same module

server cmd/serve.go (local provider only; D6)
  - explicit path validation mirroring media_checker.js + handler hardening
```

---

## Open question (for Jim) — one remains

**Schema shape** — `options:[{width,height,scale,crop,convert}]` (his sketch) vs `crop:{…}` (prototype)? The module accepts both today; he picks the canonical one. *(Write-allowlist and no-stretch are resolved above: mirror `media_checker`; reject distortion.)*

---

## Required tests before the PR
1. `null` and `undefined` selection both use the whole image (regression: the `num(null)`→`0`→1×1 bug).
2. A selection at/beyond an image edge never yields zero width/height.
3. `scale:false` preserves the selected source-pixel dimensions.
4. `crop:false` ignores any supplied selection (whole-image contain).
5. `crop:true` with no selection is an error (no silent whole-image fallback).
6. Fractional schema dimensions become consistent integers (metadata == bitmap == filename).
7. Aspect mismatch (`crop:true`+`scale:true`, both dims) is rejected, not stretched.
8. Unsupported output encoding (e.g. webp on old Safari) yields a correctly **named PNG** + `formatFallback:true`.
9. `.jpeg → image/jpeg` is **not** reported as `converted`.
10. Transparent input → JPEG gets the configured background.
11. Path validation accepts `media/foo.webp`, rejects `mediaevil.webp`, `../media/foo.webp`, absolute paths, unsupported extensions.
12. A local write/decode error reaches the UI as a **failed** save (server non-2xx + provider `.text()`).
13. The transformed commit item saves through local **and** (smoke) the GitLab/Gitea provider dispatch.

---

**D10 — Auto-process on field update (the #364 behaviour).** The primary trigger is **selecting/uploading a new image into a schema-configured media field**, not a manual button:
- no image options → assign the path (unchanged);
- `crop:true` → auto-open the crop modal on the new source (cancel reverts to the previous value — an uncropped large image must not be left in a crop:true field);
- `crop:false` → auto-optimise immediately (contain/convert), no modal;
- a failed transform keeps the previous field value + shows an inline error.

This holds for **both entry points into a configured field**:
- *Library pick* (an existing path) — handled via the `changingMedia` reactive.
- *Fresh upload* (a `File`) — `file_upload.svelte` runs in a field-scoped mode (registered through the `fieldUploadHandler` store) that hands the `File` to the field **instead of eager-saving the original**; the field processes it and queues only the derivative, so the untouched original never reaches Git. The handler is cleared on modal close, so the standalone Media library and no-option fields keep their eager upload behaviour.

The manual Crop/Optimise button remains as a re-process surface. **Direct Media-Library crop (cropping an arbitrary library image with no field/schema context) is a separate, secondary enhancement** — it can't know which field's dimensions/format to enforce.

## Implementation plan (all committed on `feat/image-crop`)
- **Server (`cmd/serve.go`):** explicit `/postlocal` validation (mirrors `media_checker.js`) + handler hardening (D6).
- **`crop-engine.js`:** transform-only module + the matrix + dependency-free tests (D3/D7/D9).
- **Deferred-persistence foundation:** `providers/commit.js` (shared dispatch), per-item action/encoding in all providers, `pending_media.js` store, Button `beforeSubmit` merge (D5).
- **Field integration:** `image_crop_modal.svelte` + `media.svelte` (schema resolution, source-path distinction, object dual-format, preview persistence) + `media_checker.js` guard.
- **Auto-process on update (D10)** — for library picks and fresh uploads (`field_upload.js` store + `file_upload.svelte` field-scoped mode).

### Acceptance — verified in a clean fixture site (browser + disk)
1. ✅ Select a 5000px JPEG into `crop:true` `hero_string` → modal **auto-opens** on that source; confirm → derivative + content committed in **one** provider commit. Byte proof: 5000px JPEG → 500×300 WebP = **98.8%** (388,409 → 4,862 b).
2. ✅ Select it into `crop:false` `banner_contain` → **auto 500×300 derivative, no modal** = **97.7%** (388,409 → 9,110 b, jpg preserved — no `convert`).
3. ✅ **Upload** a fresh 5000px JPEG into `crop:true` `hero_string` → crop modal opens **on the upload before any request**; into `crop:false` `banner_contain` → derivative, no modal. Page save writes **only** the derivatives; the original `fresh-upload.jpg` **never appears in `media/`**. Cancel makes no commit and keeps the previous value.
4. ✅ Object media: `src` updated, `alt` preserved; re-crop uses the **original** source + replaces (no duplicate); GIF flattens to a still webp; ordinary fields unchanged.
5. ✅ Engine unit tests (22) + `/postlocal` curl matrix all green.

---

## Interaction with #375
#375 (CMS auth/token/endpoint overrides) touches the remote-commit/auth area; this feature's server change is **local-provider-only**, so they are largely orthogonal. `feat/image-crop` branches off `master` (no #375), and rebases as upstream lands.

---

## Status of work so far
Committed on `feat/image-crop`: ADR + pipeline doc → server hardening → `crop-engine.js` + tests → `providers/local.js` fix → deferred-persistence foundation → field-crop modal integration → auto-process-on-update → **field-scoped upload pre-processing**.

The select **and** upload paths into a configured field now process the image before it is saved to the repository.

**Remaining before a PR:**
- ⏳ GitLab/Gitea dispatch is **code-verified only** (per-item `?? action` fallback preserves existing behaviour); exercise the real remote provider path — for both a library pick and a fresh upload — before claiming it in the PR.
- ⏳ Schema shape (`options[]` vs `crop{}`) — settle with Jim (the parser accepts both today).
- ⏳ Optional follow-up: direct Media-Library crop controls (D10).
- ⏳ Decide whether JS engine/store tests live in-repo and how they run in CI.
