/* ==========================================================================
   EventUndo — file dropzone
   Turns a bare `<div class="a-dropzone" data-input-id="…">` stub into the
   full browse / drag-and-drop / preview widget and wires it to the native
   file input it renders. One module shared by every image upload in the
   product — profile photo, event thumbnail/banner, org logo, team photo,
   site favicon and link-preview image — so all eight render identically
   instead of drifting per page.

   Admin re-runs initDropzones() in each modal's onMount since the modal
   body is rebuilt from a template string every time it opens; the
   data-wired guard makes repeat calls on already-rendered zones a no-op.
   ========================================================================== */

const CLOUD_ICON = `<svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M12 28.5a6.5 6.5 0 0 1-.6-12.97A8.5 8.5 0 0 1 27.8 13.9 6.5 6.5 0 0 1 27 28.5H12Z"
        stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
  <path d="M16.5 22.5 20 19l3.5 3.5M20 19v9.5" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const FILE_ICON = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M6 2h9l5 5v15a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z"
        stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
  <path d="M14 2v5h5" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
</svg>`;

const CROP_ICON = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M6 2v14a2 2 0 0 0 2 2h14M18 22V8a2 2 0 0 0-2-2H2"
        stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB'];
  let val = bytes / 1024;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
  return val.toFixed(val < 10 ? 1 : 0) + ' ' + units[i];
}

/** Files that came out of the cropper (or a source file that's already the
 *  right shape) skip the button — there's nothing left to crop until a new
 *  file replaces it. Browsers won't reliably decode .ico into an <img> for
 *  the cropper's canvas math, so that one format opts out regardless. */
function canCrop(zone, file) {
  return !!zone.dataset.cropAspect && !!file &&
    file.type.startsWith('image/') && file.type !== 'image/x-icon';
}

function render(zone) {
  const inputId = zone.dataset.inputId;
  const accept = zone.dataset.accept || '';
  const hint = zone.dataset.hint || 'Up to 50MB';
  zone.innerHTML = `
    <input class="a-dropzone__input" id="${inputId}" type="file" accept="${accept}" hidden />
    <div class="a-dropzone__empty">
      <span class="a-dropzone__icon" aria-hidden="true">${CLOUD_ICON}</span>
      <p class="a-dropzone__text">Choose a file or drag &amp; drop it here</p>
      <p class="a-dropzone__hint">${hint}</p>
      <button type="button" class="a-btn a-btn--ghost a-btn--sm a-dropzone__browse">Browse File</button>
    </div>
    <div class="a-dropzone__preview" hidden>
      <span class="a-dropzone__file-icon" aria-hidden="true">${FILE_ICON}</span>
      <img class="a-dropzone__thumb" alt="" hidden />
      <span class="a-dropzone__file-info">
        <span class="a-dropzone__file-name"></span>
        <span class="a-dropzone__file-size"></span>
      </span>
      <button type="button" class="a-dropzone__crop" hidden>${CROP_ICON} Crop</button>
      <button type="button" class="a-dropzone__remove" aria-label="Remove file">&times;</button>
    </div>`;
}

/** The thumbnail's previous object URL — revoked before a new one replaces
 *  it, or the blob it points at leaks for the rest of the page's life. */
function showPreview(zone, file) {
  const empty = zone.querySelector('.a-dropzone__empty');
  const preview = zone.querySelector('.a-dropzone__preview');
  const thumb = zone.querySelector('.a-dropzone__thumb');
  const fileIcon = zone.querySelector('.a-dropzone__file-icon');
  const cropBtn = zone.querySelector('.a-dropzone__crop');

  if (thumb.dataset.objectUrl) { URL.revokeObjectURL(thumb.dataset.objectUrl); delete thumb.dataset.objectUrl; }

  if (!file) {
    empty.hidden = false;
    preview.hidden = true;
    thumb.hidden = true;
    thumb.removeAttribute('src');
    return;
  }

  preview.querySelector('.a-dropzone__file-name').textContent = file.name;
  preview.querySelector('.a-dropzone__file-size').textContent = formatBytes(file.size);
  empty.hidden = true;
  preview.hidden = false;
  cropBtn.hidden = !canCrop(zone, file);

  if (file.type.startsWith('image/')) {
    const url = URL.createObjectURL(file);
    thumb.dataset.objectUrl = url;
    thumb.src = url;
    thumb.hidden = false;
    fileIcon.hidden = true;
  } else {
    thumb.hidden = true;
    fileIcon.hidden = false;
  }
}

/** Swaps the input's file for the cropped one — FileList has no public
 *  constructor, so a DataTransfer is the standard way to hand a fresh File
 *  back to a real <input type="file">. */
function replaceFile(input, file) {
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
}

/** Clears the input and puts its dropzone back in the empty state. */
export function resetDropzone(input) {
  const zone = input.closest('.a-dropzone');
  input.value = '';
  if (zone) showPreview(zone, null);
}

export function initDropzones(root = document) {
  root.querySelectorAll('.a-dropzone[data-input-id]').forEach((zone) => {
    if (zone.dataset.wired) return;
    zone.dataset.wired = 'true';
    render(zone);

    const input = zone.querySelector('.a-dropzone__input');
    const empty = zone.querySelector('.a-dropzone__empty');
    const remove = zone.querySelector('.a-dropzone__remove');
    const cropBtn = zone.querySelector('.a-dropzone__crop');

    empty.addEventListener('click', () => input.click());
    input.addEventListener('change', () => showPreview(zone, input.files[0] || null));
    remove.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      resetDropzone(input);
    });
    cropBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const file = input.files[0];
      if (!file) return;
      openCropper(file, zone.dataset.cropAspect, zone.dataset.cropW, zone.dataset.cropH, (cropped) => {
        replaceFile(input, cropped);
        showPreview(zone, cropped);
      });
    });

    ['dragenter', 'dragover'].forEach((evt) => zone.addEventListener(evt, (e) => {
      e.preventDefault();
      zone.classList.add('a-dropzone--drag');
    }));
    ['dragleave', 'drop'].forEach((evt) => zone.addEventListener(evt, (e) => {
      e.preventDefault();
      zone.classList.remove('a-dropzone--drag');
    }));
    zone.addEventListener('drop', (e) => {
      const file = e.dataTransfer.files[0];
      if (!file) return;
      input.files = e.dataTransfer.files;
      showPreview(zone, file);
    });
  });
}

/* ==========================================================================
   Cropper — a single overlay shared by every dropzone on the page, built
   lazily on first use. Pan-and-zoom rather than a resizable marquee: the
   crop is always "whatever fills the viewport", so there's no handle to
   drag past the image edge and no way to end up with an empty corner —
   simpler to use correctly than a freeform rectangle, and every upload
   here (avatar, logo, banner…) wants a fixed aspect anyway, never an
   arbitrary one.
   ========================================================================== */

let cropperEls = null;
let cropperState = null;

function buildCropper() {
  const root = document.createElement('div');
  root.className = 'a-cropper';
  root.hidden = true;
  root.innerHTML = `
    <div class="a-cropper__box" role="dialog" aria-modal="true" aria-labelledby="a-cropper-title">
      <div class="a-cropper__head">
        <h2 class="a-cropper__title" id="a-cropper-title">Crop image</h2>
        <button class="a-cropper__close" type="button" aria-label="Cancel crop">&times;</button>
      </div>
      <div class="a-cropper__stage">
        <div class="a-cropper__viewport">
          <img class="a-cropper__img" alt="" draggable="false" />
        </div>
      </div>
      <div class="a-cropper__zoom-row">
        <span class="a-cropper__zoom-icon" aria-hidden="true">&minus;</span>
        <input class="a-cropper__zoom" type="range" min="1" max="3" step="0.01" value="1" aria-label="Zoom" />
        <span class="a-cropper__zoom-icon" aria-hidden="true">+</span>
      </div>
      <p class="a-cropper__hint">Drag the image to reposition it.</p>
      <div class="a-cropper__actions">
        <button class="a-btn a-btn--ghost" type="button" data-cropper-action="cancel">Cancel</button>
        <button class="a-btn" type="button" data-cropper-action="confirm">Use this crop</button>
      </div>
    </div>`;
  document.body.append(root);

  const els = {
    root,
    viewport: root.querySelector('.a-cropper__viewport'),
    img: root.querySelector('.a-cropper__img'),
    zoom: root.querySelector('.a-cropper__zoom'),
    close: root.querySelector('.a-cropper__close'),
    cancel: root.querySelector('[data-cropper-action="cancel"]'),
    confirm: root.querySelector('[data-cropper-action="confirm"]')
  };

  const cancel = () => closeCropper();
  els.close.addEventListener('click', cancel);
  els.cancel.addEventListener('click', cancel);
  els.root.addEventListener('click', (e) => { if (e.target === els.root) cancel(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.root.hidden) cancel();
  });
  els.confirm.addEventListener('click', confirmCropper);

  els.zoom.addEventListener('input', () => setZoom(parseFloat(els.zoom.value)));

  // Pointer Events cover mouse, touch and pen from one listener set, and
  // setPointerCapture keeps a fast drag tracking even once the cursor
  // leaves the (fairly small) viewport.
  let dragging = null;
  els.viewport.addEventListener('pointerdown', (e) => {
    dragging = { x: e.clientX, y: e.clientY, offX: cropperState.offX, offY: cropperState.offY };
    els.viewport.setPointerCapture(e.pointerId);
    els.viewport.classList.add('a-cropper__viewport--dragging');
  });
  els.viewport.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    panTo(dragging.offX + (e.clientX - dragging.x), dragging.offY + (e.clientY - dragging.y));
  });
  const endDrag = () => { dragging = null; els.viewport.classList.remove('a-cropper__viewport--dragging'); };
  els.viewport.addEventListener('pointerup', endDrag);
  els.viewport.addEventListener('pointercancel', endDrag);

  return els;
}

function panTo(x, y) {
  const s = cropperState;
  s.offX = Math.min(0, Math.max(s.viewportW - s.dispW, x));
  s.offY = Math.min(0, Math.max(s.viewportH - s.dispH, y));
  cropperEls.img.style.transform = `translate(${s.offX}px, ${s.offY}px)`;
}

/** Rescales around the viewport's centre point rather than its top-left
 *  corner, so the thing the user is looking at is what stays put as they
 *  move the slider — the usual expectation for a zoom control. */
function setZoom(zoomValue) {
  const s = cropperState;
  const prevDispW = s.dispW, prevDispH = s.dispH;
  const centerImgX = (s.viewportW / 2 - s.offX) / prevDispW;
  const centerImgY = (s.viewportH / 2 - s.offY) / prevDispH;

  s.zoom = zoomValue;
  s.dispW = s.naturalW * s.baseScale * s.zoom;
  s.dispH = s.naturalH * s.baseScale * s.zoom;
  cropperEls.img.style.width = s.dispW + 'px';
  cropperEls.img.style.height = s.dispH + 'px';

  panTo(s.viewportW / 2 - centerImgX * s.dispW, s.viewportH / 2 - centerImgY * s.dispH);
}

function openCropper(file, aspectAttr, outW, outH, onConfirm) {
  const aspect = parseFloat(aspectAttr) || 1;
  if (!cropperEls) cropperEls = buildCropper();
  const els = cropperEls;

  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onerror = () => {
    // Some browsers genuinely can't decode this one (an odd SVG, a
    // corrupt file) — fail quietly back to the un-cropped original rather
    // than leaving the modal open on a broken image with no way out.
    URL.revokeObjectURL(url);
    onConfirm(file);
  };
  img.onload = () => {
    // Sized in real CSS px so the same aspect looks right whether it's a
    // near-square avatar or a 4:1 banner, instead of a fixed box squashing
    // wide crops down to a sliver. Capped against the viewport itself, not
    // a hardcoded number, so it still fits on a phone-width screen.
    const maxW = Math.min(560, window.innerWidth - 64);
    const maxH = Math.min(420, window.innerHeight * 0.5);
    let vw = maxW, vh = vw / aspect;
    if (vh > maxH) { vh = maxH; vw = vh * aspect; }

    els.viewport.style.width = vw + 'px';
    els.viewport.style.height = vh + 'px';

    const baseScale = Math.max(vw / img.naturalWidth, vh / img.naturalHeight);
    cropperState = {
      file, url, onConfirm, outW: parseInt(outW, 10) || null, outH: parseInt(outH, 10) || null,
      naturalW: img.naturalWidth, naturalH: img.naturalHeight,
      viewportW: vw, viewportH: vh, baseScale, zoom: 1,
      dispW: img.naturalWidth * baseScale, dispH: img.naturalHeight * baseScale,
      offX: 0, offY: 0
    };

    els.img.src = url;
    els.img.style.width = cropperState.dispW + 'px';
    els.img.style.height = cropperState.dispH + 'px';
    els.zoom.value = '1';
    panTo((vw - cropperState.dispW) / 2, (vh - cropperState.dispH) / 2);

    els.root.hidden = false;
    document.body.style.overflow = 'hidden';
  };
  img.src = url;
}

function closeCropper() {
  if (!cropperEls) return;
  cropperEls.root.hidden = true;
  document.body.style.overflow = '';
  if (cropperState) { URL.revokeObjectURL(cropperState.url); cropperState = null; }
}

function confirmCropper() {
  const s = cropperState;
  if (!s) return;

  // Map the visible viewport back to a rectangle in the source image's own
  // pixel space: everything on screen is display px (natural px × the
  // current effective scale), so dividing by that scale undoes it.
  const scale = s.dispW / s.naturalW;
  const sx = -s.offX / scale;
  const sy = -s.offY / scale;
  const sw = s.viewportW / scale;
  const sh = s.viewportH / scale;

  const canvas = document.createElement('canvas');
  canvas.width = s.outW || Math.round(sw);
  canvas.height = s.outH || Math.round(sh);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cropperEls.img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

  // SVG/ICO sources can't round-trip through canvas export as themselves —
  // everything downgrades to PNG, which every browser can always encode.
  const outType = ['image/jpeg', 'image/png', 'image/webp'].includes(s.file.type)
    ? s.file.type : 'image/png';
  const ext = outType.split('/')[1].replace('jpeg', 'jpg');
  const name = s.file.name.replace(/\.[^.]+$/, '') + '-cropped.' + ext;
  const onConfirm = s.onConfirm;

  // toDataURL + fetch, not canvas.toBlob: toBlob is async via a callback
  // that some privacy-hardened browsers throttle or gate behind a canvas
  // fingerprinting prompt, which would leave "Use this crop" doing nothing
  // with no error. toDataURL is synchronous, and fetching a data: URL never
  // touches the network, so this path can't stall the same way.
  const dataUrl = canvas.toDataURL(outType, 0.92);
  fetch(dataUrl).then((r) => r.blob()).then((blob) => {
    const cropped = new File([blob], name, { type: outType, lastModified: Date.now() });
    closeCropper();
    onConfirm(cropped);
  });
}
