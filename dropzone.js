/* ==========================================================================
   EventUndo — file dropzone
   Turns a bare `<div class="a-dropzone" data-input-id="…">` stub into the
   full browse / drag-and-drop / preview widget and wires it to the native
   file input it renders. One module shared by the profile page and the
   admin console so the three upload fields (avatar, event banner, org logo)
   render identically instead of drifting per page.

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

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB'];
  let val = bytes / 1024;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
  return val.toFixed(val < 10 ? 1 : 0) + ' ' + units[i];
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
      <span class="a-dropzone__file-info">
        <span class="a-dropzone__file-name"></span>
        <span class="a-dropzone__file-size"></span>
      </span>
      <button type="button" class="a-dropzone__remove" aria-label="Remove file">&times;</button>
    </div>`;
}

function showPreview(zone, file) {
  const empty = zone.querySelector('.a-dropzone__empty');
  const preview = zone.querySelector('.a-dropzone__preview');
  if (!file) {
    empty.hidden = false;
    preview.hidden = true;
    return;
  }
  preview.querySelector('.a-dropzone__file-name').textContent = file.name;
  preview.querySelector('.a-dropzone__file-size').textContent = formatBytes(file.size);
  empty.hidden = true;
  preview.hidden = false;
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

    empty.addEventListener('click', () => input.click());
    input.addEventListener('change', () => showPreview(zone, input.files[0] || null));
    remove.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      resetDropzone(input);
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
