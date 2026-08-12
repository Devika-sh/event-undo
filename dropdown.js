/* ==========================================================================
   EventUndo — custom select dropdown
   Progressively enhances every bare `<select class="a-select">` into a pill
   trigger + listbox menu (checkmark on the selected option, brand-gradient
   highlight on the active one) so every dropdown in the app — filters, the
   event editor's date pickers, admin forms, the profile edit form — shares
   one look instead of the browser's native menu chrome.

   The original <select> stays in the DOM, hidden, and is still the source
   of truth: `.value`, `.disabled`, and a `change` event on selection, so
   every existing `$('#foo').value` read and `addEventListener('change', …)`
   keeps working untouched.

   Self-wiring: a MutationObserver on <body> wires up any `.a-select` the
   moment it's added to the page — admin's modals rebuild their whole body
   from a template string on every open, and this app has no single "route
   changed" hook to hang a manual init call off of. A second observer, per
   wired select, re-syncs the menu whenever that select's own <option> list
   is replaced (the events/registrations filter bars and the event-org field
   repopulate theirs after their data loads). Nothing needs to call this
   module directly — importing it for its side effect is enough.
   ========================================================================== */

const CHEVRON = `<svg viewBox="0 0 12 8" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M1 1.5 6 6.5 11 1.5" stroke="currentColor" stroke-width="1.6" fill="none"
        stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

const CHECK = `<svg viewBox="0 0 16 12" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M14.5 1.5 5.5 10.5 1.5 6.5" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

function closeMenu(wrap) {
  wrap.classList.remove('eu-dd--open');
  wrap.querySelector('.eu-dd__trigger').setAttribute('aria-expanded', 'false');
  wrap.querySelector('.eu-dd__menu').hidden = true;
}

function closeAll(except) {
  document.querySelectorAll('.eu-dd--open').forEach((wrap) => {
    if (wrap !== except) closeMenu(wrap);
  });
}

function openMenu(wrap) {
  closeAll(wrap);
  wrap.classList.add('eu-dd--open');
  wrap.querySelector('.eu-dd__trigger').setAttribute('aria-expanded', 'true');
  const menu = wrap.querySelector('.eu-dd__menu');
  menu.hidden = false;
  menu.querySelectorAll('.eu-dd__option--active').forEach((o) => o.classList.remove('eu-dd__option--active'));
  const active = menu.querySelector('[aria-selected="true"]') || menu.querySelector('.eu-dd__option');
  if (active) {
    active.classList.add('eu-dd__option--active');
    active.scrollIntoView({ block: 'nearest' });
  }
}

function syncTrigger(select, wrap) {
  const selected = select.options[select.selectedIndex];
  wrap.querySelector('.eu-dd__value').textContent = selected ? selected.textContent : '';
  wrap.querySelector('.eu-dd__trigger').disabled = select.disabled;
}

function syncMenu(select, wrap) {
  const menu = wrap.querySelector('.eu-dd__menu');
  menu.innerHTML = '';
  [...select.options].forEach((opt) => {
    const li = document.createElement('li');
    li.className = 'eu-dd__option' + (opt.disabled ? ' eu-dd__option--disabled' : '');
    li.setAttribute('role', 'option');
    li.dataset.value = opt.value;
    li.setAttribute('aria-selected', String(opt.selected));

    const check = document.createElement('span');
    check.className = 'eu-dd__check';
    check.innerHTML = CHECK;

    const label = document.createElement('span');
    label.className = 'eu-dd__label';
    label.textContent = opt.textContent;

    li.append(check, label);
    menu.append(li);
  });
  syncTrigger(select, wrap);
}

function selectOption(select, wrap, li) {
  if (li.classList.contains('eu-dd__option--disabled')) return;
  select.value = li.dataset.value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  syncMenu(select, wrap);
  closeMenu(wrap);
  wrap.querySelector('.eu-dd__trigger').focus();
}

function moveHighlight(menu, dir) {
  const options = [...menu.querySelectorAll('.eu-dd__option:not(.eu-dd__option--disabled)')];
  if (!options.length) return;
  const current = menu.querySelector('.eu-dd__option--active');
  let idx = current ? options.indexOf(current) + dir : 0;
  idx = ((idx % options.length) + options.length) % options.length;
  options.forEach((o) => o.classList.remove('eu-dd__option--active'));
  options[idx].classList.add('eu-dd__option--active');
  options[idx].scrollIntoView({ block: 'nearest' });
}

function wire(select) {
  if (select.dataset.ddWired || !select.isConnected) return;
  select.dataset.ddWired = 'true';

  const wrap = document.createElement('div');
  wrap.className = 'eu-dd';
  // Carries over sizing hooks like style="width:auto" from the toolbar
  // filter selects onto the element that now actually occupies that space.
  if (select.getAttribute('style')) wrap.setAttribute('style', select.getAttribute('style'));

  select.insertAdjacentElement('afterend', wrap);
  select.hidden = true;
  wrap.append(select);

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'eu-dd__trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  if (select.id) trigger.setAttribute('aria-labelledby', select.id + '-eu-dd-label');
  trigger.innerHTML = `<span class="eu-dd__value"></span><span class="eu-dd__chevron">${CHEVRON}</span>`;

  const menu = document.createElement('ul');
  menu.className = 'eu-dd__menu';
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;

  wrap.append(trigger, menu);
  syncMenu(select, wrap);

  trigger.addEventListener('click', () => {
    if (select.disabled) return;
    wrap.classList.contains('eu-dd--open') ? closeMenu(wrap) : openMenu(wrap);
  });

  menu.addEventListener('click', (e) => {
    const li = e.target.closest('.eu-dd__option');
    if (li) selectOption(select, wrap, li);
  });

  trigger.addEventListener('keydown', (e) => {
    if (select.disabled) return;
    const isOpen = wrap.classList.contains('eu-dd--open');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      isOpen ? moveHighlight(menu, 1) : openMenu(wrap);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      isOpen ? moveHighlight(menu, -1) : openMenu(wrap);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!isOpen) { openMenu(wrap); return; }
      const active = menu.querySelector('.eu-dd__option--active');
      if (active) selectOption(select, wrap, active);
    } else if (e.key === 'Escape' && isOpen) {
      closeMenu(wrap);
    }
  });

  // The select's own option list can be replaced wholesale after this runs
  // (filter bars repopulating once their data loads) — keep the menu in sync.
  new MutationObserver(() => syncMenu(select, wrap)).observe(select, { childList: true });
}

function wireAll(root) {
  root.querySelectorAll?.('select.a-select').forEach(wire);
}

wireAll(document);

new MutationObserver((mutations) => {
  for (const m of mutations) {
    m.addedNodes.forEach((node) => {
      if (node.nodeType !== 1) return;
      if (node.matches?.('select.a-select')) wire(node);
      wireAll(node);
    });
  }
}).observe(document.body, { childList: true, subtree: true });

document.addEventListener('click', (e) => {
  if (!e.target.closest('.eu-dd')) closeAll();
});

/** Manual hook for anything that needs the sync guaranteed synchronous
 *  right after it runs, rather than waiting a tick for the observer. */
export function initDropdowns(root = document) {
  wireAll(root);
}
