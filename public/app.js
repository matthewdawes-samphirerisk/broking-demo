const gbp = n => '£' + Math.round(n).toLocaleString('en-GB');
// Compact amounts for bar labels; small values keep enough precision to be meaningful once filtered.
const gbpK = n => n < 1000 ? gbp(n)
  : n < 10000 ? '£' + (n / 1000).toFixed(1) + 'k'
  : '£' + Math.round(n / 1000).toLocaleString('en-GB') + 'k';

// One filter per chart; null means no filter from that chart.
const DIMENSIONS = {
  month:   { label: 'Month',         key: p => p.inception.slice(0, 7), el: 'by-month' },
  product: { label: 'Product line',  key: p => p.product,               el: 'by-product' },
  owner:   { label: 'Account owner', key: p => p.owner,                 el: 'by-owner' },
};
const filters = { month: null, product: null, owner: null };

let policies = [];
const categories = {}; // fixed bar order per chart, so bars don't jump around when filtering

// '2025-03' -> 'Mar25'
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const mmmYr = ym => MONTHS[+ym.slice(5, 7) - 1] + ym.slice(2, 4);

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Rows passing every active filter, optionally ignoring one chart's own filter.
function filtered(except) {
  return policies.filter(p =>
    Object.entries(filters).every(([dim, val]) => dim === except || val === null || DIMENSIONS[dim].key(p) === val));
}

function sumBy(rows, key) {
  const totals = {};
  for (const r of rows) totals[key(r)] = (totals[key(r)] || 0) + r.revenue;
  return totals;
}

function toggle(dim, value) {
  filters[dim] = filters[dim] === value ? null : value;
  render();
}

function barClass(dim, name) {
  const sel = filters[dim];
  return sel === null ? '' : sel === name ? ' selected' : ' dimmed';
}

function renderBars(dim) {
  const totals = sumBy(filtered(dim), DIMENSIONS[dim].key);
  const max = Math.max(1, ...Object.values(totals));
  document.getElementById(DIMENSIONS[dim].el).innerHTML = categories[dim].map(name => {
    const v = totals[name] || 0;
    return `
    <div class="row${barClass(dim, name)}" data-dim="${dim}" data-value="${esc(name)}">
      <div class="name">${esc(name)}</div>
      <div class="track"><div class="bar" style="width:${(v / max) * 100}%"></div></div>
      <div class="amt">${gbpK(v)}</div>
    </div>`;
  }).join('');
}

function renderMonths() {
  const totals = sumBy(filtered('month'), DIMENSIONS.month.key);
  const months = categories.month;
  const max = Math.max(1, ...Object.values(totals));
  document.getElementById('by-month').innerHTML = months.map(m => {
    const v = totals[m] || 0;
    return `
    <div class="col${barClass('month', m)}" data-dim="month" data-value="${m}" title="${mmmYr(m)}: ${gbp(v)}">
      <div class="bar" style="height:${(v / max) * 100}%"></div>
    </div>`;
  }).join('');
  document.getElementById('month-labels').innerHTML = months
    .map(m => `<div><span>${mmmYr(m)}</span></div>`).join('');
  // Touch screens have no hover tooltip, so spell out the selected month's value.
  const sel = filters.month;
  document.getElementById('month-readout').textContent = sel
    ? `${new Date(sel + '-01').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}: ${gbp(totals[sel] || 0)}`
    : 'Tap or click a month to filter.';
}

function renderFilters() {
  const active = Object.entries(filters).filter(([, v]) => v !== null);
  document.getElementById('filters').innerHTML = active.length === 0
    ? '<span class="none">No filters — click any bar to filter.</span>'
    : active.map(([dim, v]) => `
        <span class="chip">${DIMENSIONS[dim].label}: <b>${esc(dim === 'month' ? mmmYr(v) : v)}</b>
          <button data-clear="${dim}" title="Remove this filter">×</button></span>`).join('') +
      '<button class="clear-all" data-clear="all">Clear all</button>';
}

function render() {
  const rows = filtered();
  document.getElementById('count').textContent =
    rows.length === policies.length ? `${policies.length} policies.` : `${rows.length} of ${policies.length} policies.`;
  document.getElementById('gwp').textContent = gbp(rows.reduce((s, p) => s + p.gwp, 0));
  document.getElementById('revenue').textContent = gbp(rows.reduce((s, p) => s + p.revenue, 0));
  renderFilters();
  renderMonths();
  renderBars('product');
  renderBars('owner');
}

document.addEventListener('click', e => {
  const clear = e.target.closest('[data-clear]');
  if (clear) {
    const dim = clear.dataset.clear;
    if (dim === 'all') for (const d in filters) filters[d] = null;
    else filters[dim] = null;
    return render();
  }
  const bar = e.target.closest('[data-dim]');
  if (bar) toggle(bar.dataset.dim, bar.dataset.value);
});

// Theme: follows the system setting until the toggle is used, then remembers the choice.
const themeToggle = document.getElementById('theme-toggle');
const isDark = () => (document.documentElement.dataset.theme ||
  (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark';
const updateToggle = () => { themeToggle.textContent = isDark() ? 'Light mode' : 'Dark mode'; };
themeToggle.addEventListener('click', () => {
  const next = isDark() ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('theme', next); } catch (e) {}
  updateToggle();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', updateToggle);
updateToggle();

fetch('data.json')
  .then(r => r.json())
  .then(data => {
    policies = data.policies;
    categories.month = Object.keys(sumBy(policies, DIMENSIONS.month.key)).sort();
    for (const dim of ['product', 'owner']) {
      const totals = sumBy(policies, DIMENSIONS[dim].key);
      categories[dim] = Object.keys(totals).sort((a, b) => totals[b] - totals[a]);
    }
    render();
  })
  .catch(err => {
    document.body.insertAdjacentHTML('beforeend', `<p>Could not load data.json: ${esc(err.message)}</p>`);
  });
