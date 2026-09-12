# #364 Media-Library gateway — acceptance traceability matrix

Maps each acceptance case from the implementation plan to the **lowest reliable
test layer** that proves it. Layers:

- **engine** — `scripts/test-crop-engine.mjs` (pure `transformImage` matrix)
- **gateway** — `scripts/test-library-optimise.mjs` (hashed identity, MIME, collisions)
- **queue** — `scripts/test-upload-queue.mjs` (ordering, gating, cancellation, teardown)
- **provider** — `scripts/test-providers.mjs` (per-item create/upsert; failure contract)
- **browser** — manual fixture smoke on the built binary serving `crop-fixture`
  (integration: modal flow, ownership handoff, grid reuse, stale-context reset).
  Browser cases are integration behaviours that cannot be unit-tested without
  mocking away the very Svelte reactivity + provider wiring under test.
- **remote** — live GitLab/Gitea smoke (update semantics + Gitea partial-batch caveat)

Run the automated suites:

```
deno run --allow-read scripts/test-crop-engine.mjs       # engine
deno run --allow-read scripts/test-library-optimise.mjs  # gateway
deno run --allow-read scripts/test-upload-queue.mjs      # queue
deno run -A            scripts/test-providers.mjs         # provider
go build ./...                                            # Go + CMS embed
```

| # | Acceptance case | Layer | Test / evidence | Status |
|---|---|---|---|
| 1 | After provider success, `media[]` holds a `media/…` path, never `data:` | browser | Slices 1–4: content JSON `data:image` count = 0 after every save | ✅ |
| 2 | Optimised image adds hashed `media/name-<hash>-WxH.webp`, longest edge ≤ 2048, byte reduction | engine + gateway | `C-MAX1/2/3` (contain, no upscale); `hashed name shape`; browser: `big-photo-01e60f1b…-2048x1229.webp` 388KB→64KB | ✅ |
| 3 | Passthrough raw PDF/GIF/SVG adds `media/name.ext` as a PATH; animation survives | browser | Slice 4: `sample.pdf`/`logo.svg`/`anim.gif` byte-identical, GIF stayed 89a-animated | ✅ |
| 4 | Provider failure adds no library item, no field change; modal stays actionable | browser + provider | Slice 5 Path-1 (field-launched: field unchanged, media[] unchanged, no disk write, modal open with "Save failed (500)"); provider layer: `HEAD 403 aborts`, `no commit POST after abort`, `local non-2xx → thrown` | ✅ |
| 5 | Field auto-return: canonical hashed path enters `media[]` and is fed to field schema | browser | Slice 2; Slice 5 Path-2 (path returned → field crop opened) | ✅ |
| 6 | WebP success: `.webp` name, `image/webp` blob, `data:image/webp` transport prefix | gateway | `webp` (extForMime + fingerprint mime) | ✅ |
| 7 | Encoder fallback: requested-webp → PNG yields `.png`, `image/png`, `data:image/png` | gateway | `png fallback`, `fallback ext from mime` | ✅ |
| 8 | Immediate reuse without reload → content JSON gets the PATH, no `data:image/` | browser | Slices 1–4 (grid reuse; `data:image` = 0) | ✅ |
| 9 | Duplicate paths deduped at BOTH levels (`localMediaList` ≤1/path; `media[]` ≤1) | queue + browser | `addOrReplaceCommitItem` (component) + `new Set` in `addUploadsToLibrary`; browser: re-crop replaced, no dup rows | ✅ |
| 10 | Field-launched into `crop:true` shows EXACTLY ONE interactive crop (the field's) | browser | Slice 5 Path-2: gateway optimise-only (no crop toggle), then one field crop modal | ✅ |
| 11 | Field-launched PDF/GIF/SVG eagerly saves (`create`) and auto-returns its path | browser | Slice 2 passthrough path; provider `create` semantics | ✅ |
| 12 | Per-item action: passthrough `create`, derivative `upsert`, in the same commit list | provider + browser | GitLab/Gitea/local `create` vs `update`/`upsert`; Slice 4 mixed batch (derivatives upsert, PDF/SVG/GIF create) | ✅ |
| 13 | Re-uploading a raw passthrough filename stays `create` (Gitea/GitLab reject conflicts; local dev still overwrites) | provider | `absent derivative → create`; per-item `action ?? action` honoured | ✅ intent; local collision protection not implemented |
| 14 | Collision, all three: diff-source/same-dims → diff; diff-crop/same-dims → diff; same → same | gateway | `same source+crop+opts → SAME`, `different source bytes → DIFFERENT`, `different crop rect → DIFFERENT`, `two sources same stem+dims → DIFFERENT paths` | ✅ |
| 15 | Standalone wording truthful: "Add optimised image" ≠ persisted until "Save Media" | browser | Slice 1/4: Add queues; Save Media commits (separate clicks) | ✅ |
| 16 | Partial-failure honesty: canonical save OK but field processing fails → asset stays, previous field value retained, UI reports field/assignment failure (not "upload failed") | browser | Slice 5 Path-2: `fail-path2-…webp` on disk, media modal already closed, field-crop error "source image … invalid dimensions" (transform failure, not upload) | ✅ |
| 17 | Queue cancellation: Cancel current advances; Cancel all clears + closes; Save disabled while unresolved; URLs revoked on cancel/confirm/next/destroy | queue + browser | `late resolve on cancelled REJECTED`, `all non-saved → cancelled`, `every url revoked`, `canSave false while failed remains`; Slice 4: Skip advanced 1/3→2/3, Cancel-all cleared, 0 `cancel-test-*` on disk, 0 leaked blob URLs | ✅ |
| 18 | Max-dimension display matches engine; never presents 2048×2048 as a forced exact | engine + browser | `C-MAX1` (800×600→400×300, not 400×400); browser readout "Output: 2048×1229px" for a 5000×3000 landscape source | ✅ |
| 19 | Stale-context guard: after closing a field picker, a later standalone upload does NOT fire the old `onSavedPath` | browser | Slice 2 (uploadContext reset in `finishFieldUpload`); Slice 5 standalone batch after field session assigned to no field | ✅ |
| 20 | Regressions: providers 22/22, engine (+maxW/H) green, `go build ./...` exit 0; field crop-via-`pendingMedia` still deferred to page save | all | engine 27, gateway 12, queue 33, providers 22; `go build ./...` exit 0 | ✅ |

## Notes on layering choices

- **Cases 4 & 16** are the two ownership-boundary behaviours established in Slice 2.
  They are *integration* behaviours (Svelte reactivity + `commit()` + the
  `file_upload → media_modal → media.svelte` handoff). The reliable proof layer is
  the **browser fixture**, forcing the failures with a one-shot `/postlocal` 500
  (Path-1) and a one-shot `getContext→null` transform failure (Path-2). The
  **provider layer** independently proves the request-side of failure (abort → no
  write; onSave never fires on partial failure), so the two layers together cover
  "nothing persists on failure" from both ends.
- **Cases 9 & 18** have pure logic (`addOrReplaceCommitItem`, the modal's
  `outputDims`) that lives inside `.svelte` components. Rather than extract them
  (new refactoring — out of scope for a hardening slice), their behaviour is proven
  in the browser and their engine-mirrored halves (`C-MAX*`) are unit-tested.

## Remote smoke (live GitLab/Gitea) — see `364-remote-smoke.md`

Cases 12/13 have a remote dimension (real `upsert`=update on a live host, and the
documented Gitea sequential partial-batch caveat) captured separately so this
matrix stays runnable without network credentials.

## Slice 6 revision (post-review hardening)

A high-effort review confirmed 15 findings against the first implementation; Slice 6
(commits `8442175`, `937c4de`, `185dcc2` + docs) fixes them. Rows affected:

| # | Change |
|---|---|
| 4 | The STANDALONE side is now browser-proven too: a one-shot `/postlocal` 500 on Save Media leaves `media[]` unpolluted (mutation moved to Button's success-only `afterSubmit`), the staged batch is RETAINED (opt-in `retainCommitListOnFailure`), and the retry commits. |
| 9 | Dedup is structural now: the Save list is DERIVED from resolved queue items through a keyed payload store (one payload per item id) — `addOrReplaceCommitItem` is gone. |
| 15 | Labels updated: standalone queue Cancel = "Skip this file"; batch action = "Skip remaining" (retains approved work — drops pending AND failed). |
| 17 | Cancellation semantics revised per owner decision: `skipRemaining()` spares resolved items (previously cancelAll stranded/flushed them — the review's top finding); failed items get a visible error + Remove control; the backdrop is inert in queue mode; teardown on modal close promotes resolved payloads and drops late completions via session-wide run claims. |
| 20 | Suite counts now: engine 27, gateway 12, queue **64**, providers 22; `go build ./...` exit 0. |

New browser-proven cases (see `364-remote-smoke.md` §A2): skip-remaining-spares-approved,
resolved+failed+queued skip, failed-item Remove, single-image backdrop inert, per-image modal
reset, session survives tab switch, cross-remount single-read (session-wide claim),
teardown-during-processing drops the late result, field multi-drop notice, Save-failure retry.

## Slice 7 revision (the maintainer-confirmed model — ADR D13)

Commits `b058d88` (upstream #375 merge), `796c7db`, `a7a9ca4`, `1c00748`. Behavioural changes:

| Area | Change |
|---|---|
| Case 5 (field auto-return) | Field-launched uploads now DEFER: the canonical stages in `pendingMedia` and flushes with the page save — content + canonical + placement derivative in ONE commit (browser-proven: one `/postlocal` with all three). The eager one-click commit is gone; case 4's field-side provider-failure path moves to the page-save Button (already covered). |
| Case 10 | Unchanged (one interactive crop) — and the field crop modal now loads deferred assets from in-memory blobs (the §A "same-session `<img>` race" caveat is structurally gone for this flow). |
| Case 11 (field passthrough) | Deferred with per-item `action:'create'` retained — Gitea/GitLab surface same-name conflicts at page save. The existing local dev endpoint still overwrites; that backend fix is separate. |
| NEW: conformance | `conformsToImageOptions` short-circuit: a conforming asset is referenced directly (no derivative, no commit). Engine suite 27 → **39**. |
| NEW: abandoned edit | Reload before page save persists NOTHING (browser-proven). |
| Field UX | No Optimise button anywhere; crop-configured fields show one explicit Crop beside Change Media (split hover). |
| Standalone | Unchanged: explicit eager "Save Media" batch (browser-proven post-change). |
| NEW: page preview (owner-review find) | The PAGE's own `<img>`/`<embed>` rendering a deferred path showed a broken image until page save. `preview_patcher.js` (CMS root) swaps pending paths to blob previews and restores originals when entries leave the store. Browser-proven: page hero renders the cropped derivative pre-save; the one-commit save lands content + derivative; post-save the blob covers the freshly-written path (no broken flash). Field-error text also made legible on dark trays. |
| NEW: ingestion conformance / add-as-is (owner-confirmed) | An upload that ALREADY meets the library defaults (target format + within the max edge, via `conformsToImageOptions(…, LIBRARY_OPTIMISE_DEFAULTS)`) is never silently re-encoded — a deliberately pre-optimised asset can come out LARGER from the canvas. Standalone: the review modal switches to as-is mode ("Already optimised — will be added unchanged", button "Add image as-is"; ticking Crop opts back into the derivative flow) and confirm stages the ORIGINAL BYTES under the ORIGINAL name with `create` (the raw-passthrough contract). Field-launched: a conforming image skips the optimise modal and defers as-is; the field's own schema processing still applies. Engine suite +4 (C-ING1–4) → 43. Browser-proven with the owner's real 14,678-byte 500×300 WebP: modal detected conformance, Save Media wrote `media/500x300_Rubiaceae.webp` BYTE-IDENTICAL (`cmp` clean). |
| NEW: cross-field pick capture (owner-review find) | `changingMedia` is shared across all media fields; a field whose picker was closed WITHOUT picking kept its `field===originalMedia` claim and captured the next pick made for a different field (its crop modal opened on top of the real one). Selection is now gated on `uploadContext` IDENTITY — the exact context object this field set when it opened the picker; admin_menu resets it on abandoned close/standalone open, and it is set at picker-open time so there is no ordering race with the pick's modal close. Browser-proven: abandoned hero_string session then image-field pick → exactly ONE crop modal (the image field's); hero_string's own pick still opens its 500×300 modal. |
| NEW: in-session Library append (owner-review find) | A page save persisted derivatives to `media/` but the open session's Library only listed them after a reload picked up the regenerated media list. `admin_menu` now appends committed `pendingMedia` paths to the in-session `media[]` (mirroring the standalone `addUploadsToLibrary`), deduped, format-normalised via `mediaPrefix`. Browser-proven same-session, no reload: after page save the Library grid lists the new derivative, its tile blob-covered by the preview patcher while the site rebuild races the disk write. |

## Slice 7 review follow-up — Groups 1 and 2 (2026-09-12)

Commits: `eabf4c2` (async ownership), `08556de` (preview ownership and PDF identity).
Run `node scripts/test-cms-transitions.mjs`, or
`deno run --allow-read --allow-env=TEST scripts/test-cms-transitions.mjs`.
The env permission is for the bundled Svelte parser's `TEST` flag.

The shared harness runs actual component instance scripts and the preview module;
it controls Image/Canvas completion and a minimal DOM/MutationObserver boundary.
It does **not** reproduce Svelte's scheduler or render component templates.
Thus its results are synthetic transition evidence, supplemented as shown below
by a freshly rebuilt fixture. No new npm dependencies are required.

| Behavior / dedicated regression case | Synthetic result | Fresh browser evidence |
| --- | --- | --- |
| B remains selected when A decodes after B | Pass | Instrumented pass: hold real A onload, choose B, release A; page stays on B |
| Reopening picker invalidates unfinished selection | Pass | Exercised in the preceding browser sequence |
| Destroyed field ignores unfinished selection | Pass | Not separately exercised |
| Closing upload while decoding stages nothing or hands off nothing | Pass | Instrumented pass: close A, open B, release A; B unchanged; cancelled file absent after page Save |
| Changing upload owner cannot hand A to B | Pass | Same instrumented sequence exercises actual component teardown plus owner replacement |
| Replace image upload with PDF while image decodes | Pass | Not separately exercised |
| B remains selected when older A finishes encoding | Pass | Not separately exercised |
| Active conforming upload stages original File and canonical path | Pass | Ordinary browser pass: active WebP shows deferred blob preview |
| Active nonconforming upload opens optimise modal | Pass | Not separately exercised in this follow-up |
| Older decode failure cannot add an error to B | Pass | Not separately exercised |
| Pending A to persisted B updates the page preview | Pass | Ordinary browser pass: field and page show Perry, stale source marker removed |
| Pending A to pending B restores B when B leaves store | Pass | Not separately exercised |
| Pending A to pending B restores B when patcher stops | Pass | Not separately exercised |
| Same-path rerender and re-crop preserve current blob and restore canonical path | Pass | Not separately exercised |
| Stop before observer callback preserves the layout's new B | Pass | Not separately exercised |
| PDF blur selection returns canonical tile path instead of blob | Pass | DOM verified: canonical attribute remains `media/review-document.pdf` while src is blob; native PDF focus path still unverified |

All **157 tests** pass (43 engine + 12 gateway + 64 queue + 22 providers + 16
transitions); `go build ./...` and a fresh fixture build pass. The completed
transition harness against untouched `212b1b7` reports **13 failures and 3 passes**,
including both restore-path failures. Browser timing control was confined to a
temporary copied fixture: real Image decoding, manually held/released onload.
Screenshots, control script, and reproduction details are retained in the
GiteaPlenti tracking repository under `docs/upstream/364-slice7-fixes-evidence/`.

**Open at that checkpoint:** Group 3 (resolved below), the separate local
create-conflict backend fix, and the parked #360 native PDF interaction redesign.

## Slice 7 review follow-up — Group 3 (2026-09-12)

The Library's success-only deletion callback now removes matching **committed**
entries from `pendingMedia`, using canonical path comparison for bare and
slash-prefixed paths. This revokes the deleted asset's preview and prevents
`admin_menu` from appending it again. An uncommitted replacement is retained for
its next page save. There is no append-once ledger to suppress a legitimate
delete-then-re-save of the same path.

The shared harness now also runs the actual Library deletion handler and parent
Library-list reconciliation with fixture-generated media/configuration inputs.
Its explicit binding handoff remains synthetic, not a Svelte scheduler simulation.

| Dedicated regression behavior | Synthetic result | Fresh browser evidence |
| --- | --- | --- |
| Successfully deleted saved upload stays absent | Pass | Ordinary browser: homepage upload/save/delete; zero matching tiles, file absent, field src released from blob to canonical path |
| Slash-prefixed Library path retires bare pending path | Pass | Not separately exercised |
| Save → delete → save same path appends once | Pass | Ordinary browser: same session, same filename, one tile after second save and byte-identical file on disk |
| Unrelated later save cannot resurrect deleted path | Pass | Not separately exercised |
| Selection without successful delete completion retains saved preview | Pass | No provider-failure injection; harness does not invoke the success callback |
| Deleting persisted file preserves an unsaved replacement | Pass | Not separately exercised |

All **163 tests** pass (43 engine + 12 gateway + 64 queue + 22 providers + 22
transitions), plus `go build ./...` and a fresh fixture build. Against pre-Group-3
`f699537`, the completed transition harness reports **18 passes and 4 failures**:
deletion, slash normalization, delete/re-save, and unrelated-save resurrection.

Browser fixture note: providers redirect to `/` after deletion. A first test from
`/croptest` changed the edited filepath and could clear pending state, so it was
**not counted** as resurrection proof. The verified run added a media field to the
temporary fixture's homepage; deletion left both URL and edited filepath unchanged.
No reload occurred during the verified save/delete/re-save cycle. Source, baseline
output, and screenshots are recorded in GiteaPlenti under
`docs/upstream/364-slice7-group3-evidence/`.

The separate local create-conflict defect remains **unfixed and disclosed**.
Native PDF-focus selection remains unverified; the parked #360 redesign remains
separate. Neither is claimed fixed by Group 3.
