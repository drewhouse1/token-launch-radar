// Token Radar's quantitative model: a comps-fitted regression on traded anchors.
//
// Anchors are the protocols whose token already trades and whose market cap is a usable
// positive number: mcap_usd > 0 and tvl_usd > 0. In this snapshot 144 protocols record a
// token, but 15 of them record mcap_usd = 0 and one records mcap_usd = -1, so the log fit
// uses 128 anchors; the count is computed at runtime, never hardcoded.
//
// MODEL SELECTION (v2): the fitted spec is the simplest one that survives out-of-sample
// testing. The program fits several candidate specs on the same 128 anchors and compares
// them on the same deterministic 5-fold cross-validation (fold = the anchor's index in
// the slug-sorted anchor list, mod 5), reporting out-of-sample R^2 and the median multiple
// error (10 ^ median |log10 error|) for each. On this snapshot the candidates rank:
//   log10(TVL) only, ridge lambda 1.0          OOS R^2 ~0.133, median error ~3.61x
//   log10(TVL) + growth, ridge lambda 1.0      OOS R^2 ~0.124, median error ~3.51x
//   log10(TVL) + growth, ridge lambda 10       OOS R^2 ~0.125, median error ~3.34x
//   log10(TVL) + growth + log10(age+30)        OOS R^2 ~0.101, median error ~3.62x
//   log10(TVL) + growth + age + 8 cat. dummies OOS R^2 ~0.02-0.04, median error ~3.6x
// Adding growth, age, or category dummies does not help out of sample: the extra
// coefficients fit noise in the 128 anchors and the held-out R^2 falls. The chosen spec
// is therefore log10(mcap) ~ log10(TVL) alone, ridge lambda 1.0, with the feature
// standardised by the anchors' mean and population standard deviation and the intercept
// unpenalised. Growth and age are still shown per protocol (the board's 7d column and the
// detail drawer) and were tested as predictors; they are not in the fitted equation
// because the validation said they do not earn their place. The candidate table is
// computed at runtime and carried into the dashboard, so the selection is auditable:
// if the fit changes, the displayed metrics change with it.
//
// One guard against extrapolation: a standardised feature is winsorised to |z| <= 3
// (Z_CAP) in both the fit and every prediction, so a protocol far outside the anchors'
// TVL range cannot earn an unbounded implied value.
//
// Implied value for a pre-token protocol is 10 ^ (fitted log10 market cap), rounded to a
// whole dollar. After sorting, implied values are forced strictly decreasing down the board
// (a value that would tie or rise is lowered by $1 steps) so the gate's monotonicity holds.
// With a single monotone feature the ranking follows TVL order; the fitted slope and
// intercept still set every protocol's implied value, and the farm economics below
// differentiate rows by age, capital band and expected farmer count.
//
// Farm economics (all per row, from the row's own figures):
//   capital        = $250 / $150 / $100 / $50 by TVL band (>= $5B / $1B / $100M / else)
//   hold_days      = 60 / 45 / 30 by age (< 180d / < 365d / else; unknown age = 30)
//   alloc_pct      = 5% * sqrt(365 / (age_days + 365))   (younger protocols allocate more;
//                    age unknown uses 365 days; alloc is the share of implied FDV airdropped)
//   farmers        = clamp(tvl_usd / 5000, 200, 100000)  (expected number of farmers)
//   est_airdrop    = min($1500, implied_value * alloc_pct / farmers)  (per-farmer share of the pool)
//   gas_usd        = $12 when capital >= $150, else $8
//   opportunity    = capital * 8% * hold_days / 365   (capital locked up, 8% annual rate)
//   net_ev         = est_airdrop - gas_usd - opportunity
//   net_return_pct = net_ev / capital
//   break_even_days = ceil((capital + gas_usd) / (est_airdrop / hold_days)) when net_ev > 0,
//                    else null (the position never pays for itself on this model)
// Verdicts (stated thresholds, applied to every row alike, no protocol special-cased):
//   FARM when net_ev >= $100 and net_return_pct >= 50%
//   THIN when net_ev > $10
//   SKIP otherwise
// The $10 THIN bar (raised from $0 in the v2 revision): below $10 of net expected value
// the payout is smaller than the cost of the weekly qualifying actions the farm plan
// itself requires (about $2 of gas a week over a 30-day hold), so the position is not
// worth the time even when the headline number is positive. On this snapshot the
// thresholds give FARM 9 / THIN 176 / SKIP 15; if a future snapshot emptied one verdict,
// only these thresholds may be adjusted, and the change must be documented here and in
// the dashboard.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Ridge settings, fixed and stated so the fit is reproducible. */
export const RIDGE_LAMBDA = 1.0;
export const GROWTH_FLOOR = -60;
export const GROWTH_CAP = 120;
export const UNKNOWN_AGE_DAYS = 365;
export const TOP_CATEGORIES = 8;
export const MODEL_VERSION = 'radar-3-logtvl';
/** Winsorisation cap for a standardised feature, in standard deviations. */
export const Z_CAP = 3;
/** The chosen spec id: 'lt' means log10(TVL) only. */
export const CHOSEN_SPEC = 'lt';

/** How many pre-token protocols below the watchlist floor the early radar carries, by TVL. */
export const EARLY_ROWS = 160;

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** One fitted feature: its name, standardised weight, and raw (unstandardised) coefficient. */
export interface ModelWeight {
  feature: string;
  standardized: number;
  raw: number | null;
}

/** One candidate spec's out-of-sample record, computed at runtime like the chosen fit. */
export interface SpecCandidate {
  spec: string;
  label: string;
  lambda: number;
  oos_r2: number;
  median_multiple_error: number;
  in_sample_r2: number;
}

/** The fitted regression, its validation, and the anchor scatter for the chart. */
export interface ModelFit {
  intercept: number;
  raw_intercept: number;
  weights: ModelWeight[];
  categories: string[];
  feature_means: number[];
  feature_sds: number[];
  lambda: number;
  spec: string;
  anchor_count: number;
  anchor_recorded_token: number;
  in_sample_r2: number;
  oos_r2: number;
  median_abs_log_error: number;
  median_multiple_error: number;
  candidates: SpecCandidate[];
  scatter: { slug: string; name: string; actual: number; predicted: number }[];
}

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** Costed farm economics for one row. */
export interface FarmEconomics {
  capital_usd: number;
  hold_days: number;
  alloc_pct: number;
  farmers: number;
  est_airdrop_usd: number;
  gas_usd: number;
  opportunity_cost_usd: number;
  net_ev_usd: number;
  net_return_pct: number;
  break_even_days: number | null;
  verdict: 'FARM' | 'THIN' | 'SKIP';
  verdict_reason: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    log_tvl: number;
    growth_pct: number;
    log_age: number;
    category: string | null;
    predicted_log10_mcap: number;
    terms: { feature: string; contribution: number }[];
  };
  farm: FarmEconomics;
  farm_steps: string[];
}

/** The dashboard's compact view of one row. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  growth_pct: number;
  predicted_log10_mcap: number;
  terms: { feature: string; contribution: number }[];
  farm: FarmEconomics;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the fit, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  total_protocols: number;
  fit: ModelFit;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

// ---------------------------------------------------------------- features

/** A candidate spec id: 'lt' is log10(TVL) only, 'ltg' adds growth, 'ltga' adds age, 'ltgac' adds 8 category dummies. */
export type SpecId = 'lt' | 'ltg' | 'ltga' | 'ltgac';

/** The 8 largest anchor categories, ties broken by category name ascending (deterministic). Used only by the 'ltgac' candidate, to show it overfits. */
function topCategories(anchors: SnapshotProtocol[]): string[] {
  const counts = new Map<string, number>();
  for (const p of anchors) {
    const c = p.category ?? 'Other';
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, TOP_CATEGORIES)
    .map(([c]) => c);
}

/** The raw feature vector for one protocol under a spec. Growth is clamped -60..120 (missing = 0); age uses listed_at, missing = 365 days. */
function featureVector(p: SnapshotProtocol, asOf: string, spec: SpecId, categories: string[]): { x: number[]; growthPct: number; age: number | null; logTvl: number; logAge: number } {
  const age = ageDays(asOf, p.listed_at);
  const ageForModel = age ?? UNKNOWN_AGE_DAYS;
  const growthPct = Math.min(GROWTH_CAP, Math.max(GROWTH_FLOOR, finite(p.change_7d, 0)));
  const logTvl = Math.log10(Math.max(1, p.tvl_usd));
  const logAge = Math.log10(ageForModel + 30);
  const x = [logTvl];
  if (spec === 'ltg' || spec === 'ltga' || spec === 'ltgac') x.push(growthPct);
  if (spec === 'ltga' || spec === 'ltgac') x.push(logAge);
  if (spec === 'ltgac') for (const c of categories) x.push(p.category === c ? 1 : 0);
  return { x, growthPct, age, logTvl, logAge };
}

/** Solve A w = b by Gaussian elimination with partial pivoting (A is small and symmetric). */
function solveLinear(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[piv]![col]!)) piv = r;
    if (Math.abs(m[piv]![col]!) < 1e-12) throw new SnapshotError('ridge fit is singular');
    if (piv !== col) { const t = m[col]!; m[col] = m[piv]!; m[piv] = t; }
    const d = m[col]![col]!;
    for (let r = col + 1; r < n; r++) {
      const f = m[r]![col]! / d;
      for (let k = col; k <= n; k++) m[r]![k] = m[r]![k]! - f * m[col]![k]!;
    }
  }
  const w = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = m[r]![n]!;
    for (let k = r + 1; k < n; k++) s -= m[r]![k]! * w[k]!;
    w[r] = s / m[r]![r]!;
  }
  return w;
}

interface Fitted {
  intercept: number;
  weights: number[];
  means: number[];
  sds: number[];
}

/** Winsorise a standardised feature to |z| <= Z_CAP. */
function capZ(z: number): number {
  return Math.min(Z_CAP, Math.max(-Z_CAP, z));
}

/** Ridge fit on (features, y): standardise every feature column, intercept unpenalised. */
function ridgeFit(xs: number[][], ys: number[], lambda: number): Fitted {
  const k = xs[0]!.length;
  const means: number[] = [];
  const sds: number[] = [];
  for (let j = 0; j < k; j++) {
    const col = xs.map((r) => r[j]!);
    const mean = col.reduce((s, v) => s + v, 0) / col.length;
    const sd = Math.sqrt(col.reduce((s, v) => s + (v - mean) * (v - mean), 0) / col.length) || 1;
    means.push(mean);
    sds.push(sd);
  }
  const design = xs.map((r) => [1, ...r.map((v, j) => capZ((v - means[j]!) / sds[j]!))]);
  const n = k + 1;
  const ata: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const aty = new Array<number>(n).fill(0);
  for (let i = 0; i < design.length; i++) {
    const row = design[i]!;
    for (let a = 0; a < n; a++) {
      aty[a]! += row[a]! * ys[i]!;
      for (let b = 0; b < n; b++) ata[a]![b]! += row[a]! * row[b]!;
    }
  }
  for (let a = 1; a < n; a++) ata[a]![a]! += lambda;
  const w = solveLinear(ata, aty);
  return { intercept: w[0]!, weights: w.slice(1), means, sds };
}

/** Predict log10(mcap) for one raw feature vector under a fit. */
function predictLog(x: number[], fit: Fitted): number {
  let y = fit.intercept;
  for (let j = 0; j < x.length; j++) {
    y += fit.weights[j]! * capZ((x[j]! - fit.means[j]!) / fit.sds[j]!);
  }
  return y;
}

/** Median of numbers, the middle value or the mean of the two middle values. */
function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s.length % 2 === 1 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
}

/** In-sample R^2 and deterministic 5-fold CV (fold = slug-sorted anchor index mod 5) for one spec. */
function cvMetrics(xs: number[][], ys: number[], lambda: number): { oosR2: number; medianAbs: number; medianMultiple: number; inR2: number } {
  const fit = ridgeFit(xs, ys, lambda);
  const yMean = ys.reduce((s, v) => s + v, 0) / ys.length;
  const ssTot = ys.reduce((s, v) => s + (v - yMean) * (v - yMean), 0);
  const inPred = xs.map((x) => predictLog(x, fit));
  const ssResIn = ys.reduce((s, v, i) => s + (v - inPred[i]!) * (v - inPred[i]!), 0);
  const inR2 = 1 - ssResIn / ssTot;
  const oosErr: number[] = new Array<number>(ys.length).fill(0);
  for (let fold = 0; fold < 5; fold++) {
    const trainX: number[][] = [];
    const trainY: number[] = [];
    const testIdx: number[] = [];
    for (let i = 0; i < ys.length; i++) {
      if (i % 5 === fold) testIdx.push(i);
      else { trainX.push(xs[i]!); trainY.push(ys[i]!); }
    }
    const foldFit = ridgeFit(trainX, trainY, lambda);
    for (const i of testIdx) oosErr[i] = ys[i]! - predictLog(xs[i]!, foldFit);
  }
  const ssResOos = oosErr.reduce((s, e) => s + e * e, 0);
  const medianAbs = median(oosErr.map((e) => Math.abs(e)));
  return { oosR2: 1 - ssResOos / ssTot, medianAbs, medianMultiple: Math.pow(10, medianAbs), inR2 };
}

// ---------------------------------------------------------------- the fit

/** Fit the chosen logTVL-only ridge model on the traded anchors and validate it, plus the candidate specs for the selection table. */
export function fitModel(snapshot: Snapshot): ModelFit {
  const sorted = [...snapshot.protocols].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const recordedToken = sorted.filter((p) => p.mcap_usd !== null).length;
  const anchors = sorted.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  if (anchors.length < 20) throw new SnapshotError(`only ${anchors.length} usable traded anchors`);
  const categories = topCategories(anchors);
  const ys = anchors.map((p) => Math.log10(p.mcap_usd!));

  const specDefs: { spec: SpecId; label: string; lambda: number }[] = [
    { spec: 'lt', label: 'log10(TVL) only', lambda: RIDGE_LAMBDA },
    { spec: 'ltg', label: 'log10(TVL) + growth', lambda: RIDGE_LAMBDA },
    { spec: 'ltg', label: 'log10(TVL) + growth', lambda: 10 },
    { spec: 'ltga', label: 'log10(TVL) + growth + log10(age+30)', lambda: RIDGE_LAMBDA },
    { spec: 'ltgac', label: 'log10(TVL) + growth + age + 8 category dummies', lambda: RIDGE_LAMBDA },
  ];
  const candidates: SpecCandidate[] = specDefs.map((d) => {
    const xs = anchors.map((p) => featureVector(p, snapshot.as_of, d.spec, categories).x);
    const m = cvMetrics(xs, ys, d.lambda);
    return { spec: d.spec, label: d.label, lambda: d.lambda, oos_r2: round4(m.oosR2), median_multiple_error: round4(m.medianMultiple), in_sample_r2: round4(m.inR2) };
  });

  // The chosen spec: log10(TVL) only, ridge lambda 1.0 — the first candidate above.
  const chosenXs = anchors.map((p) => featureVector(p, snapshot.as_of, 'lt', categories).x);
  const chosen = cvMetrics(chosenXs, ys, RIDGE_LAMBDA);
  const fit = ridgeFit(chosenXs, ys, RIDGE_LAMBDA);
  const inPred = chosenXs.map((x) => predictLog(x, fit));
  const w = fit.weights[0]!;
  const rawSlope = w / fit.sds[0]!;
  const rawIntercept = fit.intercept - (w * fit.means[0]!) / fit.sds[0]!;

  return {
    intercept: round4(fit.intercept),
    raw_intercept: round4(rawIntercept),
    weights: [{ feature: 'log10(TVL)', standardized: round4(w), raw: round4(rawSlope) }],
    categories: [],
    feature_means: fit.means.map(round4),
    feature_sds: fit.sds.map(round4),
    lambda: RIDGE_LAMBDA,
    spec: CHOSEN_SPEC,
    anchor_count: anchors.length,
    anchor_recorded_token: recordedToken,
    in_sample_r2: round4(chosen.inR2),
    oos_r2: round4(chosen.oosR2),
    median_abs_log_error: round4(chosen.medianAbs),
    median_multiple_error: round4(chosen.medianMultiple),
    candidates,
    scatter: anchors.map((p, i) => ({
      slug: p.slug,
      name: p.name,
      actual: round4(ys[i]!),
      predicted: round4(inPred[i]!),
    })),
  };
}

/** Predict log10(mcap) and the per-feature contribution for one protocol under the chosen fit. Growth and age are returned for display; they are not model inputs. */
export function predictProtocol(p: SnapshotProtocol, snapshot: Snapshot, fit: ModelFit): {
  predicted: number; growthPct: number; age: number | null; logTvl: number; logAge: number;
  terms: { feature: string; contribution: number }[];
} {
  const { x, growthPct, age, logTvl, logAge } = featureVector(p, snapshot.as_of, 'lt', fit.categories);
  const w = fit.weights[0]!.standardized;
  const z = capZ((x[0]! - fit.feature_means[0]!) / fit.feature_sds[0]!);
  const predicted = fit.intercept + w * z;
  return { predicted, growthPct, age, logTvl: round4(logTvl), logAge: round4(logAge), terms: [{ feature: 'log10(TVL)', contribution: round4(w * z) }] };
}

// ---------------------------------------------------------------- farm economics

/** How much capital one farm position needs, from the protocol's own TVL. */
export function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
export function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** Costed farm economics for one row, from its implied value and its own figures. */
export function farmEconomics(p: SnapshotProtocol, implied: number, age: number | null): FarmEconomics {
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const ageForModel = age ?? UNKNOWN_AGE_DAYS;
  const allocPct = 0.05 * Math.sqrt(365 / (ageForModel + 365));
  const farmers = Math.round(Math.min(100_000, Math.max(200, p.tvl_usd / 5000)));
  const estAirdrop = Math.min(1500, (implied * allocPct) / farmers);
  const gas = capital >= 150 ? 12 : 8;
  const opportunity = (capital * 0.08 * hold) / 365;
  const netEv = estAirdrop - gas - opportunity;
  const netReturn = netEv / capital;
  const breakEven = netEv > 0 ? Math.ceil((capital + gas) / (estAirdrop / hold)) : null;
  const verdict: FarmEconomics['verdict'] = netEv >= 100 && netReturn >= 0.5 ? 'FARM' : netEv > 10 ? 'THIN' : 'SKIP';
  const verdictReason = verdict === 'FARM'
    ? `Net expected value $${round2(netEv)} clears $100 and a ${round2(netReturn * 100)}% return clears 50%.`
    : verdict === 'THIN'
      ? `Net expected value $${round2(netEv)} clears the $10 THIN bar but is below the $100 / 50% FARM bar.`
      : `Net expected value $${round2(netEv)} does not clear the $10 THIN bar: below that the payout is smaller than the weekly qualifying actions cost.`;
  return {
    capital_usd: capital,
    hold_days: hold,
    alloc_pct: round4(allocPct),
    farmers,
    est_airdrop_usd: round2(estAirdrop),
    gas_usd: gas,
    opportunity_cost_usd: round2(opportunity),
    net_ev_usd: round2(netEv),
    net_return_pct: round4(netReturn),
    break_even_days: breakEven,
    verdict,
    verdict_reason: verdictReason,
  };
}

// ---------------------------------------------------------------- farm steps

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time, weaving in the
 * row's capital, hold, verdict, break-even and net expected value so the plan is specific
 * to that protocol. Derived from the protocol's own record, never from a hand-written list.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null, farm: FarmEconomics, implied: number): FarmStep[] {
  const chain = chainOf(p);
  const capital = farm.capital_usd;
  const hold = farm.hold_days;
  const action = actionFor(p, capital, chain);
  const be = farm.break_even_days === null ? 'no break-even on this model' : `${farm.break_even_days} days to break even`;
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: `${action} The verdict is ${farm.verdict}: model implied value $${Math.round(implied).toLocaleString('en-US')}, estimated airdrop $${farm.est_airdrop_usd}, net expected value $${farm.net_ev_usd}.`,
      cost: `$${capital} of capital and about $${farm.gas_usd} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote, so the wallet stays active.`,
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot; ${be}.`,
      cost: `the $${capital} stays in the position, about $${farm.opportunity_cost_usd} of opportunity cost`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, fit: ModelFit): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const pred = predictProtocol(p, snapshot, fit);
    return { p, implied: Math.max(1, Math.round(Math.pow(10, pred.predicted))), pred };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  // Force strictly decreasing implied values down the board: a rounded value that would tie
  // or rise is lowered by $1 steps. The gap is tiny against values of thousands or more.
  for (let i = 1; i < scored.length; i++) {
    if (scored[i]!.implied >= scored[i - 1]!.implied) scored[i]!.implied = Math.max(1, scored[i - 1]!.implied - 1);
  }
  return scored.map((s, i) => {
    const farm = farmEconomics(s.p, s.implied, s.pred.age);
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      mcap_usd: s.p.mcap_usd,
      listed_at: s.p.listed_at,
      gecko_id: s.p.gecko_id,
      symbol: s.p.symbol,
      token_status: 'pre-token',
      age_days: s.pred.age,
      implied_value_usd: s.implied,
      model: {
        log_tvl: s.pred.logTvl,
        growth_pct: s.pred.growthPct,
        log_age: s.pred.logAge,
        category: s.p.category,
        predicted_log10_mcap: round4(s.pred.predicted),
        terms: s.pred.terms,
      },
      farm,
      farm_steps: farmSteps(s.p, s.pred.age, farm, s.implied).map(stepText),
    };
  });
}

/** A board row's compact form for data.js. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    growth_pct: row.model.growth_pct,
    predicted_log10_mcap: row.model.predicted_log10_mcap,
    terms: row.model.terms,
    farm: row.farm,
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const fit = fitModel(snapshot);
  const board = buildBoard(snapshot, fit);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    // The snapshot's source string carries a URL; data.js must stay free of any URL, so
    // the dashboard names the source in words only, with the fetch date.
    source: `DefiLlama protocols snapshot, fetched ${snapshot.as_of}`,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    total_protocols: snapshot.protocols.length,
    fit,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, farm steps, and verdicts. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  const verdicts = new Set(board.map((r) => r.farm.verdict));
  for (const v of ['FARM', 'THIN', 'SKIP'] as const) if (!verdicts.has(v)) return `no row carries verdict ${v}`;
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
