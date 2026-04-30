// ============================================
// Dandee Score Service
// ============================================
// Server-authoritative scoring for the Dandee Score feature.
//
// Formula:
//   total = clamp(BASE + Σ(weight_i × (subscore_i − 65)), 0, 100)
//   BASE  = 65
//   weights: system_age 0.40, maintenance_currency 0.30,
//            open_issues 0.20, history_depth 0.10
//
// Each sub-score is returned 0–100. 65 is treated as neutral so a
// brand-new account with no data lands near the baseline.
//
// Public surface:
//   recomputeScore(userId, opts)  → { subScores, total, potential, deltas, prevTotal }
//
// `opts.onboardingComplete=true` applies the one-time +5 History Depth bonus.
// `opts.tipsEngine` optional async function (userId, ctx) → { potential } —
// when provided, drives the "could go up to X" copy. Phase 5 wires this up.

const BASE = 65;
const WEIGHTS = {
  systemAge: 0.40,
  maintenanceCurrency: 0.30,
  openIssues: 0.20,
  historyDepth: 0.10,
};

const MAINTENANCE_INTERVALS_DAYS = {
  hvac_service: 365,
  gutter_cleaning: 180,
  water_heater_flush: 365,
  dryer_vent: 365,
  roof_inspection: 730,
  smoke_detector_battery: 365,
};

const APPLIANCE_AGE_BUCKET_YEARS = {
  new: 1,
  '1_5': 3,
  '5_10': 7.5,
  '10_plus': 15,
  unknown: null, // weight 0.5, fall back to neutral
};

const ISSUE_SEVERITY_DEDUCTION = {
  minor: 5,
  moderate: 12,
  severe: 25,
  critical: 40,
};

// ---------- Pure scoring functions ----------

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function ageToScore(years) {
  if (years <= 5) return 95;
  if (years <= 10) return 85;
  if (years <= 15) return 70;
  if (years <= 20) return 55;
  return 35;
}

/**
 * Computes the System Age sub-score (0-100).
 * @param {object} home - { year_built }
 * @param {Array<object>} systems - [{ system_type, installed_year, is_estimated }]
 * @param {Array<object>} appliances - [{ appliance_type, age_bucket }]
 * @param {Date} now - reference clock for testing
 */
function systemAgeScore(home, systems, appliances, now = new Date()) {
  const currentYear = now.getUTCFullYear();
  const samples = [];

  for (const s of systems || []) {
    if (!s.installed_year) continue;
    const age = currentYear - s.installed_year;
    if (age < 0) continue;
    const weight = s.is_estimated ? 0.7 : 1.0;
    samples.push({ score: ageToScore(age), weight });
  }

  for (const a of appliances || []) {
    const years = APPLIANCE_AGE_BUCKET_YEARS[a.age_bucket];
    if (years == null) {
      samples.push({ score: 65, weight: 0.5 });
      continue;
    }
    samples.push({ score: ageToScore(years), weight: 1.0 });
  }

  if (samples.length === 0) return 65;

  const totalWeight = samples.reduce((acc, s) => acc + s.weight, 0);
  const weightedSum = samples.reduce((acc, s) => acc + s.score * s.weight, 0);
  let score = Math.round(weightedSum / totalWeight);

  // New construction floor — homes built within the last 3 years
  // never grade below 80 on systems regardless of partial data.
  if (home?.year_built && currentYear - home.year_built <= 3) {
    score = Math.max(score, 80);
  }

  return clamp(score, 0, 100);
}

/**
 * Computes the Maintenance Currency sub-score (0-100).
 * @param {Array<object>} maintenanceLog - [{ task_type, performed_at }]
 * @param {Date} now
 */
function maintenanceCurrencyScore(maintenanceLog, now = new Date()) {
  const tasks = Object.keys(MAINTENANCE_INTERVALS_DAYS);

  // Find latest performed_at per task_type
  const latestByTask = {};
  for (const row of maintenanceLog || []) {
    const t = row.task_type;
    if (!tasks.includes(t)) continue;
    const ts = new Date(row.performed_at);
    if (!latestByTask[t] || ts > latestByTask[t]) {
      latestByTask[t] = ts;
    }
  }

  if (Object.keys(latestByTask).length === 0) return 50; // no data: slightly below neutral

  const scores = [];
  for (const task of tasks) {
    const last = latestByTask[task];
    if (!last) {
      scores.push(25);
      continue;
    }
    const days = (now - last) / (1000 * 60 * 60 * 24);
    const interval = MAINTENANCE_INTERVALS_DAYS[task];
    if (days <= interval) scores.push(100);
    else if (days <= 2 * interval) scores.push(60);
    else scores.push(25);
  }

  return clamp(Math.round(scores.reduce((a, b) => a + b, 0) / scores.length), 0, 100);
}

/**
 * Computes the Open Issues sub-score (0-100). 100 baseline; deductions per open issue.
 * @param {Array<object>} openIssues - [{ severity }]  (resolved_at IS NULL)
 */
function openIssuesScore(openIssues) {
  let score = 100;
  for (const issue of openIssues || []) {
    score -= ISSUE_SEVERITY_DEDUCTION[issue.severity] ?? 0;
  }
  return clamp(score, 0, 100);
}

/**
 * Computes the History Depth sub-score (0-100). Accumulator-style.
 * @param {object} ctx - {
 *   stepsCompleted: string[],            // onboarding step keys
 *   onboardingBonusEarned: boolean,      // one-time +5 if complete + flag set
 *   maintenanceLogCount: int,
 *   uploadedDocsCount: int,
 *   memberCount: int,
 * }
 */
function historyDepthScore(ctx) {
  let score = 0;
  const steps = Math.min(ctx.stepsCompleted?.length ?? 0, 7);
  score += steps * 5;                          // up to +35
  if (ctx.onboardingBonusEarned) score += 5;   // one-time +5
  score += Math.min(ctx.maintenanceLogCount ?? 0, 30);  // +1 per logged event, cap +30
  score += Math.min(ctx.uploadedDocsCount ?? 0, 20);    // +1 per uploaded doc, cap +20
  if ((ctx.memberCount ?? 0) >= 2) score += 5;          // second household member
  return clamp(score, 0, 100);
}

/**
 * Combines sub-scores into the canonical 0-100 total.
 * @param {object} subScores - { systemAge, maintenanceCurrency, openIssues, historyDepth }
 */
function combineTotal(subScores) {
  const { systemAge, maintenanceCurrency, openIssues, historyDepth } = subScores;
  const total =
    BASE +
    WEIGHTS.systemAge * (systemAge - 65) +
    WEIGHTS.maintenanceCurrency * (maintenanceCurrency - 65) +
    WEIGHTS.openIssues * (openIssues - 65) +
    WEIGHTS.historyDepth * (historyDepth - 65);
  return clamp(Math.round(total), 0, 100);
}

// ---------- IO: gather all inputs for a user ----------

async function gatherInputs(supabase, userId) {
  // Resolve the user's home (most recently created if multiple — v1 assumes 1:1).
  const { data: homes, error: homeErr } = await supabase
    .from('homes')
    .select('id, year_built, sqft, home_type')
    .eq('owner_id', userId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (homeErr) throw homeErr;
  const home = homes?.[0] || null;

  if (!home) {
    return {
      home: null,
      systems: [],
      appliances: [],
      maintenanceLog: [],
      openIssues: [],
      uploadedDocsCount: 0,
      memberCount: 1,
    };
  }

  const homeId = home.id;
  const [systemsRes, appliancesRes, maintRes, issuesRes, docsRes, membersRes] =
    await Promise.all([
      supabase.from('home_systems').select('*').eq('home_id', homeId),
      supabase.from('home_appliances').select('*').eq('home_id', homeId),
      supabase.from('maintenance_log').select('task_type, performed_at, source').eq('home_id', homeId),
      supabase.from('home_issues').select('severity').eq('home_id', homeId).is('resolved_at', null),
      supabase.from('documents').select('id', { count: 'exact', head: true }).eq('user_id', userId),
      supabase.from('home_users').select('user_id', { count: 'exact', head: true }).eq('home_id', homeId),
    ]);

  for (const r of [systemsRes, appliancesRes, maintRes, issuesRes]) {
    if (r.error) throw r.error;
  }

  return {
    home,
    systems: systemsRes.data || [],
    appliances: appliancesRes.data || [],
    maintenanceLog: maintRes.data || [],
    openIssues: issuesRes.data || [],
    uploadedDocsCount: docsRes.count || 0,
    memberCount: membersRes.count || 1,
  };
}

async function loadOnboardingState(supabase, userId) {
  // Onboarding step completion + bonus state are stored in user_metadata so
  // they survive across onboarding sessions without an extra table. Service
  // role can read user records via auth.admin.getUserById.
  try {
    const { data, error } = await supabase.auth.admin.getUserById(userId);
    if (error || !data?.user) return { stepsCompleted: [], onboardingBonusEarned: false };
    const md = data.user.user_metadata || {};
    return {
      stepsCompleted: Array.isArray(md.onboarding_steps) ? md.onboarding_steps : [],
      onboardingBonusEarned: !!md.onboarding_bonus_applied,
    };
  } catch (_) {
    return { stepsCompleted: [], onboardingBonusEarned: false };
  }
}

async function applyOnboardingBonusIfNeeded(supabase, userId) {
  const { data, error } = await supabase.auth.admin.getUserById(userId);
  if (error || !data?.user) return false;
  const md = data.user.user_metadata || {};
  if (md.onboarding_bonus_applied) return false;
  const next = { ...md, onboarding_bonus_applied: true };
  await supabase.auth.admin.updateUserById(userId, { user_metadata: next });
  return true;
}

// ---------- Persistence ----------

async function loadPrev(supabase, userId) {
  const { data, error } = await supabase
    .from('score_state')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data; // null if no row yet
}

async function persistScore(supabase, userId, subScores, total, potential) {
  // score_state — upsert
  const { error: stateErr } = await supabase
    .from('score_state')
    .upsert({
      user_id: userId,
      system_age: subScores.systemAge,
      maintenance_currency: subScores.maintenanceCurrency,
      open_issues: subScores.openIssues,
      history_depth: subScores.historyDepth,
      total_score: total,
      potential_score: potential,
      calculated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });
  if (stateErr) throw stateErr;

  // score_history — daily snapshot, idempotent via unique (user_id, snapshot_date)
  const today = new Date().toISOString().slice(0, 10);
  const { error: histErr } = await supabase
    .from('score_history')
    .upsert({
      user_id: userId,
      total_score: total,
      sub_scores: subScores,
      snapshot_date: today,
    }, { onConflict: 'user_id,snapshot_date' });
  if (histErr) throw histErr;
}

// Baseline used for the FIRST recompute (no prior score_state row). Matches
// the empty-state values returned by each pure scoring function, so deltas
// emitted on first compute reflect "nothing → now" and the user sees the
// activation moment animate.
const FIRST_COMPUTE_BASELINE = {
  system_age: 65,
  maintenance_currency: 50,
  open_issues: 100,
  history_depth: 0,
  total_score: 61,
};

function buildDeltas(prev, subScores, total) {
  const baseline = prev || FIRST_COMPUTE_BASELINE;
  const deltas = [];

  const map = [
    ['systemAge', 'system_age'],
    ['maintenanceCurrency', 'maintenance_currency'],
    ['openIssues', 'open_issues'],
    ['historyDepth', 'history_depth'],
  ];

  for (const [key, label] of map) {
    const d = subScores[key] - (baseline[label] ?? 65);
    if (Math.abs(d) >= 1) {
      deltas.push({ subScore: label, delta: Math.round(d) });
    }
  }

  const totalDelta = total - (baseline.total_score ?? 61);
  if (Math.abs(totalDelta) >= 1) {
    deltas.push({ subScore: 'total', delta: Math.round(totalDelta) });
  }
  return deltas;
}

const SUBSCORE_REASON = {
  system_age: 'your systems updated',
  maintenance_currency: 'your maintenance updated',
  open_issues: 'your open issues updated',
  history_depth: 'your home record got more complete',
};

async function persistEvents(supabase, userId, deltas) {
  const rows = deltas
    .filter(d => d.subScore !== 'total')
    .map(d => ({
      user_id: userId,
      delta: d.delta,
      reason: d.reasonOverride || SUBSCORE_REASON[d.subScore] || 'score updated',
      sub_score: d.subScore,
    }));
  if (rows.length === 0) return;
  const { error } = await supabase.from('score_events').insert(rows);
  if (error) throw error;
}

// ---------- Public API ----------

/**
 * Recomputes the score for a user end-to-end.
 *
 * @param {object} supabase - service-role Supabase client (RLS-bypassing)
 * @param {string} userId
 * @param {object} [opts]
 * @param {boolean} [opts.onboardingComplete] - apply +5 History Depth one-time bonus
 * @param {Function} [opts.tipsEngine] - async (userId, computedSubScores) → { potential }
 * @returns {Promise<{subScores, total, potential, deltas, prevTotal}>}
 */
async function recomputeScore(supabase, userId, opts = {}) {
  if (!userId) throw new Error('recomputeScore: userId is required');

  // 1. Apply the one-time onboarding bonus before reading state, so
  //    history_depth picks it up in the same pass.
  if (opts.onboardingComplete) {
    await applyOnboardingBonusIfNeeded(supabase, userId);
  }

  // 2. Gather inputs in parallel.
  const [inputs, onboarding, prev] = await Promise.all([
    gatherInputs(supabase, userId),
    loadOnboardingState(supabase, userId),
    loadPrev(supabase, userId),
  ]);

  // 3. Compute sub-scores.
  const subScores = {
    systemAge: systemAgeScore(inputs.home, inputs.systems, inputs.appliances),
    maintenanceCurrency: maintenanceCurrencyScore(inputs.maintenanceLog),
    openIssues: openIssuesScore(inputs.openIssues),
    historyDepth: historyDepthScore({
      stepsCompleted: onboarding.stepsCompleted,
      onboardingBonusEarned: onboarding.onboardingBonusEarned,
      maintenanceLogCount: inputs.maintenanceLog.length,
      uploadedDocsCount: inputs.uploadedDocsCount,
      memberCount: inputs.memberCount,
    }),
  };

  const total = combineTotal(subScores);

  // 4. Run the tips engine. potential_score = total + Σ(open tip impacts),
  //    capped at 100. Drives the "could go up to X" copy on the dashboard.
  let potential = total;
  let tipsResult = null;
  try {
    const tipsEngine = require('./tipsEngine');
    tipsResult = await tipsEngine.regenerate(supabase, userId);
    potential = clamp(total + (tipsResult.sumImpacts || 0), 0, 100);
  } catch (e) {
    console.error('[dandeeScoreService] tipsEngine error (non-fatal):', e.message);
  }

  // 5. Persist + emit events.
  const deltas = buildDeltas(prev, subScores, total);
  await persistScore(supabase, userId, subScores, total, potential);
  await persistEvents(supabase, userId, deltas);

  return {
    subScores,
    total,
    potential,
    deltas,
    prevTotal: prev?.total_score ?? null,
  };
}

module.exports = {
  // public
  recomputeScore,
  // exposed for unit tests + the TS preview mirror
  systemAgeScore,
  maintenanceCurrencyScore,
  openIssuesScore,
  historyDepthScore,
  combineTotal,
  // constants
  BASE,
  WEIGHTS,
  MAINTENANCE_INTERVALS_DAYS,
  APPLIANCE_AGE_BUCKET_YEARS,
  ISSUE_SEVERITY_DEDUCTION,
};
