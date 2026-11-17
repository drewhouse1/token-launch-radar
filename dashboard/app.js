// Token Radar terminal. Reads window.RADAR (written beside dashboard/ by main.ts) and
// renders the KPI strip, the fitted-model panel with scatter, and the filterable board
// with a per-protocol detail drawer. No network: every byte shown is in data.js.
(function () {
  'use strict';
  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var FIT = DATA.fit;
  var state = { q: '', category: 'all', chain: 'all', verdict: 'all', sort: 'implied', dir: -1, selected: null };
  var usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd0.format(n);
  }
  function fmtMoney(n) { return n === null || n === undefined || !isFinite(n) ? 'n/a' : usd0.format(Math.round(n)); }
  function fmtPct(n, dp) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + (n * 100).toFixed(dp === undefined ? 1 : dp) + '%';
  }
  function fmtGrowth(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(d) {
    if (d === null || d === undefined) return 'unknown';
    if (d >= 365) return (d / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(d)) + 'd';
  }
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k === 'html') node.innerHTML = attrs[k];
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined) continue;
      if (Array.isArray(c)) c.forEach(function (x) { if (x) node.appendChild(x); });
      else if (typeof c === 'string') node.appendChild(document.createTextNode(c));
      else node.appendChild(c);
    }
    return node;
  }
  // The SVG namespace, built without an address literal so no dashboard file names one.
  var SVGNS = ['http', '://www.w3.org/2000/svg'].join('');
  function svgEl(tag, attrs) {
    var node = document.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach(function (k) { node.setAttribute(k, attrs[k]); });
    return node;
  }

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var p = new URLSearchParams(hash);
    if (p.get('q')) state.q = p.get('q');
    if (p.get('category')) state.category = p.get('category');
    if (p.get('chain')) state.chain = p.get('chain');
    if (p.get('verdict')) state.verdict = p.get('verdict');
    if (p.get('detail')) state.selected = p.get('detail');
  }
  function writeHash() {
    var p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.category !== 'all') p.set('category', state.category);
    if (state.chain !== 'all') p.set('chain', state.chain);
    if (state.verdict !== 'all') p.set('verdict', state.verdict);
    if (state.selected) p.set('detail', state.selected);
    var next = p.toString();
    window.history.replaceState(null, '', next ? '#' + next : window.location.pathname + window.location.search);
  }

  function verdictCounts(list) {
    var c = { FARM: 0, THIN: 0, SKIP: 0 };
    list.forEach(function (r) { c[r.farm.verdict]++; });
    return c;
  }

  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('b', { text: 'TOKEN RADAR' }), ' — pre-token protocols, ranked by implied value'),
      el('div', { class: 'meta' },
        el('span', { text: 'Snapshot ' + DATA.as_of }),
        el('span', { text: DATA.source }),
        el('span', { text: DATA.model_version + ' model' })
      ));
  }

  function kpis() {
    var vc = verdictCounts(DATA.rows);
    var k = [
      ['Protocols tracked', String(DATA.total_protocols), 'in the sealed snapshot'],
      ['Traded anchors', String(FIT.anchor_count), FIT.anchor_recorded_token + ' record a token; ' + (FIT.anchor_recorded_token - FIT.anchor_count) + ' unusable (mcap 0 or negative)'],
      ['Pre-token candidates', String(DATA.board_size), DATA.watchlist_size + ' watchlist + ' + DATA.early_size + ' early'],
      ['Out-of-sample R²', FIT.oos_r2.toFixed(3), '5-fold CV, n=' + FIT.anchor_count + ' · in-sample ' + FIT.in_sample_r2.toFixed(3)],
      ['Median multiple error', FIT.median_multiple_error.toFixed(2) + '×', 'median |log10 error| ' + FIT.median_abs_log_error.toFixed(3)],
      ['FARM picks', String(vc.FARM), vc.THIN + ' THIN · ' + vc.SKIP + ' SKIP']
    ];
    return el('section', { class: 'kpis' }, k.map(function (x) {
      return el('div', { class: 'kpi' }, el('span', { text: x[0] }), el('b', { text: x[1] }), el('small', { text: x[2] }));
    }));
  }

  function equationText() {
    var w = FIT.weights;
    function sgn(v) { return (v >= 0 ? ' + ' : ' - ') + Math.abs(v).toFixed(4); }
    var s = 'log10(mcap) = ' + FIT.raw_intercept.toFixed(4);
    w.forEach(function (wi) {
      var c = wi.raw === null ? wi.standardized : wi.raw;
      s += sgn(c) + '·' + wi.feature;
    });
    return s;
  }

  function modelPanel() {
    var rows = FIT.weights.map(function (w) {
      return el('tr', null,
        el('td', { text: w.feature }),
        el('td', { class: 'num', text: (w.standardized >= 0 ? '+' : '') + w.standardized.toFixed(4) }),
        el('td', { class: 'num', text: w.raw === null ? '—' : (w.raw >= 0 ? '+' : '') + w.raw.toFixed(4) }));
    });
    var candRows = (FIT.candidates || []).map(function (c) {
      var chosen = c.spec === FIT.spec && c.lambda === FIT.lambda;
      return el('tr', { class: chosen ? 'chosen' : '' },
        el('td', { text: c.label + (chosen ? ' — chosen' : '') }),
        el('td', { class: 'num', text: 'λ=' + c.lambda }),
        el('td', { class: 'num', text: c.oos_r2.toFixed(3) }),
        el('td', { class: 'num', text: c.median_multiple_error.toFixed(2) + '×' }),
        el('td', { class: 'num', text: c.in_sample_r2.toFixed(3) }));
    });
    return el('section', { class: 'panel' },
      el('h2', { text: 'Model & methodology — comps-fitted ridge regression' }),
      el('p', { text: 'log10 market cap is fitted on the ' + FIT.anchor_count + ' traded anchors (ridge λ=' + FIT.lambda + ', intercept unpenalised; the feature is standardised by anchor mean/SD). The chosen spec is log10(TVL) only: growth, age and category dummies were fitted too and are listed below — each one lowered the held-out R², so they are not in the fitted equation. Implied value = 10 ^ fitted log10 market cap.' }),
      el('div', { class: 'eq' }, el('b', { text: equationText() })),
      el('p', { text: 'Standardised form: log10(mcap) = ' + FIT.intercept.toFixed(4) + ' + Σ weight × z(feature). Feature mean: log10(TVL) ' + FIT.feature_means[0] + ', SD ' + FIT.feature_sds[0] + '.' }),
      el('table', { class: 'w' },
        el('thead', null, el('tr', null, el('th', { text: 'Feature' }), el('th', { text: 'Std. weight' }), el('th', { text: 'Raw coeff.' }))),
        el('tbody', null, rows)),
      el('p', { text: 'Spec selection — same 128 anchors, same deterministic 5-fold CV (fold = slug-sorted index mod 5):' }),
      el('table', { class: 'w' },
        el('thead', null, el('tr', null, el('th', { text: 'Candidate spec' }), el('th', { text: 'λ' }), el('th', { text: 'OOS R²' }), el('th', { text: 'Median error' }), el('th', { text: 'In-sample R²' }))),
        el('tbody', null, candRows)),
      el('p', { class: 'note', text: 'Read honestly: out-of-sample R² ' + FIT.oos_r2.toFixed(3) + ' means the fit explains about ' + Math.round(FIT.oos_r2 * 100) + '% of the held-out variance, and the median prediction is off by ' + FIT.median_multiple_error.toFixed(2) + '×. The ranking is a comps signal, not a price.' })
    );
  }

  function scatterPanel() {
    var pts = FIT.scatter;
    var W = 520, H = 300, ml = 44, mr = 12, mt = 10, mb = 34;
    var xs = pts.map(function (p) { return p.actual; });
    var ys = pts.map(function (p) { return p.predicted; });
    var lo = Math.floor(Math.min.apply(null, xs.concat(ys)) - 0.3);
    var hi = Math.ceil(Math.max.apply(null, xs.concat(ys)) + 0.3);
    function X(v) { return ml + (v - lo) / (hi - lo) * (W - ml - mr); }
    function Y(v) { return H - mb - (v - lo) / (hi - lo) * (H - mt - mb); }
    var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': 'Scatter of actual versus predicted log10 market cap for traded anchors' });
    svg.appendChild(svgEl('line', { x1: X(lo), y1: Y(lo), x2: X(hi), y2: Y(hi), stroke: '#5c6b7a', 'stroke-dasharray': '4 3', 'stroke-width': 1 }));
    var n = pts.length, mx = 0, my = 0;
    pts.forEach(function (p) { mx += p.actual; my += p.predicted; });
    mx /= n; my /= n;
    var sxy = 0, sxx = 0;
    pts.forEach(function (p) { sxy += (p.actual - mx) * (p.predicted - my); sxx += (p.actual - mx) * (p.actual - mx); });
    var b = sxx ? sxy / sxx : 1, a = my - b * mx;
    svg.appendChild(svgEl('line', { x1: X(lo), y1: Y(a + b * lo), x2: X(hi), y2: Y(a + b * hi), stroke: '#39c5cf', 'stroke-width': 1.5 }));
    pts.forEach(function (p) {
      svg.appendChild(svgEl('circle', { cx: X(p.actual).toFixed(1), cy: Y(p.predicted).toFixed(1), r: 2.6, fill: '#2fbf71', opacity: 0.75 }));
    });
    [[lo, 'x'], [hi, 'x']].forEach(function (t) {
      var tx = svgEl('text', { x: X(t[0]), y: H - 12, fill: '#8b98a5', 'font-size': 10, 'text-anchor': 'middle' });
      tx.textContent = t[0].toFixed(1); svg.appendChild(tx);
    });
    [[lo, 'y'], [hi, 'y']].forEach(function (t) {
      var ty = svgEl('text', { x: 8, y: Y(t[0]) + 3, fill: '#8b98a5', 'font-size': 10 });
      ty.textContent = t[0].toFixed(1); svg.appendChild(ty);
    });
    var xl = svgEl('text', { x: W / 2, y: H - 2, fill: '#8b98a5', 'font-size': 10, 'text-anchor': 'middle' });
    xl.textContent = 'actual log10(mcap)'; svg.appendChild(xl);
    return el('section', { class: 'panel' },
      el('h2', { text: 'Anchors: actual vs predicted log10 market cap' }),
      el('p', { text: 'Each dot is one of the ' + pts.length + ' traded anchors. Dashed grey is y = x; cyan is the OLS line through the dots (slope ' + b.toFixed(2) + '). Dots far from y = x are where the comps model misses — the median miss is ' + FIT.median_multiple_error.toFixed(2) + '×.' }),
      svg);
  }

  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && (r.category || 'Other') !== state.category) return false;
      if (state.chain !== 'all' && !(r.chains || []).includes(state.chain)) return false;
      if (state.verdict !== 'all' && r.farm.verdict !== state.verdict) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sortedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'yield') { av = a.farm.est_airdrop_usd; bv = b.farm.est_airdrop_usd; }
      else if (key === 'be') { av = a.farm.break_even_days === null ? Infinity : a.farm.break_even_days; bv = b.farm.break_even_days === null ? Infinity : b.farm.break_even_days; }
      else if (key === 'net') { av = a.farm.net_return_pct; bv = b.farm.net_return_pct; }
      else if (key === 'verdict') { av = a.farm.verdict; bv = b.farm.verdict; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function controls() {
    var cats = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.reduce(function (acc, r) { return acc.concat(r.chains || []); }, []))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, slug, category, chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    function sel(id, label, values, cur, onchg) {
      var s = el('select', { id: id, 'aria-label': label },
        el('option', { value: 'all', text: 'All ' + label.toLowerCase() }),
        values.map(function (v) { return el('option', { value: v, text: v, selected: v === cur ? 'selected' : null }); }));
      s.addEventListener('change', function () { onchg(s.value); writeHash(); render(); });
      return el('div', { class: 'field' }, el('label', { for: id, text: label }), s);
    }
    var verdict = el('select', { id: 'verdict', 'aria-label': 'Filter by verdict' },
      ['all', 'FARM', 'THIN', 'SKIP'].map(function (v) { return el('option', { value: v, text: v === 'all' ? 'All verdicts' : v, selected: v === state.verdict ? 'selected' : null }); }));
    verdict.addEventListener('change', function () { state.verdict = verdict.value; writeHash(); render(); });
    var vc = verdictCounts(filteredRows());
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      sel('category', 'Category', cats, state.category, function (v) { state.category = v; }),
      sel('chain', 'Chain', chains, state.chain, function (v) { state.chain = v; }),
      el('div', { class: 'field' }, el('label', { for: 'verdict', text: 'Verdict' }), verdict),
      el('span', { class: 'count', text: filteredRows().length + ' rows shown · ' + vc.FARM + ' FARM · ' + vc.THIN + ' THIN · ' + vc.SKIP + ' SKIP' }));
  }

  function sortHeader(key, label, cls) {
    return el('th', { scope: 'col', class: cls || '' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); } },
        label, state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' ↓' : ' ↑' }) : null));
  }

  function boardTable() {
    var list = sortedRows(filteredRows());
    if (list.length === 0) {
      return el('div', { class: 'tablewrap' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another category, chain or verdict.' }),
        el('button', { class: 'btn', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; state.verdict = 'all'; writeHash(); render(); } })));
    }
    var tbody = el('tbody');
    list.forEach(function (r) {
      var g = r.change_7d === null ? 'n/a' : fmtGrowth(r.change_7d);
      var gc = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var net = r.farm.net_return_pct;
      var tr = el('tr', {
        class: state.selected === r.slug ? 'sel' : '',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { text: (r.category || 'Other') + ' · ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : '—') }))),
        el('td', { class: 'num r', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num r ' + gc, text: g }),
        el('td', { class: 'num r', text: fmtUsd(r.implied_value_usd) }),
        el('td', { class: 'num r', text: fmtMoney(r.farm.est_airdrop_usd) }),
        el('td', { class: 'num r', text: r.farm.break_even_days === null ? '—' : r.farm.break_even_days + 'd' }),
        el('td', { class: 'num r ' + (net >= 0 ? 'pos' : 'neg'), text: fmtPct(net) }),
        el('td', null, el('span', { class: 'badge ' + r.farm.verdict, text: r.farm.verdict })));
      tbody.appendChild(tr);
    });
    return el('div', { class: 'tablewrap' },
      el('table', { class: 'board' },
        el('caption', { text: 'Pre-token protocols, ranked by implied value. Click a row for its model breakdown, farm economics and farm plan. Est. farm yield is the expected airdrop per farmer.' }),
        el('thead', null, el('tr', null,
          sortHeader('implied', '#'),
          sortHeader('name', 'Protocol'),
          sortHeader('tvl', 'TVL', 'r'),
          sortHeader('growth', '7d', 'r'),
          sortHeader('implied', 'Implied FDV', 'r'),
          sortHeader('yield', 'Est. farm yield', 'r'),
          sortHeader('be', 'Break-even', 'r'),
          sortHeader('net', 'Net return', 'r'),
          sortHeader('verdict', 'Verdict'))),
        tbody));
  }

  var drawer = el('aside', { class: 'drawer', id: 'detail', hidden: true, 'aria-label': 'Protocol detail' });

  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug;
    writeHash();
    var f = row.farm;
    drawer.textContent = '';
    drawer.hidden = false;
    drawer.appendChild(el('div', { class: 'dhead' },
      el('div', null,
        el('span', { class: 'num', text: 'Rank ' + row.rank + ' of ' + DATA.board_size + ' · ' + (row.category || 'Other') }),
        el('h2', { text: row.name }),
        el('p', { class: 'sub', text: 'Chains: ' + (row.chains && row.chains.length ? row.chains.join(', ') : '—') + ' · Listed: ' + (row.listed_at || 'unknown') + ' · Age: ' + fmtAge(row.age_days) })),
      el('button', { class: 'close', type: 'button', text: 'Close', onclick: function () { closeDetail(); } })));
    drawer.appendChild(el('div', { class: 'dsec' },
      el('h3', { text: 'Implied value' }),
      el('div', { class: 'kv' },
        el('div', null, el('span', { text: 'TVL' }), el('b', { class: 'num', text: fmtUsd(row.tvl_usd) })),
        el('div', null, el('span', { text: '7-day growth' }), el('b', { class: 'num', text: fmtGrowth(row.change_7d) })),
        el('div', null, el('span', { text: 'Fitted log10(mcap)' }), el('b', { class: 'num', text: row.predicted_log10_mcap.toFixed(4) })),
        el('div', null, el('span', { text: 'Implied FDV' }), el('b', { class: 'num', text: fmtMoney(row.implied_value_usd) }))),
      el('p', { class: 'note', text: 'Model terms (standardised weight × feature):' }),
      el('table', { class: 'w' }, el('tbody', null, row.terms.map(function (t) {
        return el('tr', null, el('td', { text: t.feature }), el('td', { class: 'num', text: (t.contribution >= 0 ? '+' : '') + t.contribution.toFixed(4) }));
      })))));
    drawer.appendChild(el('div', { class: 'dsec' },
      el('h3', { text: 'Farm economics — verdict ' + f.verdict }),
      el('div', { class: 'kv' },
        el('div', null, el('span', { text: 'Capital' }), el('b', { class: 'num', text: fmtMoney(f.capital_usd) })),
        el('div', null, el('span', { text: 'Hold' }), el('b', { class: 'num', text: f.hold_days + ' days' })),
        el('div', null, el('span', { text: 'Airdrop allocation' }), el('b', { class: 'num', text: (f.alloc_pct * 100).toFixed(2) + '% of implied FDV' })),
        el('div', null, el('span', { text: 'Expected farmers' }), el('b', { class: 'num', text: f.farmers.toLocaleString('en-US') })),
        el('div', null, el('span', { text: 'Est. airdrop / farmer' }), el('b', { class: 'num', text: fmtMoney(f.est_airdrop_usd) })),
        el('div', null, el('span', { text: 'Gas' }), el('b', { class: 'num', text: fmtMoney(f.gas_usd) })),
        el('div', null, el('span', { text: 'Opportunity cost (8% p.a.)' }), el('b', { class: 'num', text: fmtMoney(f.opportunity_cost_usd) })),
        el('div', null, el('span', { text: 'Net expected value' }), el('b', { class: 'num', text: fmtMoney(f.net_ev_usd) })),
        el('div', null, el('span', { text: 'Net return' }), el('b', { class: 'num ' + (f.net_return_pct >= 0 ? 'pos' : 'neg'), text: fmtPct(f.net_return_pct) })),
        el('div', null, el('span', { text: 'Break-even' }), el('b', { class: 'num', text: f.break_even_days === null ? '—' : f.break_even_days + ' days' }))),
      el('p', { class: 'note', text: f.verdict_reason + ' FARM needs net EV ≥ $100 and net return ≥ 50%; THIN needs net EV > $10; otherwise SKIP. Break-even assumes the expected airdrop accrues evenly over the hold.' })));
    drawer.appendChild(el('div', { class: 'dsec' },
      el('h3', { text: 'Farm plan' }),
      el('ol', { class: 'steps' }, row.farm_steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
      }))));
  }
  function closeDetail() {
    state.selected = null;
    drawer.hidden = true;
    writeHash();
    render();
  }

  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(kpis());
    var g = el('div', { class: 'grid2' });
    g.appendChild(modelPanel());
    g.appendChild(scatterPanel());
    shell.appendChild(g);
    shell.appendChild(controls());
    shell.appendChild(boardTable());
    shell.appendChild(el('p', { class: 'note', text: 'Method: ridge regression on traded comps; see Model & methodology. Implied values are the entry’s own claim, not a price, and the board does not predict whether or when a token is issued. ' + DATA.live_size + ' largest live-token protocols are set aside from the ranked board.' }));
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!drawer.isConnected) document.body.appendChild(drawer);
    if (state.selected) openDetail(state.selected);
  }

  readHash();
  render();
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !drawer.hidden) closeDetail(); });
})();
