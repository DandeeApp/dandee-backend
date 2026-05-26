// ============================================
// Dandee Score routes
// ============================================
// Mounts under server.js as `app.use(require('./routes/score')(supabaseAdmin))`.
//
// Auth model — pragmatic for this codebase:
//   * Prefers Authorization: Bearer <Supabase access token>.
//   * Falls back to body/param userId if no token (matches existing routes;
//     useful for curl testing during checkpoints).
//   * If both are present, they must match or 403.
//
// Endpoints exposed (full list in plan §9):
//   POST   /api/homes
//   GET    /api/homes/me
//   POST   /api/homes/:id/systems
//   POST   /api/homes/:id/appliances
//   POST   /api/homes/:id/maintenance
//   POST   /api/homes/:id/issues
//   POST   /api/homes/:id/preferences
//   POST   /api/homes/:id/uploads/finalize
//   POST   /api/onboarding/step-complete
//   POST   /api/score/recompute
//   GET    /api/score/me
//   GET    /api/tips                       (stub until Phase 5)
//   POST   /api/tips/:id/complete          (stub until Phase 5)
//   POST   /api/tips/:id/dismiss           (stub until Phase 5)
//   POST   /api/tips/:id/track             (stub until Phase 5)

const express = require('express');
const { recomputeScore } = require('../services/dandeeScoreService');

module.exports = function buildScoreRouter(supabaseAdmin) {
  const router = express.Router();

  if (!supabaseAdmin) {
    router.use((_req, res) => res.status(503).json({ error: 'Supabase not configured' }));
    return router;
  }

  // ---------- Auth helper ----------

  async function resolveUserId(req) {
    const auth = req.headers.authorization || '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    let verifiedId = null;

    if (bearer) {
      try {
        const { data, error } = await supabaseAdmin.auth.getUser(bearer);
        if (!error && data?.user?.id) verifiedId = data.user.id;
      } catch (_) {}
    }

    const fallbackId = req.body?.userId || req.query?.userId || null;

    if (verifiedId && fallbackId && verifiedId !== fallbackId) {
      return { error: 'userId mismatch with bearer token', status: 403 };
    }
    const userId = verifiedId || fallbackId;
    if (!userId) return { error: 'auth required', status: 401 };
    return { userId };
  }

  function wrap(fn) {
    return async (req, res) => {
      try {
        const auth = await resolveUserId(req);
        if (auth.error) return res.status(auth.status).json({ error: auth.error });
        await fn(req, res, auth.userId);
      } catch (err) {
        console.error('[score routes]', req.method, req.path, err);
        res.status(500).json({ error: err.message || 'internal error' });
      }
    };
  }

  // ---------- Homes ----------

  // Upsert the owner's primary home. Body: { ...homeFields }. Returns home row.
  router.post('/api/homes', wrap(async (req, res, userId) => {
    const { id, ...fields } = req.body || {};
    delete fields.userId;
    delete fields.owner_id;

    if (id) {
      // Edit existing home (must belong to user)
      const { data, error } = await supabaseAdmin
        .from('homes')
        .update({ ...fields, updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('owner_id', userId)
        .select()
        .single();
      if (error) throw error;
      return res.json({ home: data });
    }

    // First-time create. Also seed home_users with the owner.
    const { data: home, error } = await supabaseAdmin
      .from('homes')
      .insert({ owner_id: userId, ...fields })
      .select()
      .single();
    if (error) throw error;

    await supabaseAdmin
      .from('home_users')
      .upsert({ home_id: home.id, user_id: userId, role: 'owner', last_active_at: new Date().toISOString() },
        { onConflict: 'home_id,user_id' });

    res.json({ home });
  }));

  // Returns the user's most recent home AND every related table in one
  // shot via service role — so the profile UI doesn't have to fan out 8
  // RLS-gated client queries.
  router.get('/api/homes/me/full', wrap(async (_req, res, userId) => {
    const { data: homes } = await supabaseAdmin
      .from('homes')
      .select('*')
      .eq('owner_id', userId)
      .order('created_at', { ascending: false })
      .limit(1);
    const home = homes?.[0] || null;
    if (!home) {
      return res.json({
        home: null, systems: [], appliances: [], maintenance: [], issues: [],
        preferences: null, paints: [], filters: [], warranties: [],
      });
    }
    const homeId = home.id;
    const [sys, app, maint, iss, prefs, paint, filt, warr] = await Promise.all([
      supabaseAdmin.from('home_systems').select('*').eq('home_id', homeId),
      supabaseAdmin.from('home_appliances').select('*').eq('home_id', homeId),
      supabaseAdmin.from('maintenance_log').select('id, task_type, performed_at, source').eq('home_id', homeId).order('performed_at', { ascending: false }).limit(20),
      supabaseAdmin.from('home_issues').select('id, category, severity, opened_at, description').eq('home_id', homeId).is('resolved_at', null).order('opened_at', { ascending: false }),
      supabaseAdmin.from('home_preferences').select('*').eq('home_id', homeId).maybeSingle(),
      supabaseAdmin.from('paint_colors').select('*').eq('home_id', homeId),
      supabaseAdmin.from('appliance_filters').select('*').eq('home_id', homeId),
      supabaseAdmin.from('warranties').select('id, item_type, expires_at').eq('home_id', homeId).order('expires_at', { ascending: true }),
    ]);
    res.json({
      home,
      systems: sys.data || [],
      appliances: app.data || [],
      maintenance: maint.data || [],
      issues: iss.data || [],
      preferences: prefs.data || null,
      paints: paint.data || [],
      filters: filt.data || [],
      warranties: warr.data || [],
    });
  }));

  router.get('/api/homes/me', wrap(async (_req, res, userId) => {
    const { data, error } = await supabaseAdmin
      .from('homes')
      .select('*')
      .eq('owner_id', userId)
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) throw error;
    res.json({ home: data?.[0] || null });
  }));

  // Verify ownership before any nested write.
  async function assertOwnsHome(homeId, userId) {
    const { data, error } = await supabaseAdmin
      .from('homes')
      .select('id')
      .eq('id', homeId)
      .eq('owner_id', userId)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      const e = new Error('home not found or not owned by user');
      e.status = 404;
      throw e;
    }
  }

  function nestedHandler(handler) {
    return wrap(async (req, res, userId) => {
      try {
        await assertOwnsHome(req.params.id, userId);
      } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        throw err;
      }
      await handler(req, res, userId, req.params.id);
    });
  }

  // ---------- Systems ----------

  // Bulk upsert. Body: { systems: [{ system_type, installed_year, source_type, is_estimated, brand, model }] }
  router.post('/api/homes/:id/systems', nestedHandler(async (req, res, userId, homeId) => {
    const systems = Array.isArray(req.body?.systems) ? req.body.systems : [];
    if (systems.length === 0) return res.json({ rows: [] });

    const rows = systems.map(s => ({
      home_id: homeId,
      system_type: s.system_type,
      installed_year: s.installed_year ?? null,
      source_type: s.source_type || 'unknown',
      is_estimated: s.source_type === 'estimated' || s.source_type === 'before_ownership' || !!s.is_estimated,
      brand: s.brand ?? null,
      model: s.model ?? null,
      notes: s.notes ?? null,
      updated_at: new Date().toISOString(),
    }));

    const { data, error } = await supabaseAdmin
      .from('home_systems')
      .upsert(rows, { onConflict: 'home_id,system_type' })
      .select();
    if (error) throw error;
    res.json({ rows: data });
  }));

  // ---------- Appliances ----------

  router.post('/api/homes/:id/appliances', nestedHandler(async (req, res, userId, homeId) => {
    const appliances = Array.isArray(req.body?.appliances) ? req.body.appliances : [];
    if (appliances.length === 0) return res.json({ rows: [] });

    const rows = appliances.map(a => ({
      home_id: homeId,
      appliance_type: a.appliance_type,
      age_bucket: a.age_bucket || 'unknown',
      brand: a.brand ?? null,
      model: a.model ?? null,
      serial_number: a.serial_number ?? null,
      updated_at: new Date().toISOString(),
    }));

    const { data, error } = await supabaseAdmin
      .from('home_appliances')
      .upsert(rows, { onConflict: 'home_id,appliance_type' })
      .select();
    if (error) throw error;
    res.json({ rows: data });
  }));

  // ---------- Maintenance ----------

  // Body: { entries: [{ task_type, performed_at, source, notes }] }
  router.post('/api/homes/:id/maintenance', nestedHandler(async (req, res, userId, homeId) => {
    const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];
    if (entries.length === 0) return res.json({ rows: [] });

    const rows = entries.map(e => ({
      home_id: homeId,
      task_type: e.task_type,
      performed_at: e.performed_at,
      source: e.source || 'logged',
      recorded_by: userId,
      notes: e.notes ?? null,
    }));

    const { data, error } = await supabaseAdmin
      .from('maintenance_log')
      .insert(rows)
      .select();
    if (error) throw error;
    res.json({ rows: data });
  }));

  // ---------- Issues ----------

  router.post('/api/homes/:id/issues', nestedHandler(async (req, res, userId, homeId) => {
    const issues = Array.isArray(req.body?.issues) ? req.body.issues : [];
    if (issues.length === 0) return res.json({ rows: [] });

    const rows = issues.map(i => ({
      home_id: homeId,
      category: i.category,
      severity: i.severity || 'minor',
      description: i.description ?? null,
    }));

    const { data, error } = await supabaseAdmin
      .from('home_issues')
      .insert(rows)
      .select();
    if (error) throw error;
    res.json({ rows: data });
  }));

  // ---------- Warranties ----------

  router.get('/api/homes/:id/warranties', nestedHandler(async (_req, res, _userId, homeId) => {
    const { data, error } = await supabaseAdmin
      .from('warranties')
      .select('*')
      .eq('home_id', homeId)
      .order('expires_at', { ascending: true });
    if (error) throw error;
    res.json({ rows: data || [] });
  }));

  router.post('/api/homes/:id/warranties', nestedHandler(async (req, res, _userId, homeId) => {
    const { item_type, brand, model, expires_at, file_url } = req.body || {};
    if (!item_type) return res.status(400).json({ error: 'item_type required' });
    const { data, error } = await supabaseAdmin
      .from('warranties')
      .insert({
        home_id: homeId,
        item_type,
        brand: brand || null,
        model: model || null,
        expires_at: expires_at || null,
        file_url: file_url || null,
      })
      .select()
      .single();
    if (error) throw error;
    res.json({ warranty: data });
  }));

  router.delete('/api/homes/:id/warranties/:warrantyId', nestedHandler(async (req, res, _userId, homeId) => {
    const { error } = await supabaseAdmin
      .from('warranties')
      .delete()
      .eq('id', req.params.warrantyId)
      .eq('home_id', homeId);
    if (error) throw error;
    res.json({ ok: true });
  }));

  // ---------- Paint colors ----------

  router.post('/api/homes/:id/paint-colors', nestedHandler(async (req, res, _userId, homeId) => {
    const { room, color_name, brand, code } = req.body || {};
    if (!room) return res.status(400).json({ error: 'room required' });
    const { data, error } = await supabaseAdmin
      .from('paint_colors')
      .insert({ home_id: homeId, room, color_name: color_name || null, brand: brand || null, code: code || null })
      .select()
      .single();
    if (error) throw error;
    res.json({ paint: data });
  }));

  router.delete('/api/homes/:id/paint-colors/:paintId', nestedHandler(async (req, res, _userId, homeId) => {
    const { error } = await supabaseAdmin
      .from('paint_colors')
      .delete()
      .eq('id', req.params.paintId)
      .eq('home_id', homeId);
    if (error) throw error;
    res.json({ ok: true });
  }));

  // ---------- Appliance filters ----------

  router.post('/api/homes/:id/filters', nestedHandler(async (req, res, _userId, homeId) => {
    const { filter_type, filter_part_number, last_changed } = req.body || {};
    if (!filter_type || !filter_part_number) {
      return res.status(400).json({ error: 'filter_type and filter_part_number required' });
    }
    const { data, error } = await supabaseAdmin
      .from('appliance_filters')
      .insert({
        home_id: homeId,
        filter_type,
        filter_part_number,
        last_changed: last_changed || null,
      })
      .select()
      .single();
    if (error) throw error;
    res.json({ filter: data });
  }));

  router.delete('/api/homes/:id/filters/:filterId', nestedHandler(async (req, res, _userId, homeId) => {
    const { error } = await supabaseAdmin
      .from('appliance_filters')
      .delete()
      .eq('id', req.params.filterId)
      .eq('home_id', homeId);
    if (error) throw error;
    res.json({ ok: true });
  }));

  // ---------- Preferences ----------

  router.post('/api/homes/:id/preferences', nestedHandler(async (req, res, userId, homeId) => {
    const { diy_level, priority } = req.body || {};
    const { data, error } = await supabaseAdmin
      .from('home_preferences')
      .upsert({
        home_id: homeId,
        diy_level: diy_level || null,
        priority: priority || null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'home_id' })
      .select()
      .single();
    if (error) throw error;
    res.json({ preferences: data });
  }));

  // ---------- Uploads ----------

  // Files are uploaded directly to Supabase Storage from the client.
  // This endpoint records the metadata so History Depth picks them up.
  // Body: { document_type, file_url, name }
  router.post('/api/homes/:id/uploads/finalize', nestedHandler(async (req, res, userId) => {
    const { document_type, file_url, name } = req.body || {};
    if (!file_url) return res.status(400).json({ error: 'file_url required' });

    const { data, error } = await supabaseAdmin
      .from('documents')
      .insert({
        user_id: userId,
        type: document_type || 'other',
        name: name || 'Untitled',
        file_url,
      })
      .select()
      .single();
    if (error) throw error;
    res.json({ document: data });
  }));

  // ---------- Onboarding step tracking ----------

  // Body: { step }  step ∈ {home_basics, major_systems, major_appliances,
  //                          maintenance_checklist, current_concerns,
  //                          maintenance_preferences, optional_uploads}
  router.post('/api/onboarding/step-complete', wrap(async (req, res, userId) => {
    const { step } = req.body || {};
    if (!step) return res.status(400).json({ error: 'step required' });

    const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
    if (error) throw error;
    const md = data?.user?.user_metadata || {};
    const steps = Array.isArray(md.onboarding_steps) ? md.onboarding_steps : [];
    if (!steps.includes(step)) steps.push(step);

    await supabaseAdmin.auth.admin.updateUserById(userId, {
      user_metadata: { ...md, onboarding_steps: steps },
    });
    res.json({ steps });
  }));

  // ---------- Score recompute / read ----------

  // Body: { onboardingComplete?: boolean }
  router.post('/api/score/recompute', wrap(async (req, res, userId) => {
    const result = await recomputeScore(supabaseAdmin, userId, {
      onboardingComplete: !!req.body?.onboardingComplete,
    });
    res.json(result);
  }));

  router.get('/api/score/me', wrap(async (_req, res, userId) => {
    const [stateRes, historyRes, eventsRes] = await Promise.all([
      supabaseAdmin.from('score_state').select('*').eq('user_id', userId).maybeSingle(),
      supabaseAdmin
        .from('score_history')
        .select('total_score, sub_scores, snapshot_date, created_at')
        .eq('user_id', userId)
        .order('snapshot_date', { ascending: false })
        .limit(7),
      supabaseAdmin
        .from('score_events')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(10),
    ]);

    if (stateRes.error) throw stateRes.error;
    if (historyRes.error) throw historyRes.error;
    if (eventsRes.error) throw eventsRes.error;

    res.json({
      state: stateRes.data || null,
      history: historyRes.data || [],
      recentEvents: eventsRes.data || [],
    });
  }));

  // ---------- Tips (stubs until Phase 5) ----------

  router.get('/api/tips', wrap(async (_req, res, userId) => {
    // Phase 5 will populate this from tipsEngine. For now, return what's
    // already in user_tips (likely empty pre-Phase-5) so the API contract
    // exists and frontend wiring can land independently.
    const { data, error } = await supabaseAdmin
      .from('user_tips')
      .select(`
        id, status, surfaced_at, completed_at, scored_impact_applied,
        rendered_copy, ab_variant, priority_score,
        rule:tip_rules ( rule_key, rule_key_root, category, score_impact, copy_text, action_link, min_plan )
      `)
      .eq('user_id', userId)
      .eq('status', 'open')
      .order('priority_score', { ascending: false });
    if (error) throw error;
    res.json({ tips: data || [] });
  }));

  router.post('/api/tips/:id/complete', wrap(async (req, res, userId) => {
    const { data, error } = await supabaseAdmin
      .from('user_tips')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('user_id', userId)
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'tip not found' });

    // Recompute so History Depth + sub-scores reflect the change.
    const result = await recomputeScore(supabaseAdmin, userId);
    res.json({ tip: data, score: result });
  }));

  router.post('/api/tips/:id/dismiss', wrap(async (req, res, userId) => {
    const { data, error } = await supabaseAdmin
      .from('user_tips')
      .update({ status: 'dismissed' })
      .eq('id', req.params.id)
      .eq('user_id', userId)
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'tip not found' });
    res.json({ tip: data });
  }));

  router.post('/api/tips/:id/track', wrap(async (req, res, userId) => {
    const { event } = req.body || {};
    if (!['impression', 'click', 'complete', 'dismiss'].includes(event)) {
      return res.status(400).json({ error: 'invalid event' });
    }

    // Look up rule_key_root + ab_variant from the user_tip row.
    const { data: tip, error: tipErr } = await supabaseAdmin
      .from('user_tips')
      .select('id, ab_variant, rule:tip_rules ( rule_key_root )')
      .eq('id', req.params.id)
      .eq('user_id', userId)
      .maybeSingle();
    if (tipErr) throw tipErr;
    if (!tip) return res.status(404).json({ error: 'tip not found' });

    const { error } = await supabaseAdmin.from('tip_analytics').insert({
      user_tip_id: tip.id,
      user_id: userId,
      rule_key_root: tip.rule?.rule_key_root || 'unknown',
      ab_variant: tip.ab_variant || 'control',
      event,
    });
    if (error) throw error;
    res.json({ ok: true });
  }));

  return router;
};
