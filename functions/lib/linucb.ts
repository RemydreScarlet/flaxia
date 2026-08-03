// Contextual bandit (LinUCB with shared linear payoffs) used by the Arcade
// recommender to maximize dwell time. Kept dependency-free and pure so it can
// be unit-tested with `node --test`.
//
// A 1024-d content embedding is projected to a smaller dimension with a
// deterministic random projection (Johnson-Lindenstrauss), keeping the
// per-user `A⁻¹` state compact enough for D1/KV storage.

export interface LinUCBConfig {
  enabled: boolean;
  alpha: number;
  dim: number;
  srcDim: number;
  seed: number;
  lambda: number;
}

export const DEFAULT_BANDIT_CONFIG: LinUCBConfig = {
  enabled: false,
  alpha: 0.6,
  dim: 64,
  srcDim: 1024,
  seed: 20260701,
  lambda: 0.6,
};

export interface LinUCBState {
  // A⁻¹ as a flat array of length dim*dim (row-major)
  aInv: number[];
  b: number[];
  t: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Deterministic ±1 random projection matrix: [dstDim][srcDim].
export function createProjection(srcDim: number, dstDim: number, seed: number): number[][] {
  const rand = mulberry32(seed);
  const proj: number[][] = [];
  for (let j = 0; j < dstDim; j++) {
    const row = new Array<number>(srcDim);
    for (let i = 0; i < srcDim; i++) {
      row[i] = rand() < 0.5 ? 1 : -1;
    }
    proj.push(row);
  }
  return proj;
}

export function project(vec: number[], proj: number[][]): number[] {
  const out = new Array<number>(proj.length);
  for (let j = 0; j < proj.length; j++) {
    let acc = 0;
    const row = proj[j];
    for (let i = 0; i < row.length; i++) {
      acc += row[i] * (vec[i] || 0);
    }
    out[j] = acc;
  }
  return out;
}

export function createState(dim: number): LinUCBState {
  const aInv = new Array<number>(dim * dim).fill(0);
  for (let i = 0; i < dim; i++) aInv[i * dim + i] = 1;
  return { aInv, b: new Array<number>(dim).fill(0), t: 0 };
}

function matVec(a: number[], x: number[], dim: number): number[] {
  const out = new Array<number>(dim);
  for (let i = 0; i < dim; i++) {
    let acc = 0;
    const off = i * dim;
    for (let j = 0; j < dim; j++) acc += a[off + j] * x[j];
    out[i] = acc;
  }
  return out;
}

function dot(a: number[], b: number[], dim: number): number {
  let acc = 0;
  for (let i = 0; i < dim; i++) acc += a[i] * b[i];
  return acc;
}

// LinUCB upper-confidence score for an arm with feature vector x.
// p = θᵀx + α·sqrt(xᵀA⁻¹x), where θ = A⁻¹b.
export function computeScore(state: LinUCBState, x: number[], alpha: number): number {
  const dim = state.b.length;
  const theta = matVec(state.aInv, state.b, dim);
  const mean = dot(theta, x, dim);
  const variance = dot(x, matVec(state.aInv, x, dim), dim);
  const ucb = alpha * Math.sqrt(Math.max(variance, 0));
  const score = mean + ucb;
  return Number.isFinite(score) ? score : mean;
}

// Online update via Sherman-Morrison: A⁻¹ ← A⁻¹ − (A⁻¹x)(A⁻¹x)ᵀ / (1 + xᵀA⁻¹x),
// b ← b + reward·x.
export function applyReward(state: LinUCBState, x: number[], reward: number): void {
  const dim = state.b.length;
  const ax = matVec(state.aInv, x, dim);
  const denom = 1 + dot(x, ax, dim);
  if (!Number.isFinite(denom) || denom <= 1e-12) return;
  for (let i = 0; i < dim; i++) {
    const off = i * dim;
    for (let j = 0; j < dim; j++) {
      state.aInv[off + j] -= (ax[i] * ax[j]) / denom;
    }
    state.b[i] += reward * x[i];
  }
  state.t += 1;
}

const ROUND = 1e-6;

export function serializeState(state: LinUCBState): string {
  return JSON.stringify({
    v: 1,
    t: state.t,
    aInv: state.aInv.map((v) => Math.round(v / ROUND) * ROUND),
    b: state.b.map((v) => Math.round(v / ROUND) * ROUND),
  });
}

export function deserializeState(json: string, dim: number): LinUCBState {
  const parsed = JSON.parse(json) as { v?: number; t?: number; aInv?: number[]; b?: number[] };
  if (parsed?.v !== 1 || !Array.isArray(parsed.aInv) || !Array.isArray(parsed.b)) {
    throw new Error('Invalid bandit state');
  }
  if (parsed.aInv.length !== dim * dim || parsed.b.length !== dim) {
    throw new Error('Bandit state dimension mismatch');
  }
  return {
    aInv: parsed.aInv.map(Number),
    b: parsed.b.map(Number),
    t: typeof parsed.t === 'number' ? parsed.t : 0,
  };
}

// Deterministic reward mapping for Arcade interaction events.
export function eventReward(eventType: string, dwellMs: number): number {
  if (eventType === 'fresh' || eventType === 'reply') return 1;
  if (eventType === 'share') return 0.8;
  if (eventType === 'fullscreen') return 0.6;
  return dwellMs > 0 ? Math.min(dwellMs / 30000, 1) : 0;
}

export function parseBanditConfig(raw: string | null | undefined): LinUCBConfig {
  if (!raw) return { ...DEFAULT_BANDIT_CONFIG };
  try {
    const parsed = JSON.parse(raw) as Partial<LinUCBConfig>;
    return {
      enabled: parsed.enabled === true,
      alpha: clamp(Number(parsed.alpha) || DEFAULT_BANDIT_CONFIG.alpha, 0, 5),
      dim: Math.max(8, Math.min(256, Math.round(Number(parsed.dim) || DEFAULT_BANDIT_CONFIG.dim))),
      srcDim: Math.max(8, Math.round(Number(parsed.srcDim) || DEFAULT_BANDIT_CONFIG.srcDim)),
      seed: Math.round(Number(parsed.seed) || DEFAULT_BANDIT_CONFIG.seed),
      lambda: clamp(Number(parsed.lambda) || DEFAULT_BANDIT_CONFIG.lambda, 0, 1),
    };
  } catch {
    return { ...DEFAULT_BANDIT_CONFIG };
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
