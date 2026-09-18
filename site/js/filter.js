/* Filter a static list in place.
 *
 * The reference is 14 pages today and the log-ingest workflow is designed to push it
 * past sixty, at which point a wall of cards stops being browsable. Everything stays
 * in the DOM and is only hidden, so crawlers and a reader with no JavaScript still
 * get the complete list.
 */
const root = document.querySelector('[data-filter]');
if (root) init(root);

function init(root) {
  const input = root.querySelector('input[type="search"]');
  const chips = [...root.querySelectorAll('button.chip')];
  const items = [...root.querySelectorAll('[data-terms]')];
  const count = root.querySelector('.count');
  let group = 'all';

  function apply() {
    const q = (input ? input.value : '').trim().toLowerCase();
    let shown = 0;
    for (const el of items) {
      const terms = el.getAttribute('data-terms');
      const inGroup = group === 'all' || el.getAttribute('data-group') === group;
      const match = !q || terms.includes(q);
      const on = inGroup && match;
      el.classList.toggle('hidden', !on);
      if (on) shown++;
    }
    if (count) {
      // The noun comes from the markup. This filter sits under a lookup covering
      // several hundred responses, and hard-coding "responses" here made the page
      // announce that the whole reference was fourteen of them.
      const noun = root.getAttribute('data-noun') || 'items';
      count.textContent = shown === items.length
        ? `${items.length} ${noun}`
        : `${shown} of ${items.length}`;
    }
    root.querySelector('.noresult')?.classList.toggle('hidden', shown > 0);
  }

  input?.addEventListener('input', apply);
  input?.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { input.value = ''; apply(); }
    // Enter with exactly one match is the fast path: type 4.7.28, press Enter, arrive.
    if (ev.key === 'Enter') {
      const visible = items.filter(el => !el.classList.contains('hidden'));
      if (visible.length === 1) { ev.preventDefault(); visible[0].querySelector('a,[href]')?.click(); }
    }
  });
  for (const c of chips) {
    c.addEventListener('click', () => {
      group = c.getAttribute('data-group');
      chips.forEach(x => x.classList.toggle('on', x === c));
      apply();
    });
  }
  apply();
  // Deep link: /smtp/?q=4.7.28
  const q = new URLSearchParams(location.search).get('q');
  if (q && input) { input.value = q; apply(); }
}
