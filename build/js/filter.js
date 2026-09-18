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
    // Feedback for what the reader just did, not an inventory. Announcing a total
    // here told every visitor how much of the reference is written up, which is
    // nobody's business and reads as a shortfall. Silent until a filter narrows it.
    if (count) count.textContent = shown === items.length ? '' : `${shown} showing`;
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
  // Deep link: ?f=tls. Deliberately not ?q=, which belongs to the lookup that
  // sits above this filter on both pages that use it. Reading the same
  // parameter meant /rfc/?q=821 quietly filtered the browse list to a number
  // that is not in it, so clearing the search box revealed an empty list.
  const q = new URLSearchParams(location.search).get('f');
  if (q && input) { input.value = q; apply(); }
}
