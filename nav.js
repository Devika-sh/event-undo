/* ==========================================================================
   EventUndo — shared navbar behaviour
   --------------------------------------------------------------------------
   Every public page carries the same header, so this replaces the three
   near-identical inline blocks each one used to repeat (page transition,
   scroll state, mobile menu toggle). Plain script, no module: it touches
   nothing Supabase does and should run before first paint's worth of
   interaction, not after a module graph resolves.

   The visual side lives in styles.css — see "Motion easings" and the navbar
   rules there. This file only drives the state each of those rules keys off:
     body.is-scrolled      → nav pill lifts, scroll-shade fades in
     body.is-nav-hidden    → nav pill slides away (scrolling down)
     body.page-exit        → current page slides out before navigating
     .mobile-menu[data-open] → the colour wipe and link stagger play
   ========================================================================== */

(function () {
  'use strict';

  /* ---- Page transition ---------------------------------------------------
     Slides the current page out before following an internal navbar link, so
     moving between pages reads as one continuous motion rather than a cut. */
  (function () {
    var EXIT_MS = 180;
    document.addEventListener('click', function (e) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var link = e.target.closest('.navbar a[href], .navbar-mobile a[href], .mobile-menu a[href]');
      if (!link) return;
      var href = link.getAttribute('href');
      if (!href || href.charAt(0) === '#' || link.target === '_blank') return;
      e.preventDefault();
      document.body.classList.add('page-exit');
      setTimeout(function () { location.href = href; }, EXIT_MS);
    });
  })();

  /* ---- Scroll state ------------------------------------------------------
     Two independent things ride on the scroll position:
       is-scrolled    — past the hero, so the pill lifts and the shade shows.
       is-nav-hidden  — heading down the page, so the pill gets out of the way;
                        it comes back the moment the user scrolls up, which is
                        when they're most likely reaching for navigation.
     rAF-throttled so it never fights the scroll itself. */
  (function () {
    var SHADE_AT = 80;    // px before the pill lifts off the page
    var HIDE_AFTER = 160; // never hide while still near the top
    var DELTA = 6;        // ignore sub-pixel jitter and rubber-banding

    var lastY = window.scrollY;
    var ticking = false;

    function update() {
      var y = window.scrollY;
      var body = document.body;

      body.classList.toggle('is-scrolled', y > SHADE_AT);

      var moved = y - lastY;
      if (Math.abs(moved) > DELTA) {
        // An open menu owns the screen — hiding the bar would take its close
        // button with it, so direction is ignored until the menu is shut.
        var menuOpen = document.querySelector('.mobile-menu[data-open]');
        body.classList.toggle('is-nav-hidden', moved > 0 && y > HIDE_AFTER && !menuOpen);
        lastY = y;
      }
      ticking = false;
    }

    window.addEventListener('scroll', function () {
      if (!ticking) {
        window.requestAnimationFrame(update);
        ticking = true;
      }
    }, { passive: true });

    update();
  })();

  /* ---- Mobile menu -------------------------------------------------------
     The panel can't just flip `hidden`: styles.css hides that outright
     (`[hidden] { display: none !important }`), so a menu going straight to
     hidden would cut the closing wipe off mid-sweep. Opening therefore
     unhides first and flags `data-open` on the next frame — the layers need
     to be laid out at translateY(-100%) before the transition to 0 can be
     interpolated — and closing drops the flag, then re-hides once the last
     layer has actually finished travelling. */
  (function () {
    var toggle = document.querySelector('.navbar-btn');
    var menu = document.querySelector('.mobile-menu');
    if (!toggle || !menu) return;

    // Which element carries data-menu-open differs per page: Discover and Team
    // wrap the bar in .navbar-wrap, Organizations flags the whole header, and
    // Profile / Event details flag their own bar. Closest match wins, and
    // .org-head__bar is deliberately absent so Organizations resolves to
    // .org-head, which is what its CSS keys off.
    var host = toggle.closest('.navbar-wrap, .profile-head__bar, .detail-head__bar, .org-head');

    var closeTimer = null;

    function setOpen(open) {
      clearTimeout(closeTimer);

      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      if (host) host.toggleAttribute('data-menu-open', open);
      document.body.style.overflow = open ? 'hidden' : '';

      if (open) {
        // A hidden element has no layout, so the wipe layers would have no
        // start position to animate from. Unhide, force a reflow, then flag.
        document.body.classList.remove('is-nav-hidden');
        menu.hidden = false;
        void menu.offsetHeight;
        menu.setAttribute('data-open', '');
      } else {
        menu.removeAttribute('data-open');
        // Longest layer: 730ms travel + 250ms delay (see .mobile-menu__layer).
        closeTimer = setTimeout(function () { menu.hidden = true; }, 1000);
      }
    }

    toggle.addEventListener('click', function () {
      setOpen(toggle.getAttribute('aria-expanded') !== 'true');
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') setOpen(false);
    });

    // Following a link runs the page-transition above; closing here first
    // means the wipe retracts rather than the whole panel vanishing at once.
    menu.addEventListener('click', function (e) {
      if (e.target.closest('a[href]')) setOpen(false);
    });
  })();
})();
