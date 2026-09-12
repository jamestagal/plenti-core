# Image-crop field controls

Captured on 2026-09-13 from a binary built at `2cf858d`, serving a disposable copy
of `crop-fixture`. The fixture uses Plenti's Perry image for both sample fields;
the crop field has a 500×300 WebP schema, while the other field has `crop:false`.
These are actual browser hover states, without CSS overrides or image generation.

- `crop-field-hover.png`: Change Media and Crop Image on the configured field.
- `change-only-hover.png`: Change Media alone on the field without crop enabled.
- `recrop-field-hover.png`: Re-crop Image after applying a crop in the same session.

The screenshots document the implemented UI. The processing/deferral behavior is
described in #364; the Crop-only UI is the proposal in the author's follow-up,
without a separate maintainer confirmation visible in the issue thread at capture.
