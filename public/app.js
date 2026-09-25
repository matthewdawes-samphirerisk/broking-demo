const gbp = n => '£' + Math.round(n).toLocaleString('en-GB');
// Compact amounts for labels; small values keep enough precision to be meaningful once filtered.
const gbpK = n => n < 1000 ? gbp(n)
  : n < 10000 ? '£' + (n / 1000).toFixed(1) + 'k'
  : n < 1e6 ? '£' + Math.round(n / 1000).toLocaleString('en-GB') + 'k'
  : '£' + (n / 1e6).toFixed(2) + 'm';

// '2025-03' -> 'Mar25'
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const mmmYr = ym => MONTHS[+ym.slice(5, 7) - 1] + ym.slice(2, 4);
const monthLong = ym => new Date(ym + '-01').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

// One filter per chart; null means no filter from that chart.
const DIMENSIONS = {
  month:   { label: 'Month',         key: p => p.inception.slice(0, 7), show: mmmYr },
  product: { label: 'Product line',  key: p => p.product,               show: v => v },
  owner:   { label: 'Account owner', key: p => p.owner,                 show: v => v },
};
const filters = { month: null, product: null, owner: null };
const tableView = { month: false, product: false, owner: false };

let policies = [];
const categories = {}; // fixed bar order per chart, so bars don't jump around when filtering

// Small DOM helper. Text always goes in via textContent, never innerHTML.
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('data-')) node.setAttribute(k, v);
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

// Rows passing every active filter, optionally ignoring one chart's own filter.
function filtered(except) {
  return policies.filter(p =>
    Object.entries(filters).every(([dim, val]) => dim === except || val === null || DIMENSIONS[dim].key(p) === val));
}

function aggregate(rows, dim) {
  const out = {};
  for (const r of rows) {
    const k = DIMENSIONS[dim].key(r);
    const a = out[k] || (out[k] = { revenue: 0, gwp: 0, count: 0 });
    a.revenue += r.revenue; a.gwp += r.gwp; a.count += 1;
  }
  return out;
}

function toggle(dim, value) {
  filters[dim] = filters[dim] === value ? null : value;
  render();
}

function stateClass(dim, name) {
  const sel = filters[dim];
  return sel === null ? '' : sel === name ? ' selected' : ' dimmed';
}

// A clickable, keyboard-reachable mark. Carries its tooltip content in dataset.
function markAttrs(dim, name, agg, cls) {
  const label = DIMENSIONS[dim].show(name);
  return {
    class: cls + stateClass(dim, name),
    'data-dim': dim, 'data-value': name,
    'data-tip-value': gbp(agg.revenue),
    'data-tip-name': dim === 'month' ? monthLong(name) : name,
    'data-tip-extra': `${agg.count} ${agg.count === 1 ? 'policy' : 'policies'} · GWP ${gbpK(agg.gwp)}`,
    role: 'button', tabindex: '0',
    'aria-pressed': String(filters[dim] === name),
    'aria-label': `${label}: revenue ${gbp(agg.revenue)}`,
  };
}

// Round axis maximum and step: 1, 2 or 5 × 10^n.
function niceScale(max, ticks = 5) {
  if (max <= 0) return { top: 1, step: 1 };
  const raw = max / ticks, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw);
  return { top: Math.ceil(max / step) * step, step };
}

const ZERO = { revenue: 0, gwp: 0, count: 0 };

function renderMonths() {
  const totals = aggregate(filtered('month'), 'month');
  const months = categories.month;
  const { top, step } = niceScale(Math.max(0, ...Object.values(totals).map(a => a.revenue)));

  const yaxis = el('div', { class: 'yaxis', 'aria-hidden': 'true' });
  const plot = el('div', { class: 'plot' });
  for (let v = 0; v <= top + 1e-9; v += step) {
    const pct = (v / top) * 100;
    yaxis.append(el('span', { style: `bottom:${pct}%`, text: gbpK(v) }));
    if (v > 0) plot.append(el('div', { class: 'gridline', style: `bottom:${pct}%` }));
  }
  const cols = el('div', { class: 'cols' });
  for (const m of months) {
    const a = totals[m] || ZERO;
    cols.append(el('div', markAttrs('month', m, a, 'col'),
      el('div', { class: 'bar', style: `height:${(a.revenue / top) * 100}%` })));
  }
  plot.append(cols);

  const labels = el('div', { class: 'xlabels', 'aria-hidden': 'true' },
    ...months.map(m => el('div', {}, el('span', { text: mmmYr(m) }))));

  document.getElementById('by-month').replaceChildren(el('div', { class: 'colchart' }, yaxis, plot, labels));
  fitMonthLabels();
  renderTable('month', months, totals);
}

// Month labels run horizontally when there's room, vertically when columns get narrow.
function fitMonthLabels() {
  const labels = document.querySelector('#by-month .xlabels');
  if (!labels) return;
  const colWidth = labels.clientWidth / categories.month.length;
  labels.classList.toggle('vertical', colWidth < 32);
}
new ResizeObserver(fitMonthLabels).observe(document.getElementById('by-month'));

function renderBars(dim) {
  const totals = aggregate(filtered(dim), dim);
  const max = Math.max(1, ...Object.values(totals).map(a => a.revenue));
  const chart = el('div', { class: 'barchart' });
  for (const name of categories[dim]) {
    const a = totals[name] || ZERO;
    // Scale to 82% of the track so the value label always fits at the bar tip.
    chart.append(el('div', markAttrs(dim, name, a, 'brow'),
      el('div', { class: 'bname', text: name }),
      el('div', { class: 'btrack' },
        el('div', { class: 'bar', style: `width:${(a.revenue / max) * 82}%` }),
        el('span', { class: 'bval', text: gbpK(a.revenue) }))));
  }
  document.getElementById('by-' + dim).replaceChildren(chart);
  renderTable(dim, categories[dim], totals);
}

// Table twin of each chart: every value readable without hovering.
function renderTable(dim, keys, totals) {
  const sum = Object.values(totals).reduce((s, a) => s + a.revenue, 0) || 1;
  const head = el('tr', {}, ...[DIMENSIONS[dim].label, 'Policies', 'GWP', 'Revenue', 'Share'].map(h => el('th', { scope: 'col', text: h })));
  const body = keys.map(k => {
    const a = totals[k] || ZERO;
    return el('tr', { class: filters[dim] === k ? 'selected' : '' },
      el('td', { text: dim === 'month' ? monthLong(k) : k }),
      el('td', { text: a.count.toLocaleString('en-GB') }),
      el('td', { text: gbp(a.gwp) }),
      el('td', { text: gbp(a.revenue) }),
      el('td', { text: ((a.revenue / sum) * 100).toFixed(1) + '%' }));
  });
  document.getElementById('table-' + dim).replaceChildren(el('table', {}, el('thead', {}, head), el('tbody', {}, ...body)));
}

function applyViews() {
  for (const dim of Object.keys(tableView)) {
    document.getElementById('by-' + dim).hidden = tableView[dim];
    document.getElementById('table-' + dim).hidden = !tableView[dim];
    const btn = document.querySelector(`[data-view="${dim}"]`);
    btn.textContent = tableView[dim] ? 'Chart' : 'Table';
    btn.setAttribute('aria-pressed', String(tableView[dim]));
  }
}

function renderFilters() {
  const box = document.getElementById('filters');
  const active = Object.entries(filters).filter(([, v]) => v !== null);
  if (active.length === 0) {
    box.replaceChildren(el('span', { class: 'none', text: 'No filters applied. Click any bar to filter the page.' }));
    return;
  }
  box.replaceChildren(
    el('span', { class: 'label', text: 'Filtered by' }),
    ...active.map(([dim, v]) => el('span', { class: 'chip' },
      el('span', { class: 'dim', text: DIMENSIONS[dim].label }),
      el('b', { text: DIMENSIONS[dim].show(v) }),
      el('button', { type: 'button', 'data-clear': dim, 'aria-label': `Remove ${DIMENSIONS[dim].label} filter`, title: 'Remove this filter', text: '×' }))),
    el('button', { type: 'button', class: 'btn clear-all', 'data-clear': 'all', text: 'Clear all' }));
}

function render() {
  const rows = filtered();
  const gwp = rows.reduce((s, p) => s + p.gwp, 0);
  const revenue = rows.reduce((s, p) => s + p.revenue, 0);
  document.getElementById('gwp').textContent = gbp(gwp);
  document.getElementById('revenue').textContent = gbp(revenue);
  document.getElementById('policies').textContent =
    rows.length === policies.length ? policies.length.toLocaleString('en-GB') : `${rows.length} of ${policies.length}`;
  document.getElementById('rate').textContent = gwp ? ((revenue / gwp) * 100).toFixed(1) + '%' : '–';
  renderFilters();
  renderMonths();
  renderBars('product');
  renderBars('owner');
  applyViews();
  hideTip();
}

// ---------- Tooltip ----------
const tip = document.getElementById('tooltip');
function showTip(mark, x, y) {
  tip.replaceChildren(
    el('div', { class: 'tv', text: mark.dataset.tipValue }),
    el('div', { text: mark.dataset.tipName }),
    el('div', { class: 'tn', text: mark.dataset.tipExtra }));
  tip.hidden = false;
  const r = tip.getBoundingClientRect(), pad = 12;
  let left = x + pad, top = y - r.height - pad;
  if (left + r.width > innerWidth - 8) left = x - r.width - pad;
  if (top < 8) top = y + pad;
  tip.style.left = Math.max(8, left) + 'px';
  tip.style.top = top + 'px';
}
function hideTip() { tip.hidden = true; }

document.addEventListener('pointermove', e => {
  if (e.pointerType === 'touch') return; // taps filter; values are in the table view
  const mark = e.target.closest('[data-tip-value]');
  if (mark) showTip(mark, e.clientX, e.clientY); else hideTip();
});
document.addEventListener('focusin', e => {
  const mark = e.target.closest('[data-tip-value]');
  if (mark && mark.matches(':focus-visible')) {
    const r = mark.getBoundingClientRect();
    showTip(mark, r.left + r.width / 2, r.top);
  } else hideTip();
});
document.addEventListener('scroll', hideTip, { passive: true });

// ---------- Clicks & keys ----------
document.addEventListener('click', e => {
  const clear = e.target.closest('[data-clear]');
  if (clear) {
    const dim = clear.dataset.clear;
    if (dim === 'all') for (const d in filters) filters[d] = null;
    else filters[dim] = null;
    return render();
  }
  const view = e.target.closest('[data-view]');
  if (view) {
    tableView[view.dataset.view] = !tableView[view.dataset.view];
    return applyViews();
  }
  const mark = e.target.closest('[data-dim]');
  if (mark) toggle(mark.dataset.dim, mark.dataset.value);
});

document.addEventListener('keydown', e => {
  const mark = e.target.closest && e.target.closest('[data-dim]');
  if (!mark || (e.key !== 'Enter' && e.key !== ' ')) return;
  e.preventDefault();
  const { dim, value } = mark.dataset;
  toggle(dim, value);
  document.querySelector(`[data-dim="${dim}"][data-value="${CSS.escape(value)}"]`)?.focus();
});

// ---------- Theme ----------
// Follows the system setting until the toggle is used, then remembers the choice.
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

// ---------- Load ----------
fetch('api/policies')
  .then(r => r.ok ? r.json() : Promise.reject(new Error(`server returned ${r.status}`)))
  .then(data => {
    policies = data.policies;
    for (const dim of Object.keys(DIMENSIONS)) {
      const totals = aggregate(policies, dim);
      categories[dim] = dim === 'month'
        ? Object.keys(totals).sort()
        : Object.keys(totals).sort((a, b) => totals[b].revenue - totals[a].revenue);
    }
    const m = categories.month;
    document.getElementById('period').textContent =
      `Policies incepting ${monthLong(m[0])} to ${monthLong(m[m.length - 1])} · demo data, entirely fictitious`;
    render();
  })
  .catch(err => {
    document.querySelector('.page').append(el('p', { text: `Could not load the policy data (${err.message}). Try refreshing the page.` }));
  });
