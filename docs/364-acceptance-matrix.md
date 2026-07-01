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
| 13 | Re-uploading a raw passthrough filename stays `create` (no silent overwrite) | provider | `absent derivative → create`; per-item `action ?? action` honoured | ✅ |
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
