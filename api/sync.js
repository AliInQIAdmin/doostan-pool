// =====================================================================
//  /api/sync  —  World Cup 2026 score + odds feed
//  Runs on a schedule (see vercel.json). Pulls official final scores and
//  win/draw/loss odds from API-Football and writes them to Supabase using
//  the SECRET service-role key. No browser and no user can write scores —
//  only this server function can. That's the integrity guarantee.
//
//  Reads everything from Vercel Environment Variables (never hard-coded):
//    API_FOOTBALL_KEY      - your API-Football key
//    SUPABASE_URL          - https://gourekvjsqxgcrgzjmyp.supabase.co
//    SUPABASE_SERVICE_KEY  - Supabase service-role (secret) key
//    CRON_SECRET           - any random string; protects this endpoint
// =====================================================================

const WC_LEAGUE = 1;     // API-Football league id for the FIFA World Cup
const WC_SEASON = 2026;

// Our 72 group-stage matches: [our id, home, away]
const MAP = [
  ["A1","Mexico","South Africa"],["A2","Korea Republic","Czechia"],["A3","Czechia","South Africa"],["A4","Mexico","Korea Republic"],["A5","Czechia","Mexico"],["A6","South Africa","Korea Republic"],
  ["B1","Canada","Bosnia and Herzegovina"],["B2","Qatar","Switzerland"],["B3","Switzerland","Bosnia and Herzegovina"],["B4","Canada","Qatar"],["B5","Switzerland","Canada"],["B6","Bosnia and Herzegovina","Qatar"],
  ["C1","Brazil","Morocco"],["C2","Haiti","Scotland"],["C3","Scotland","Morocco"],["C4","Brazil","Haiti"],["C5","Scotland","Brazil"],["C6","Morocco","Haiti"],
  ["D1","United States","Paraguay"],["D2","Australia","Türkiye"],["D3","United States","Australia"],["D4","Türkiye","Paraguay"],["D5","Türkiye","United States"],["D6","Paraguay","Australia"],
  ["E1","Germany","Curaçao"],["E2","Ivory Coast","Ecuador"],["E3","Germany","Ivory Coast"],["E4","Ecuador","Curaçao"],["E5","Curaçao","Ivory Coast"],["E6","Ecuador","Germany"],
  ["F1","Netherlands","Japan"],["F2","Sweden","Tunisia"],["F3","Netherlands","Sweden"],["F4","Tunisia","Japan"],["F5","Japan","Sweden"],["F6","Tunisia","Netherlands"],
  ["G1","Belgium","Egypt"],["G2","Iran","New Zealand"],["G3","Belgium","Iran"],["G4","New Zealand","Egypt"],["G5","Egypt","Iran"],["G6","New Zealand","Belgium"],
  ["H1","Spain","Cape Verde"],["H2","Saudi Arabia","Uruguay"],["H3","Spain","Saudi Arabia"],["H4","Uruguay","Cape Verde"],["H5","Cape Verde","Saudi Arabia"],["H6","Uruguay","Spain"],
  ["I1","France","Senegal"],["I2","Iraq","Norway"],["I3","France","Iraq"],["I4","Norway","Senegal"],["I5","Norway","France"],["I6","Senegal","Iraq"],
  ["J1","Argentina","Algeria"],["J2","Austria","Jordan"],["J3","Argentina","Austria"],["J4","Jordan","Algeria"],["J5","Jordan","Argentina"],["J6","Algeria","Austria"],
  ["K1","Portugal","DR Congo"],["K2","Uzbekistan","Colombia"],["K3","Portugal","Uzbekistan"],["K4","Colombia","DR Congo"],["K5","Colombia","Portugal"],["K6","DR Congo","Uzbekistan"],
  ["L1","England","Croatia"],["L2","Ghana","Panama"],["L3","England","Ghana"],["L4","Panama","Croatia"],["L5","Panama","England"],["L6","Croatia","Ghana"],
];

// API team names sometimes differ from ours — normalize + alias both sides.
const ALIAS = {
  southkorea:"korearepublic", czechrepublic:"czechia", usa:"unitedstates",
  turkey:"turkiye", congodr:"drcongo", capeverdeislands:"capeverde",
  bosnia:"bosniaandherzegovina", bosniaherzegovina:"bosniaandherzegovina", iriran:"iran", "cotedivoire":"ivorycoast",
};
function norm(s){ return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]/g,""); }
function canon(s){ const n=norm(s); return ALIAS[n]||n; }

const byPair = {};
for(const [id,h,a] of MAP){ const hn=canon(h), an=canon(a); byPair[[hn,an].sort().join("|")]={id,hn,an}; }

module.exports = async (req, res) => {
  // --- protect the endpoint ---
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || "";
  const token = (req.query && req.query.token) || "";
  if (secret && auth !== `Bearer ${secret}` && token !== secret) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const API_KEY = process.env.API_FOOTBALL_KEY;
  const SB_URL  = process.env.SUPABASE_URL;
  const SB_KEY  = process.env.SUPABASE_SERVICE_KEY;
  if (!API_KEY || !SB_URL || !SB_KEY) {
    return res.status(500).json({ error: "Missing environment variables", have: { API_KEY: !!API_KEY, SB_URL: !!SB_URL, SB_KEY: !!SB_KEY } });
  }

  const apiGet = async (path) => {
    const r = await fetch(`https://v3.football.api-sports.io/${path}`, { headers: { "x-apisports-key": API_KEY } });
    return r.json();
  };
  const sbUpsert = async (table, rows, conflict = "match_id") => {
    if (!rows.length) return { count: 0 };
    const r = await fetch(`${SB_URL}/rest/v1/${table}?on_conflict=${conflict}`, {
      method: "POST",
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows),
    });
    return { ok: r.ok, status: r.status, count: rows.length, error: r.ok ? null : await r.text() };
  };

  try {
    const fx = await apiGet(`fixtures?league=${WC_LEAGUE}&season=${WC_SEASON}`);
    const fixtures = fx.response || [];
    if (!fixtures.length && fx.errors && Object.keys(fx.errors).length) {
      return res.status(502).json({ error: "API-Football error", details: fx.errors });
    }

    const FINISHED = new Set(["FT", "AET", "PEN"]);
    const resultsRows = [], upcoming = [], unmatched = [], kickoffRows = [];

    for (const f of fixtures) {
      const hn = canon(f.teams.home.name), an = canon(f.teams.away.name);
      const m = byPair[[hn, an].sort().join("|")];
      if (!m) { unmatched.push(`${f.teams.home.name} vs ${f.teams.away.name}`); continue; }
      const same = hn === m.hn; // does API's home == our home?
      if (FINISHED.has(f.fixture.status.short) && f.goals.home != null && f.goals.away != null) {
        resultsRows.push({ match_id: m.id, home: same ? f.goals.home : f.goals.away, away: same ? f.goals.away : f.goals.home });
      }
      const ts = (f.fixture.timestamp || 0) * 1000;
      if (ts > 0) kickoffRows.push({ id: m.id, kickoff: new Date(ts).toISOString() });
      if (ts > Date.now() && ts - Date.now() < 48 * 3600 * 1000) upcoming.push({ id: m.id, fixtureId: f.fixture.id, same });
    }

    // odds for matches kicking off within 48h (cap to stay friendly to quota)
    const oddsRows = [];
    for (const u of upcoming.slice(0, 12)) {
      try {
        const pj = await apiGet(`predictions?fixture=${u.fixtureId}`);
        const pct = pj.response && pj.response[0] && pj.response[0].predictions && pj.response[0].predictions.percent;
        if (pct) {
          const h = parseInt(pct.home), d = parseInt(pct.draw), a = parseInt(pct.away);
          if (!isNaN(h) && !isNaN(d) && !isNaN(a)) {
            oddsRows.push({ match_id: u.id, home_pct: u.same ? h : a, draw_pct: d, away_pct: u.same ? a : h, source: "api-football" });
          }
        }
      } catch (e) { /* skip this one */ }
    }

    const r1 = await sbUpsert("results", resultsRows);
    const r2 = await sbUpsert("match_odds", oddsRows);
    let r3 = { count: 0 };
    try { r3 = await sbUpsert("matches", kickoffRows, "id"); } catch (e) { r3 = { error: String(e) }; }

    return res.status(200).json({
      ok: true,
      fixtures_seen: fixtures.length,
      results_written: resultsRows.length,
      odds_written: oddsRows.length,
      kickoffs_written: r3.count || 0,
      results_db: r1, odds_db: r2,
      unmatched_team_names: unmatched, // <-- if any names show here, send them to me and I'll add the alias
    });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
};
