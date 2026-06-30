import { writable } from 'svelte/store';

// When a schema-configured media field opens the media modal, it registers a
// handler here so a fresh UPLOAD is handed back to the field (to enforce the
// field's crop/scale/convert and commit only the derivative) instead of taking
// file_upload's eager "Save Media" path.
//
// null means the open modal isn't tied to a configured field — the standalone
// Media library, or a field with no image options — so file_upload keeps its
// existing general-purpose upload behaviour.
export const fieldUploadHandler = writable(null);
