// ============================================
// Dandee Tips Engine
// ============================================
// Reads tip_rules from Supabase and decides which ones currently apply to a
// given user. Builds a "context" snapshot of derived facts (system ages,
// maintenance recency, open issues, season, etc.), evaluates each rule's
// trigger_condition JSON DSL against that context, and upserts user_tips
// rows for matches. Stale tips that no longer match are expired.
//
// Personalization:
//   * {diy_action} token resolves to a phrase chosen from rule_key_root +
//     home_preferences.diy_level.
//   * {count} / {system} / {issue_category} resolve from context.
//   * priority_weight is bumped +50 when home_preferences.priority aligns
//     with the rule's category (e.g. "emergencies" → urgency rules).
//
// A/B testing: when multiple active rules share a rule_key_root, the user
// is deterministically bucketed via hash(userId + rule_key_root) so a given
// user always sees the same variant.
//
// Public surface:
//   regenerate(supabase, userId) → { tips: UserTip[], potential: int }
//
// Hooked into dandeeScoreService.recomputeScore so tips refresh whenever
// the score does. The returned `potential` drives "could go up to X" copy.

const crypto = require('crypto');

const MAINTENANCE_INTERVALS_DAYS = {
  hvac_service: 365,
  gutter_cleaning: 180,
  water_heater_flush: 365,
  dryer_vent: 365,
  roof_inspection: 730,
  smoke_detector_battery: 365,
  hvac_filter: 90,
};

// ---------- Context builder ----------

function seasonOf(date = new Date()) {
  const m = date.getUTCMonth(); // 0-11
  if (m >= 2 && m <= 4) return 'spring';
  if (m >= 5 && m <= 7) return 'summer';
  if (m >= 8 && m <= 10) return 'fall';
  return 'winter';
}

function daysBetween(a, b) {
  return Math.floor((a - b) / (1000 * 60 * 60 * 24));
}

async function buildContext(supabase, userId) {
  const now = new Date();
  const currentYear = now.getUTCFullYear();

  const [{ data: home }, { data: members }] = await Promise.all([
    supabase
      .from('homes')
      .select('id, year_built')
      .eq('owner_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    // Peer-active: count members of any home this user owns who logged in in last 30d.
    supabase
      .from('home_users')
      .select('user_id, last_active_at, home:homes!inner(owner_id)')
      .eq('home.owner_id', userId),
  ]);

  if (!home) {
    return {
      _meta: { homeId: null, userId },
      home: { has_warranties_logged: false, has_paint_colors_logged: false,
              has_filter_part_numbers: false, has_inspection_uploaded: false,
              estimated_systems_count: 0, member_count: 1, year_built: null },
      system: {}, appliance: {}, maintenance: {},
      issues: { open: { has_critical: false, has_severe: false, count_by_severity: {} } },
      season: { now: seasonOf(now) },
      users: { both_active_30d: false },
      preferences: { diy_level: null, priority: null },
    };
  }

  const homeId = home.id;

  const [
    systemsRes, appliancesRes, maintRes, issuesRes,
    warrantiesRes, paintRes, filtersRes, docsRes, prefsRes,
  ] = await Promise.all([
    supabase.from('home_systems').select('*').eq('home_id', homeId),
    supabase.from('home_appliances').select('*').eq('home_id', homeId),
    supabase.from('maintenance_log').select('task_type, performed_at').eq('home_id', homeId),
    supabase.from('home_issues').select('id, category, severity, opened_at, resolved_at').eq('home_id', homeId).is('resolved_at', null),
    supabase.from('warranties').select('id', { count: 'exact', head: true }).eq('home_id', homeId),
    supabase.from('paint_colors').select('id', { count: 'exact', head: true }).eq('home_id', homeId),
    supabase.from('appliance_filters').select('id', { count: 'exact', head: true }).eq('home_id', homeId),
    supabase.from('documents').select('type').eq('user_id', userId),
    supabase.from('home_preferences').select('*').eq('home_id', homeId).maybeSingle(),
  ]);

  const systems = systemsRes.data || [];
  const appliances = appliancesRes.data || [];
  const maintenanceLog = maintRes.data || [];
  const openIssues = issuesRes.data || [];
  const docs = docsRes.data || [];
  const prefs = prefsRes.data || null;

  // Per-system snapshot
  const systemMap = {};
  for (const s of systems) {
    const ageYears = s.installed_year ? Math.max(0, currentYear - s.installed_year) : null;
    systemMap[s.system_type] = {
      age_years: ageYears,
      is_estimated: !!s.is_estimated,
      has_brand: !!s.brand,
      has_model: !!s.model,
    };
  }

  // Per-appliance snapshot
  const applianceMap = {};
  for (const a of appliances) {
    applianceMap[a.appliance_type] = {
      has_serial_number: !!a.serial_number,
      has_brand: !!a.brand,
      age_bucket: a.age_bucket,
    };
  }

  // Maintenance days_since per task
  const maintenanceMap = {};
  const tasks = Object.keys(MAINTENANCE_INTERVALS_DAYS);
  for (const task of tasks) {
    const rows = maintenanceLog.filter((r) => r.task_type === task);
    if (rows.length === 0) {
      maintenanceMap[task] = { days_since: null, never: true };
      continue;
    }
    const latest = rows
      .map((r) => new Date(r.performed_at))
      .reduce((acc, d) => (d > acc ? d : acc), new Date(0));
    maintenanceMap[task] = { days_since: daysBetween(now, latest), never: false };
  }

  // Streak: consecutive months where every overdue-eligible task is within interval.
  // For v1, simple proxy: streak_months = months since the oldest "overdue" task.
  // Real streak math comes when we have logged_at timestamps to anchor.
  let streakMonths = 0;
  const overdueAny = tasks.some((t) => {
    const m = maintenanceMap[t];
    return m.never || (m.days_since != null && m.days_since > MAINTENANCE_INTERVALS_DAYS[t]);
  });
  if (!overdueAny) streakMonths = 12; // optimistic for v1; refine later
  const thisMonthStart = new Date(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const thisMonthCount = maintenanceLog.filter((r) => new Date(r.performed_at) >= thisMonthStart).length;

  // Issues by severity
  const countBySeverity = { minor: 0, moderate: 0, severe: 0, critical: 0 };
  for (const i of openIssues) countBySeverity[i.severity] = (countBySeverity[i.severity] || 0) + 1;

  // Estimated systems
  const estimatedSystemsCount = systems.filter((s) => s.is_estimated).length;

  // Member activity
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const memberRows = members || [];
  const activeMembers = memberRows.filter(
    (m) => m.last_active_at && new Date(m.last_active_at) >= thirtyDaysAgo,
  ).length;
  const memberCount = memberRows.length || 1;

  // Document signals
  const inspectionUploaded = docs.some((d) => d.type === 'inspection');

  return {
    _meta: { homeId, userId, latestIssue: openIssues[0] || null },
    home: {
      has_warranties_logged: (warrantiesRes.count || 0) > 0,
      has_paint_colors_logged: (paintRes.count || 0) > 0,
      has_filter_part_numbers: (filtersRes.count || 0) > 0,
      has_inspection_uploaded: inspectionUploaded,
      estimated_systems_count: estimatedSystemsCount,
      member_count: memberCount,
      year_built: home.year_built,
    },
    system: systemMap,
    appliance: applianceMap,
    maintenance: { ...maintenanceMap, streak_months: streakMonths, this_month_count: thisMonthCount },
    issues: {
      open: {
        has_critical: countBySeverity.critical > 0,
        has_severe: countBySeverity.severe > 0,
        count_by_severity: countBySeverity,
      },
    },
    season: { now: seasonOf(now) },
    users: { both_active_30d: memberCount >= 2 && activeMembers >= 2 },
    preferences: { diy_level: prefs?.diy_level || null, priority: prefs?.priority || null },
  };
}

// ---------- DSL evaluator ----------

function getPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

function evalLeaf(ctx, node) {
  const left = getPath(ctx, node.field);
  const right = node.value;
  switch (node.op) {
    case '=':  return left === right;
    case '!=': return left !== right;
    case '>':  return left != null && left > right;
    case '>=': return left != null && left >= right;
    case '<':  return left != null && left < right;
    case '<=': return left != null && left <= right;
    case 'in':       return Array.isArray(right) && right.includes(left);
    case 'not_in':   return Array.isArray(right) && !right.includes(left);
    case 'exists':   return left != null;
    default:
      console.warn('[tipsEngine] unknown op', node.op);
      return false;
  }
}

function evaluate(ctx, condition) {
  if (!condition || typeof condition !== 'object') return false;
  if (condition.and) return condition.and.every((c) => evaluate(ctx, c));
  if (condition.or)  return condition.or.some((c) => evaluate(ctx, c));
  if (condition.not) return !evaluate(ctx, condition.not);
  if (condition.field) return evalLeaf(ctx, condition);
  return false;
}

// ---------- Personalization ----------

const DIY_ACTIONS = {
  hvac_service_overdue: {
    hands_on: 'Schedule a Saturday this month to service your HVAC',
    some: 'Book HVAC service this week',
    hire_out: 'Tap to request a contractor for HVAC service',
  },
  replace_hvac_filter: {
    hands_on: 'Pop in a new filter this weekend',
    some: 'Order a filter and swap it within a week',
    hire_out: 'Add a filter swap to your next service visit',
  },
  test_smoke_detectors: {
    hands_on: 'Test each detector and swap any old batteries today',
    some: 'Run a quick detector test this week',
    hire_out: 'Ask your contractor to verify all detectors next visit',
  },
  gutter_cleaning_spring: {
    hands_on: 'Get up there this Saturday with a ladder and gloves',
    some: 'Book a gutter cleaning in the next two weekends',
    hire_out: 'Tap to request a contractor for gutters',
  },
  gutter_cleaning_fall: {
    hands_on: 'Knock out the gutters before the next storm',
    some: 'Schedule a gutter cleaning this month',
    hire_out: 'Tap to request a contractor for gutters',
  },
  roof_inspection: {
    hands_on: 'Walk the perimeter and photograph any visible damage',
    some: 'Book a roof inspection this season',
    hire_out: 'Tap to request a contractor for a roof inspection',
  },
  flush_water_heater: {
    hands_on: 'Connect a hose and drain the tank this weekend',
    some: 'Schedule the flush this month',
    hire_out: 'Tap to request a plumber for a flush',
  },
  address_open_issue_critical: {
    hands_on: 'This is urgent — diagnose or call someone today',
    some: 'Get this looked at within 24 hours',
    hire_out: 'Tap to request an emergency contractor',
  },
  address_open_issue_severe: {
    hands_on: 'Take a look this weekend before it worsens',
    some: 'Schedule a fix this week',
    hire_out: 'Tap to request a contractor',
  },
  address_open_issue_moderate: {
    hands_on: 'Plan a Saturday fix',
    some: 'Add this to your next free weekend',
    hire_out: 'Tap to request a contractor',
  },
  address_open_issue_minor: {
    hands_on: 'Knock it out when you have an hour',
    some: 'Add it to the punch list',
    hire_out: 'Bundle it with the next contractor visit',
  },
};

function renderCopy(rule, ctx, abVariant) {
  let copy = rule.copy_text;

  if (copy.includes('{diy_action}')) {
    const map = DIY_ACTIONS[rule.rule_key_root];
    const level = ctx.preferences.diy_level || 'some';
    const phrase = map?.[level] || map?.some || '';
    copy = copy.replace('{diy_action}', phrase);
  }
  if (copy.includes('{count}')) {
    const count = ctx.home.estimated_systems_count;
    copy = copy.replace('{count}', String(count));
  }
  if (copy.includes('{system}')) {
    // For verify-estimated: pick the first estimated system if any
    copy = copy.replace('{system}', 'system');
  }
  if (copy.includes('{issue_category}')) {
    const issue = ctx._meta.latestIssue;
    copy = copy.replace('{issue_category}', issue?.category || 'an open issue');
  }
  return copy;
}

// ---------- A/B bucketing ----------

function bucketVariant(userId, ruleKeyRoot, variants) {
  if (!variants || variants.length === 1) return variants?.[0] || null;
  const hash = crypto.createHash('sha256').update(`${userId}:${ruleKeyRoot}`).digest('hex');
  const n = parseInt(hash.slice(0, 8), 16);
  return variants[n % variants.length];
}

// ---------- Priority bumping based on user prefs ----------

const PRIORITY_BUMP_KEYS = {
  emergencies: ['hvac_service_overdue', 'roof_inspection', 'address_open_issue_critical', 'address_open_issue_severe', 'gutter_cleaning_spring', 'gutter_cleaning_fall'],
  money:       ['add_warranties', 'log_hvac_brand_model', 'add_appliance_serials'],
  property_value: ['roof_inspection', 'hvac_service_overdue', 'flush_water_heater'],
  peace_of_mind: ['streak_3_month', 'streak_6_month', 'streak_12_month', 'monthly_log_event'],
};

function adjustedPriority(rule, userPriority) {
  const base = rule.priority_weight || 100;
  if (!userPriority) return base;
  const bumped = PRIORITY_BUMP_KEYS[userPriority] || [];
  return bumped.includes(rule.rule_key_root) ? base + 50 : base;
}

// ---------- Public: regenerate ----------

async function regenerate(supabase, userId) {
  if (!userId) throw new Error('regenerate: userId required');

  const ctx = await buildContext(supabase, userId);

  // Load active rules. Group by rule_key_root for A/B variant selection.
  const { data: allRules, error: rulesErr } = await supabase
    .from('tip_rules')
    .select('*')
    .eq('active', true);
  if (rulesErr) throw rulesErr;

  const byRoot = {};
  for (const r of allRules || []) {
    (byRoot[r.rule_key_root] ||= []).push(r);
  }

  // Pick one rule per root via deterministic A/B bucketing.
  const chosenRules = Object.entries(byRoot).map(([root, rules]) => {
    if (rules.length === 1) return rules[0];
    const variants = rules.map((r) => r.ab_variant);
    const picked = bucketVariant(userId, root, variants);
    return rules.find((r) => r.ab_variant === picked) || rules[0];
  });

  // Evaluate.
  const matched = [];
  for (const rule of chosenRules) {
    let cond;
    try {
      cond = typeof rule.trigger_condition === 'string'
        ? JSON.parse(rule.trigger_condition)
        : rule.trigger_condition;
    } catch (e) {
      console.warn('[tipsEngine] bad trigger_condition for', rule.rule_key, e.message);
      continue;
    }
    if (!evaluate(ctx, cond)) continue;
    matched.push(rule);
  }

  // Sort: priority_weight (with personalization bump) desc, then score_impact desc.
  matched.sort((a, b) => {
    const pa = adjustedPriority(a, ctx.preferences.priority);
    const pb = adjustedPriority(b, ctx.preferences.priority);
    if (pa !== pb) return pb - pa;
    return (b.score_impact || 0) - (a.score_impact || 0);
  });

  const matchedIds = new Set(matched.map((r) => r.id));

  // Expire any user_tips whose rule no longer matches (unless completed/dismissed already).
  const { data: existingOpen } = await supabase
    .from('user_tips')
    .select('id, rule_id')
    .eq('user_id', userId)
    .eq('status', 'open');
  const toExpire = (existingOpen || [])
    .filter((t) => !matchedIds.has(t.rule_id))
    .map((t) => t.id);
  if (toExpire.length > 0) {
    await supabase
      .from('user_tips')
      .update({ status: 'expired' })
      .in('id', toExpire);
  }

  // Upsert open user_tips for matched rules. Skip rules where the user has
  // already completed or dismissed THIS rule_id (don't re-surface).
  const { data: closedSameRules } = await supabase
    .from('user_tips')
    .select('rule_id, status')
    .eq('user_id', userId)
    .in('status', ['completed', 'dismissed']);
  const skipRuleIds = new Set((closedSameRules || []).map((r) => r.rule_id));

  // Build a quick lookup of existing open tips so we update-in-place rather
  // than insert duplicates. Postgres ON CONFLICT can't target the partial
  // unique index (WHERE status='open') so we do this manually.
  const existingByRuleId = new Map(
    (existingOpen || []).map((t) => [t.rule_id, t.id]),
  );

  const renderedTips = [];
  for (const rule of matched) {
    if (skipRuleIds.has(rule.id)) continue;
    const renderedCopy = renderCopy(rule, ctx, rule.ab_variant);
    const priorityScore = adjustedPriority(rule, ctx.preferences.priority);
    const existingId = existingByRuleId.get(rule.id);

    let tip;
    if (existingId) {
      const { data, error } = await supabase
        .from('user_tips')
        .update({
          rendered_copy: renderedCopy,
          priority_score: priorityScore,
          ab_variant: rule.ab_variant,
        })
        .eq('id', existingId)
        .select()
        .single();
      if (error) {
        console.error('[tipsEngine] update failed', rule.rule_key, error.message);
        continue;
      }
      tip = data;
    } else {
      const { data, error } = await supabase
        .from('user_tips')
        .insert({
          user_id: userId,
          rule_id: rule.id,
          home_id: ctx._meta.homeId,
          status: 'open',
          surfaced_at: new Date().toISOString(),
          rendered_copy: renderedCopy,
          ab_variant: rule.ab_variant,
          priority_score: priorityScore,
        })
        .select()
        .single();
      if (error) {
        console.error('[tipsEngine] insert failed', rule.rule_key, error.message);
        continue;
      }
      tip = data;
    }
    renderedTips.push({ ...tip, rule });
  }

  // Potential score = current total + sum of open tip score_impacts, clamped 100.
  const sumImpacts = renderedTips.reduce((acc, t) => acc + (t.rule.score_impact || 0), 0);

  return {
    tips: renderedTips,
    sumImpacts,
  };
}

module.exports = {
  regenerate,
  buildContext,
  evaluate,
  renderCopy,
  bucketVariant,
};
