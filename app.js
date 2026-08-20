import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { create } from 'zustand';
import Dexie from 'dexie';

const { useState: uS, useEffect: uE, useRef: uR, useCallback: uC, useMemo: uM } = React;

// ─── DB ───────────────────────────────────────────────
class AdvantageDB extends Dexie {
  constructor() {
    super('AdvantageAnalytics');
    this.version(1).stores({ matches: 'match_id, date, surface' });
  }
}
const db = new AdvantageDB();

async function saveMatch(m) { await db.matches.put(m); }
async function getMatch(id) { return db.matches.get(id); }
async function getAllMatches() { return db.matches.orderBy('date').reverse().toArray(); }
async function deleteMatch(id) { await db.matches.delete(id); }
async function nextMatchId() {
  const last = await db.matches.orderBy('match_id').last();
  return (last?.match_id ?? 0) + 1;
}

// ─── Scoring ──────────────────────────────────────────
function createInitialScore(server = 'A') {
  return {
    setsA: 0, setsB: 0, gamesA: 0, gamesB: 0,
    pointsA: 0, pointsB: 0, isTiebreak: false,
    server, serveSide: 'deuce', setNumber: 1, gameNumber: 1,
    matchOver: false, winner: null,
  };
}

function formatPointScore(s) {
  if (s.isTiebreak) return `${s.pointsA}-${s.pointsB}`;
  if (s.pointsA >= 3 && s.pointsB >= 3) {
    if (s.pointsA === s.pointsB) return '40-40';
    if (s.pointsA > s.pointsB) return 'Ad-40';
    return '40-Ad';
  }
  const L = ['0', '15', '30', '40'];
  return `${L[s.pointsA] ?? '0'}-${L[s.pointsB] ?? '0'}`;
}

function getPointContext(s, format) {
  if (s.isTiebreak) {
    if (s.pointsA >= 6 && s.pointsA >= s.pointsB) return 'set_point';
    if (s.pointsB >= 6 && s.pointsB >= s.pointsA) return 'set_point';
    return 'regular';
  }
  const pa = s.pointsA, pb = s.pointsB, ga = s.gamesA, gb = s.gamesB;
  const setsToWin = format === 'best_of_3' ? 2 : 3;
  if (pa >= 3 && pb >= 3 && pa === pb) return 'deuce';
  const aGP = (pa >= 3 && pa > pb) || (pa === 3 && pb < 3);
  const bGP = (pb >= 3 && pb > pa) || (pb === 3 && pa < 3);
  const aSP = aGP && ga >= 5 && ga > gb;
  const bSP = bGP && gb >= 5 && gb > ga;
  if ((aSP && s.setsA === setsToWin - 1) || (bSP && s.setsB === setsToWin - 1)) return 'match_point';
  if (aSP || bSP) return 'set_point';
  const ret = s.server === 'A' ? 'B' : 'A';
  if ((ret === 'A' && aGP) || (ret === 'B' && bGP)) return 'break_point';
  if (aGP || bGP) return 'game_point';
  return 'regular';
}

function applyPoint(score, winner, format) {
  if (score.matchOver) return { next: score, gameEnded: false, setEnded: false, matchEnded: true };
  const next = { ...score };
  let gameEnded = false, setEnded = false, matchEnded = false;

  if (next.isTiebreak) {
    if (winner === 'A') next.pointsA++; else next.pointsB++;
    const total = next.pointsA + next.pointsB;
    if (total === 1 || (total > 1 && (total - 1) % 2 === 0)) {
      next.server = next.server === 'A' ? 'B' : 'A';
    }
    next.serveSide = total % 2 === 0 ? 'deuce' : 'ad';
    const aW = next.pointsA >= 7 && next.pointsA - next.pointsB >= 2;
    const bW = next.pointsB >= 7 && next.pointsB - next.pointsA >= 2;
    if (aW || bW) {
      gameEnded = true; setEnded = true;
      if (aW) { next.gamesA = 7; next.gamesB = 6; next.setsA++; }
      else { next.gamesB = 7; next.gamesA = 6; next.setsB++; }
      next.pointsA = 0; next.pointsB = 0; next.isTiebreak = false;
      next.gameNumber = 1; next.setNumber++;
      next.server = next.server === 'A' ? 'B' : 'A';
      next.serveSide = 'deuce';
    }
  } else {
    if (winner === 'A') next.pointsA++; else next.pointsB++;
    const aWG = (next.pointsA >= 4 && next.pointsA - next.pointsB >= 2) || (next.pointsA === 4 && next.pointsB < 3);
    const bWG = (next.pointsB >= 4 && next.pointsB - next.pointsA >= 2) || (next.pointsB === 4 && next.pointsA < 3);
    if (aWG || bWG) {
      gameEnded = true;
      if (aWG) next.gamesA++; else next.gamesB++;
      next.pointsA = 0; next.pointsB = 0; next.gameNumber++;
      next.server = next.server === 'A' ? 'B' : 'A';
      next.serveSide = 'deuce';
      const ga = next.gamesA, gb = next.gamesB;
      if ((ga >= 6 && ga - gb >= 2) || (gb >= 6 && gb - ga >= 2)) {
        setEnded = true;
        if (ga > gb) next.setsA++; else next.setsB++;
        next.gamesA = 0; next.gamesB = 0; next.gameNumber = 1; next.setNumber++;
      } else if (ga === 6 && gb === 6) {
        next.isTiebreak = true; next.pointsA = 0; next.pointsB = 0; next.serveSide = 'deuce';
      }
    } else {
      next.serveSide = next.serveSide === 'deuce' ? 'ad' : 'deuce';
    }
  }
  const setsToWin = format === 'best_of_3' ? 2 : 3;
  if (next.setsA >= setsToWin || next.setsB >= setsToWin) {
    matchEnded = true; next.matchOver = true;
    next.winner = next.setsA > next.setsB ? 'A' : 'B';
  }
  return { next, gameEnded, setEnded, matchEnded };
}

function nextPointId(match) {
  let max = 0;
  for (const s of match.sets)
    for (const g of s.games)
      for (const p of g.points)
        if (p.point_id > max) max = p.point_id;
  return max + 1;
}

function addPointToMatch(match, point, { newGame, newSet, isTiebreak }) {
  const sets = match.sets.map(s => ({
    ...s,
    games: s.games.map(g => ({ ...g, points: [...g.points] })),
  }));
  if (sets.length === 0 || newSet) {
    sets.push({
      set_number: sets.length + 1,
      games: [{ game_number: isTiebreak ? null : 1, is_tiebreak: isTiebreak, points: [point] }],
    });
  } else {
    const lastSet = sets[sets.length - 1];
    if (newGame || lastSet.games.length === 0) {
      lastSet.games.push({
        game_number: isTiebreak ? null : lastSet.games.length + 1,
        is_tiebreak: isTiebreak,
        points: [point],
      });
    } else {
      lastSet.games[lastSet.games.length - 1].points.push(point);
    }
  }
  return { ...match, sets };
}

function flattenPoints(match) {
  const pts = [];
  for (const s of match.sets)
    for (const g of s.games)
      pts.push(...g.points);
  return pts;
}

// ─── Store ────────────────────────────────────────────
const emptyDraft = () => ({
  serve_type: null, serve_result: null, isAce: false,
  isReturnWinner: false, isReturnError: false, return_type: null,
  winner: null, point_result: null, final_type: null,
  ball_count: null, court_detail: null, start_time: null,
});

const useStore = create((set, get) => ({
  match: null,
  score: createInitialScore(),
  draft: emptyDraft(),
  page: 'home', // home | new | capture | stats
  statsMatchId: null,
  pendingNewGame: false,
  pendingNewSet: false,
  matches: [],

  refreshMatches: async () => {
    const list = await getAllMatches();
    set({ matches: list });
  },

  go: (page, statsMatchId = null) => set({ page, statsMatchId }),

  startNewMatch: async ({ playerA, playerB, format, surface, firstServer }) => {
    const id = await nextMatchId();
    const match = {
      match_id: id,
      players: { player_a: { name: playerA || 'Player A' }, player_b: { name: playerB || 'Player B' } },
      match_format: format,
      surface: surface || 'Hard',
      date: new Date().toISOString().slice(0, 10),
      notes: null,
      sets: [],
    };
    await saveMatch(match);
    set({
      match,
      score: createInitialScore(firstServer),
      draft: { ...emptyDraft(), start_time: new Date().toISOString() },
      page: 'capture',
      pendingNewGame: false,
      pendingNewSet: false,
    });
  },

  loadMatch: (match) => set({
    match,
    score: createInitialScore(match.sets?.[0]?.games?.[0]?.points?.[0]?.server || 'A'),
    draft: emptyDraft(),
    page: 'capture',
    pendingNewGame: false,
    pendingNewSet: false,
  }),

  resetDraft: () => set({ draft: { ...emptyDraft(), start_time: new Date().toISOString() } }),

  setServeType: (t) => set(s => ({
    draft: {
      ...s.draft, serve_type: t,
      serve_result: s.draft.isAce ? 'ace' : 'in_play',
      start_time: s.draft.start_time ?? new Date().toISOString(),
    },
  })),

  setAce: (v) => set(s => ({
    draft: {
      ...s.draft, isAce: v, isReturnWinner: false, isReturnError: false,
      serve_result: v ? 'ace' : (s.draft.serve_type ? 'in_play' : null),
      point_result: v ? 'ace' : null,
      winner: v ? s.score.server : null,
      ball_count: v ? 1 : null,
    },
  })),

  setDoubleFault: () => set(s => ({
    draft: {
      ...s.draft,
      serve_type: s.draft.serve_type ?? 2,
      serve_result: 'double_fault', isAce: false, isReturnWinner: false, isReturnError: false,
      point_result: 'double_fault',
      winner: s.score.server === 'A' ? 'B' : 'A',
      ball_count: 1,
      start_time: s.draft.start_time ?? new Date().toISOString(),
    },
  })),

  setReturnWinner: (v) => set(s => ({
    draft: {
      ...s.draft, isReturnWinner: v, isReturnError: false, isAce: false,
      point_result: v ? 'return_winner' : null,
      winner: v ? (s.score.server === 'A' ? 'B' : 'A') : null,
      ball_count: v ? 2 : null, serve_result: 'in_play',
    },
  })),

  setReturnError: (v) => set(s => ({
    draft: {
      ...s.draft, isReturnError: v, isReturnWinner: false, isAce: false,
      point_result: v ? 'return_error' : null,
      winner: v ? s.score.server : null,
      ball_count: v ? 2 : null, serve_result: 'in_play',
    },
  })),

  setReturnType: (t) => set(s => ({ draft: { ...s.draft, return_type: t } })),
  setWinner: (w) => set(s => ({ draft: { ...s.draft, winner: w } })),
  setPointResult: (r) => set(s => ({
    draft: {
      ...s.draft, point_result: r,
      final_type: (r === 'winner' || r === 'unforced_error') ? s.draft.final_type : null,
    },
  })),
  setFinalType: (t) => set(s => ({ draft: { ...s.draft, final_type: t } })),
  setBallCount: (n) => set(s => ({ draft: { ...s.draft, ball_count: n } })),
  updateCourtDetail: (partial) => set(s => ({
    draft: { ...s.draft, court_detail: { ...(s.draft.court_detail || {}), ...partial } },
  })),

  confirmPoint: async () => {
    const { match, score, draft, pendingNewGame, pendingNewSet } = get();
    if (!match || !draft.winner || !draft.point_result || !draft.serve_type || !draft.serve_result) return;

    const end = new Date().toISOString();
    const start = draft.start_time ?? end;
    const point = {
      point_id: nextPointId(match),
      server: score.server,
      returner: score.server === 'A' ? 'B' : 'A',
      serve_side: score.serveSide,
      serve_type: draft.serve_type,
      serve_result: draft.serve_result,
      point_result: draft.point_result,
      winner: draft.winner,
      score_before: formatPointScore(score),
      point_context: getPointContext(score, match.match_format),
      return_type: draft.return_type,
      final_type: draft.final_type,
      ball_count: draft.ball_count ?? (draft.isAce || draft.serve_result === 'double_fault' ? 1 : 2),
      start_time: start,
      end_time: end,
      duration_ms: Math.max(0, new Date(end) - new Date(start)),
      derived_serve_zone: null,
      court_detail: draft.court_detail,
    };

    const wasTB = score.isTiebreak;
    const { next, gameEnded, setEnded } = applyPoint(score, draft.winner, match.match_format);
    const updated = addPointToMatch(match, point, {
      newGame: pendingNewGame || match.sets.length === 0,
      newSet: pendingNewSet || match.sets.length === 0,
      isTiebreak: wasTB,
    });

    try { await saveMatch(updated); } catch (e) { console.error(e); }

    set({
      match: updated,
      score: next,
      draft: { ...emptyDraft(), start_time: new Date().toISOString() },
      pendingNewGame: gameEnded && !setEnded,
      pendingNewSet: setEnded,
    });
  },

  clearMatch: () => set({
    match: null, score: createInitialScore(), draft: emptyDraft(),
    page: 'home', pendingNewGame: false, pendingNewSet: false,
  }),

  removeMatch: async (id) => {
    await deleteMatch(id);
    const list = await getAllMatches();
    set({ matches: list });
  },
}));

// ─── Components ───────────────────────────────────────

function Home() {
  const { matches, refreshMatches, go, loadMatch, removeMatch } = useStore();
  useEffect(() => { refreshMatches(); }, []);

  return (
    <div className="wrap" style={{ padding: '1.5rem 1rem' }}>
      <h1 className="title"><span className="neon">Advantage</span> Analytics</h1>
      <p className="muted" style={{ marginTop: 4 }}>Captura courtside · Local-first · v0.3.1</p>
      <div style={{ height: '1.5rem' }} />
      <button className="btn btn-primary" style={{ width: '100%', padding: '1rem', fontSize: '1.1rem' }}
        onClick={() => go('new')}>+ Nuevo Partido</button>
      <div style={{ height: '1.5rem' }} />
      <p className="muted" style={{ textTransform: 'uppercase', letterSpacing: '.05em' }}>Partidos guardados</p>
      <div style={{ height: '.5rem' }} />
      {matches.length === 0 ? (
        <p className="muted" style={{ textAlign: 'center', padding: '3rem 0' }}>Ningún partido todavía.</p>
      ) : matches.map(m => (
        <div key={m.match_id} className="glass card" style={{ marginBottom: '.75rem' }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <strong>{m.players.player_a.name}</strong> <span className="muted">vs</span> <strong>{m.players.player_b.name}</strong>
              <p className="muted">{m.date} · {m.surface} · {m.match_format === 'best_of_3' ? 'Bo3' : 'Bo5'}</p>
            </div>
            <span className="muted score-mono">#{m.match_id}</span>
          </div>
          <div className="row" style={{ marginTop: '.5rem' }}>
            <button className="btn-chip" style={{ flex: 1 }} onClick={() => loadMatch(m)}>Continuar</button>
            <button className="btn-chip" style={{ flex: 1 }} onClick={() => go('stats', m.match_id)}>Stats</button>
            <button className="btn-chip err" onClick={() => { if (confirm('¿Eliminar?')) removeMatch(m.match_id); }}>✕</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function NewMatch() {
  const { startNewMatch, go } = useStore();
  const [playerA, setA] = useState('Player A');
  const [playerB, setB] = useState('Player B');
  const [format, setF] = useState('best_of_3');
  const [surface, setS] = useState('Hard');
  const [first, setFirst] = useState('A');
  const [loading, setL] = useState(false);

  const start = async () => {
    setL(true);
    await startNewMatch({ playerA, playerB, format, surface, firstServer: first });
    setL(false);
  };

  return (
    <div className="wrap" style={{ padding: '1.5rem 1rem' }}>
      <button className="muted" onClick={() => go('home')} style={{ background: 'none', border: 'none', cursor: 'pointer', marginBottom: '1rem' }}>← Volver</button>
      <h1 className="title">Nuevo Partido</h1>
      <div className="col" style={{ marginTop: '1.25rem' }}>
        <label className="muted">Jugador A
          <input value={playerA} onChange={e => setA(e.target.value)} style={{ marginTop: 4 }} />
        </label>
        <label className="muted">Jugador B
          <input value={playerB} onChange={e => setB(e.target.value)} style={{ marginTop: 4 }} />
        </label>
        <div>
          <span className="muted">Formato</span>
          <div className="row" style={{ marginTop: 4 }}>
            <button className={`btn-chip ${format === 'best_of_3' ? 'active' : ''}`} style={{ flex: 1 }} onClick={() => setF('best_of_3')}>Best of 3</button>
            <button className={`btn-chip ${format === 'best_of_5' ? 'active' : ''}`} style={{ flex: 1 }} onClick={() => setF('best_of_5')}>Best of 5</button>
          </div>
        </div>
        <div>
          <span className="muted">Superficie</span>
          <div className="row" style={{ marginTop: 4, flexWrap: 'wrap' }}>
            {['Hard', 'Clay', 'Grass', 'Carpet'].map(s => (
              <button key={s} className={`btn-chip ${surface === s ? 'active' : ''}`} onClick={() => setS(s)}>{s}</button>
            ))}
          </div>
        </div>
        <div>
          <span className="muted">Primer saque</span>
          <div className="row" style={{ marginTop: 4 }}>
            <button className={`btn-chip ${first === 'A' ? 'active' : ''}`} style={{ flex: 1 }} onClick={() => setFirst('A')}>{playerA}</button>
            <button className={`btn-chip ${first === 'B' ? 'active' : ''}`} style={{ flex: 1 }} onClick={() => setFirst('B')}>{playerB}</button>
          </div>
        </div>
        <button className="btn btn-primary" style={{ width: '100%', padding: '1rem', marginTop: '.5rem' }}
          disabled={loading || !playerA.trim() || !playerB.trim()} onClick={start}>
          {loading ? 'Creando…' : 'Empezar captura'}
        </button>
      </div>
    </div>
  );
}

function CourtModal({ mode, onClose }) {
  const updateCourtDetail = useStore(s => s.updateCourtDetail);
  const markersMap = {
    saque: [{ key: 'sacador', label: 'Sacador', color: '#CCFF00' }, { key: 'bote', label: 'Bote', color: '#00F0FF' }],
    doble_falta: [{ key: 'sacador', label: 'Sacador', color: '#CCFF00' }, { key: 'bote', label: 'Bote falta', color: '#FF4D4D' }],
    devolucion: [{ key: 'restador', label: 'Restador', color: '#CCFF00' }, { key: 'bote', label: 'Bote dev.', color: '#00F0FF' }],
    golpe_final_winner: [{ key: 'ejecutor', label: 'Ejecutor', color: '#CCFF00' }, { key: 'destino', label: 'Destino', color: '#00F0FF' }],
    golpe_final_ue: [{ key: 'ejecutor', label: 'Jugador', color: '#CCFF00' }, { key: 'tiro_errado', label: 'Tiro errado', color: '#FF4D4D' }],
    error_forzado: [{ key: 'posicion_inicial', label: 'Pos. inicial', color: '#CCFF00' }, { key: 'posicion_final', label: 'Pos. final', color: '#FF4D4D' }],
  };
  const markers = markersMap[mode] || markersMap.saque;
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState({});
  const svgRef = useRef(null);

  const handleTap = (e) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    const key = markers[active].key;
    setPos(p => ({ ...p, [key]: { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) } }));
    if (active < markers.length - 1) setActive(a => a + 1);
  };

  const save = () => {
    const partial = {};
    if (mode === 'saque' && pos.sacador && pos.bote) partial.saque = { sacador: pos.sacador, bote: pos.bote };
    if (mode === 'doble_falta' && pos.sacador && pos.bote) partial.doble_falta = { sacador: pos.sacador, bote: pos.bote };
    if (mode === 'devolucion' && pos.restador && pos.bote) partial.devolucion = { restador: pos.restador, bote: pos.bote };
    if (mode === 'golpe_final_winner' && pos.ejecutor && pos.destino) partial.golpe_final = { ejecutor: pos.ejecutor, destino: pos.destino };
    if (mode === 'golpe_final_ue' && pos.ejecutor && pos.tiro_errado) partial.golpe_final = { ejecutor: pos.ejecutor, tiro_errado: pos.tiro_errado };
    if (mode === 'error_forzado' && pos.posicion_inicial && pos.posicion_final) partial.error_forzado = { posicion_inicial: pos.posicion_inicial, posicion_final: pos.posicion_final };
    updateCourtDetail(partial);
    onClose();
  };

  const allPlaced = markers.every(m => pos[m.key]);
  const isHalf = mode === 'error_forzado';

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(10,25,47,.95)', display: 'flex', flexDirection: 'column' }}>
      <div className="row" style={{ justifyContent: 'space-between', padding: '.75rem 1rem', borderBottom: '1px solid rgba(255,255,255,.1)' }}>
        <button className="muted" style={{ background: 'none', border: 'none', cursor: 'pointer' }} onClick={onClose}>Cerrar</button>
        <strong style={{ fontSize: '.875rem' }}>Court Detail</strong>
        <button className="neon" style={{ background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, opacity: allPlaced ? 1 : .4 }}
          disabled={!allPlaced} onClick={save}>Guardar</button>
      </div>
      <div className="row" style={{ padding: '.5rem 1rem', overflowX: 'auto', gap: '.5rem' }}>
        {markers.map((m, i) => (
          <button key={m.key} className={`btn-chip ${i === active ? 'active' : ''}`} onClick={() => setActive(i)}>
            {m.label}{pos[m.key] ? ' ✓' : ''}
          </button>
        ))}
      </div>
      <p className="muted" style={{ textAlign: 'center' }}>Toca la cancha: <span className="neon">{markers[active]?.label}</span></p>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '.5rem' }}>
        <svg ref={svgRef} viewBox={isHalf ? '0 200 200 200' : '0 0 200 400'} className="court"
          onClick={handleTap} onTouchStart={handleTap}>
          <rect width="200" height="400" fill="#0A192F" />
          <rect x="42.5" y="35" width="115" height="330" fill="#0d2137" stroke="#4a7ab0" strokeWidth="1.5" />
          <line x1="42.5" y1="200" x2="157.5" y2="200" stroke="#E2E8F0" strokeWidth="2" />
          <line x1="100" y1="35" x2="100" y2="365" stroke="#4a7ab0" strokeWidth="1" strokeDasharray="4 2" />
          <line x1="42.5" y1="124" x2="157.5" y2="124" stroke="#4a7ab0" strokeWidth="1" />
          <line x1="42.5" y1="276" x2="157.5" y2="276" stroke="#4a7ab0" strokeWidth="1" />
          <line x1="100" y1="124" x2="100" y2="276" stroke="#4a7ab0" strokeWidth="1" />
          {markers.map(m => {
            const p = pos[m.key];
            if (!p) return null;
            return (
              <g key={m.key}>
                <circle cx={p.x * 200} cy={p.y * 400} r="6" fill={m.color} stroke="#0A192F" strokeWidth="1.5" />
                <text x={p.x * 200} y={p.y * 400 - 10} textAnchor="middle" fill={m.color} fontSize="8" fontWeight="600">{m.label}</text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

function Capture() {
  const store = useStore();
  const { match, score, draft, confirmPoint, resetDraft, clearMatch, go } = store;
  const [step, setStep] = useState('serve');
  const [showConfirm, setShowConfirm] = useState(false);
  const [courtMode, setCourtMode] = useState(null);

  if (!match) {
    return (
      <div className="wrap" style={{ alignItems: 'center', justifyContent: 'center', padding: '2rem' }}>
        <p className="muted">No hay partido activo.</p>
        <button className="btn btn-primary" style={{ marginTop: '1rem' }} onClick={() => go('new')}>Crear partido</button>
      </div>
    );
  }

  const nameA = match.players.player_a.name;
  const nameB = match.players.player_b.name;
  const serverName = score.server === 'A' ? nameA : nameB;

  const canConfirmEarly = draft.isAce || draft.serve_result === 'double_fault' || draft.isReturnWinner || draft.isReturnError;
  const canRegister = canConfirmEarly || (draft.winner && draft.point_result);

  const resultLabels = {
    ace: 'Ace', double_fault: 'Doble falta', return_winner: 'Devolución ganadora',
    return_error: 'Error de devolución', winner: 'Winner', forced_error: 'Error forzado', unforced_error: 'Error no forzado',
  };

  return (
    <div className="wrap">
      <header className="header glass">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: '.5rem' }}>
          <button className="muted" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '.75rem' }} onClick={() => go('home')}>← Home</button>
          <button className="cyan" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '.75rem', fontWeight: 500 }}
            onClick={() => go('stats', match.match_id)}>Stats →</button>
        </div>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <p style={{ fontSize: '.875rem', color: score.server === 'A' ? '#CCFF00' : '#94a3b8' }}>
              {score.server === 'A' ? '● ' : ''}{nameA}
            </p>
            <p className="score-mono" style={{ fontSize: '1.5rem', fontWeight: 700 }}>{score.setsA} · {score.gamesA}</p>
          </div>
          <div style={{ textAlign: 'center', padding: '0 .5rem' }}>
            <p className="score-mono neon" style={{ fontSize: '1.25rem' }}>{formatPointScore(score)}</p>
            <p className="muted" style={{ textTransform: 'uppercase', letterSpacing: '.05em', marginTop: 2 }}>
              {score.isTiebreak ? 'Tie-break' : score.serveSide}
            </p>
          </div>
          <div style={{ flex: 1, textAlign: 'right' }}>
            <p style={{ fontSize: '.875rem', color: score.server === 'B' ? '#CCFF00' : '#94a3b8' }}>
              {nameB}{score.server === 'B' ? ' ●' : ''}
            </p>
            <p className="score-mono" style={{ fontSize: '1.5rem', fontWeight: 700 }}>{score.setsB} · {score.gamesB}</p>
          </div>
        </div>
        <p className="muted" style={{ textAlign: 'center', marginTop: 4 }}>
          Saque: <span className="neon">{serverName}</span>
          {score.matchOver && <span className="cyan"> · Ganador: {score.winner === 'A' ? nameA : nameB}</span>}
        </p>
      </header>

      <main className="main">
        {step === 'serve' && (
          <div className="col">
            <h2 style={{ fontSize: '1.1rem' }}>1. Servicio</h2>
            <div className="row">
              <button className={`btn-chip ${draft.serve_type === 1 ? 'active' : ''}`} style={{ flex: 1 }} onClick={() => store.setServeType(1)}>1er Saque</button>
              <button className={`btn-chip ${draft.serve_type === 2 ? 'active' : ''}`} style={{ flex: 1 }} onClick={() => store.setServeType(2)}>2º Saque</button>
            </div>
            {draft.serve_type && (
              <>
                <div className="glass card row" style={{ justifyContent: 'space-between' }}>
                  <span style={{ fontWeight: 500 }}>¿Fue Ace?</span>
                  <button className={`btn-chip ${draft.isAce ? 'active' : ''}`} onClick={() => store.setAce(!draft.isAce)}>
                    {draft.isAce ? 'SÍ' : 'NO'}
                  </button>
                </div>
                <button
                  className={draft.serve_result === 'double_fault' ? 'btn btn-danger' : 'btn btn-ghost'}
                  style={{ width: '100%', border: draft.serve_result !== 'double_fault' ? '1px solid rgba(255,77,77,.4)' : undefined, color: draft.serve_result !== 'double_fault' ? '#FF4D4D' : undefined }}
                  onClick={() => store.setDoubleFault()}>Doble Falta</button>
                <div className="row" style={{ flexWrap: 'wrap' }}>
                  <button className="btn-chip" style={{ fontSize: '.75rem' }}
                    onClick={() => setCourtMode(draft.serve_result === 'double_fault' ? 'doble_falta' : 'saque')}>📍 Registrar saque</button>
                  {draft.serve_result !== 'double_fault' && !draft.isAce && (
                    <button className="btn-chip" style={{ fontSize: '.75rem' }} onClick={() => setCourtMode('devolucion')}>📍 Registrar devolución</button>
                  )}
                </div>
                {!draft.isAce && draft.serve_result !== 'double_fault' && (
                  <div className="col" style={{ borderTop: '1px solid rgba(255,255,255,.1)', paddingTop: '.75rem' }}>
                    <p className="muted">Devolución</p>
                    <div className="row">
                      <button className={`btn-chip ${draft.isReturnWinner ? 'active' : ''}`} style={{ flex: 1 }}
                        onClick={() => store.setReturnWinner(!draft.isReturnWinner)}>Devolución ganadora</button>
                      <button className={`btn-chip ${draft.isReturnError ? 'active' : ''}`} style={{ flex: 1 }}
                        onClick={() => store.setReturnError(!draft.isReturnError)}>Error devolución</button>
                    </div>
                    {(draft.isReturnWinner || draft.isReturnError) && (
                      <div className="row">
                        {[['forehand', 'FH'], ['backhand', 'BH'], ['block_slice', 'Block']].map(([t, l]) => (
                          <button key={t} className={`btn-chip ${draft.return_type === t ? 'active' : ''}`} style={{ flex: 1, fontSize: '.75rem' }}
                            onClick={() => store.setReturnType(t)}>{l}</button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                <button className="btn btn-primary" style={{ width: '100%' }} onClick={() => {
                  if (canConfirmEarly) setShowConfirm(true);
                  else setStep('winner');
                }}>
                  {canConfirmEarly ? 'Ir a confirmación' : 'Siguiente →'}
                </button>
              </>
            )}
          </div>
        )}

        {step === 'winner' && (
          <div className="col">
            <button className="muted" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '.875rem' }} onClick={() => setStep('serve')}>← Volver</button>
            <h2 style={{ fontSize: '1.1rem' }}>2. ¿Quién ganó el punto?</h2>
            <div className="row" style={{ gap: '.75rem' }}>
              <button className={`btn ${draft.winner === 'A' ? 'btn-primary' : 'btn-ghost'}`} style={{ flex: 1, padding: '1.5rem', fontSize: '1.1rem' }}
                onClick={() => { store.setWinner('A'); setStep('ending'); }}>{nameA}</button>
              <button className={`btn ${draft.winner === 'B' ? 'btn-primary' : 'btn-ghost'}`} style={{ flex: 1, padding: '1.5rem', fontSize: '1.1rem' }}
                onClick={() => { store.setWinner('B'); setStep('ending'); }}>{nameB}</button>
            </div>
          </div>
        )}

        {step === 'ending' && (
          <div className="col">
            <button className="muted" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '.875rem' }} onClick={() => setStep('winner')}>← Volver</button>
            <h2 style={{ fontSize: '1.1rem' }}>3. ¿Cómo terminó?</h2>
            {['winner', 'unforced_error', 'forced_error'].map(r => (
              <button key={r} className={`btn-chip ${draft.point_result === r ? 'active' : ''}`}
                onClick={() => store.setPointResult(r)}>
                {r === 'winner' ? 'Winner' : r === 'unforced_error' ? 'Error no forzado' : 'Error forzado'}
              </button>
            ))}
            {draft.point_result === 'winner' && (
              <div className="col">
                <p className="muted">Tipo de golpe</p>
                <div className="row" style={{ flexWrap: 'wrap' }}>
                  {[['forehand', 'Derecha'], ['backhand', 'Revés'], ['volley', 'Volea'], ['drop_shot', 'Dejada']].map(([t, l]) => (
                    <button key={t} className={`btn-chip ${draft.final_type === t ? 'active' : ''}`} onClick={() => store.setFinalType(t)}>{l}</button>
                  ))}
                </div>
                <button className="btn-chip" style={{ fontSize: '.75rem' }} onClick={() => setCourtMode('golpe_final_winner')}>📍 Court Detail</button>
              </div>
            )}
            {draft.point_result === 'unforced_error' && (
              <div className="col">
                <p className="muted">Tipo de golpe</p>
                <div className="row" style={{ flexWrap: 'wrap' }}>
                  {[['forehand', 'Derecha'], ['backhand', 'Revés'], ['slice', 'Slice'], ['volley', 'Volea'], ['smash', 'Remate']].map(([t, l]) => (
                    <button key={t} className={`btn-chip ${draft.final_type === t ? 'active' : ''}`} onClick={() => store.setFinalType(t)}>{l}</button>
                  ))}
                </div>
                <button className="btn-chip" style={{ fontSize: '.75rem' }} onClick={() => setCourtMode('golpe_final_ue')}>📍 Court Detail</button>
              </div>
            )}
            {draft.point_result === 'forced_error' && (
              <button className="btn-chip" style={{ fontSize: '.75rem' }} onClick={() => setCourtMode('error_forzado')}>📍 Court Detail (media cancha)</button>
            )}
            {draft.point_result && (
              <div>
                <p className="muted" style={{ marginBottom: 4 }}>Golpes en el punto</p>
                <div className="row">
                  <button className="btn btn-ghost" style={{ width: 48, height: 48, fontSize: '1.25rem' }}
                    onClick={() => store.setBallCount(Math.max(1, (draft.ball_count ?? 4) - 1))}>−</button>
                  <span className="score-mono" style={{ fontSize: '1.5rem', width: 48, textAlign: 'center' }}>{draft.ball_count ?? 4}</span>
                  <button className="btn btn-ghost" style={{ width: 48, height: 48, fontSize: '1.25rem' }}
                    onClick={() => store.setBallCount((draft.ball_count ?? 4) + 1)}>+</button>
                </div>
              </div>
            )}
            {draft.point_result && (draft.point_result === 'forced_error' || draft.final_type) && (
              <button className="btn btn-primary" style={{ width: '100%' }} onClick={() => setShowConfirm(true)}>Registrar punto</button>
            )}
          </div>
        )}
      </main>

      {!score.matchOver && (
        <footer className="footer glass">
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => { resetDraft(); setStep('serve'); }}>Reset punto</button>
          {canRegister && (
            <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => setShowConfirm(true)}>Registrar punto</button>
          )}
        </footer>
      )}
      {score.matchOver && (
        <footer className="footer glass">
          <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => go('stats', match.match_id)}>Ver estadísticas</button>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => { clearMatch(); }}>Finalizar</button>
        </footer>
      )}

      {showConfirm && draft.winner && draft.point_result && (
        <div className="modal-bg">
          <div className="modal glass">
            <p className="muted" style={{ textAlign: 'center' }}>Confirmar punto</p>
            <p style={{ textAlign: 'center', fontSize: '1.25rem', fontWeight: 600, margin: '.5rem 0 1rem' }}>
              {resultLabels[draft.point_result] || draft.point_result}
              {draft.final_type ? ` de ${draft.final_type}` : ''}
              <br /><span className="neon">Punto para {draft.winner === 'A' ? nameA : nameB}</span>
            </p>
            <p className="muted" style={{ textAlign: 'center', marginBottom: '1.25rem' }}>
              {draft.ball_count ?? '–'} golpes · {score.serveSide} · {draft.serve_type === 1 ? '1er' : '2º'} saque
            </p>
            <div className="row" style={{ gap: '.75rem' }}>
              <button className="btn btn-outline" style={{ flex: 1 }} onClick={() => setShowConfirm(false)}>Revisar</button>
              <button className="btn btn-primary" style={{ flex: 1 }} onClick={async () => {
                await confirmPoint();
                setShowConfirm(false);
                setStep('serve');
              }}>Confirmar</button>
            </div>
          </div>
        </div>
      )}

      {courtMode && <CourtModal mode={courtMode} onClose={() => setCourtMode(null)} />}
    </div>
  );
}

function Stats() {
  const { statsMatchId, go } = useStore();
  const [match, setMatch] = useState(null);

  useEffect(() => {
    if (statsMatchId) getMatch(statsMatchId).then(m => setMatch(m || null));
  }, [statsMatchId]);

  if (!match) {
    return <div className="wrap" style={{ alignItems: 'center', justifyContent: 'center' }}><p className="muted">Cargando…</p></div>;
  }

  const points = flattenPoints(match);
  const nameA = match.players.player_a.name;
  const nameB = match.players.player_b.name;
  const forP = id => points.filter(p => p.winner === id);
  const a = forP('A'), b = forP('B');
  const cnt = (arr, fn) => arr.filter(fn).length;

  const stats = {
    pointsA: a.length, pointsB: b.length,
    acesA: cnt(a, p => p.point_result === 'ace'), acesB: cnt(b, p => p.point_result === 'ace'),
    dfA: cnt(points, p => p.point_result === 'double_fault' && p.server === 'A'),
    dfB: cnt(points, p => p.point_result === 'double_fault' && p.server === 'B'),
    winnersA: cnt(a, p => p.point_result === 'winner' || p.point_result === 'return_winner'),
    winnersB: cnt(b, p => p.point_result === 'winner' || p.point_result === 'return_winner'),
  };

  const exportCSV = () => {
    const headers = ['point_id', 'server', 'serve_side', 'serve_type', 'serve_result', 'point_result', 'winner', 'score_before', 'point_context', 'ball_count'];
    const rows = points.map(p => headers.map(h => JSON.stringify(p[h] ?? '')).join(','));
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `match_${match.match_id}_points.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="wrap" style={{ padding: '1.5rem 1rem' }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: '1.25rem' }}>
        <button className="muted" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '.875rem' }} onClick={() => go('home')}>← Home</button>
        <button className="neon" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '.875rem' }} onClick={() => go('capture')}>Captura →</button>
      </div>
      <h1 className="title">{nameA} <span className="muted">vs</span> {nameB}</h1>
      <p className="muted">{match.date} · {match.surface} · {points.length} puntos</p>
      <div className="grid2" style={{ margin: '1.5rem 0' }}>
        <div className="glass card" style={{ textAlign: 'center' }}>
          <p className="score-mono neon" style={{ fontSize: '1.75rem', fontWeight: 700 }}>{stats.pointsA}</p>
          <p className="muted">Puntos {nameA}</p>
        </div>
        <div className="glass card" style={{ textAlign: 'center' }}>
          <p className="score-mono cyan" style={{ fontSize: '1.75rem', fontWeight: 700 }}>{stats.pointsB}</p>
          <p className="muted">Puntos {nameB}</p>
        </div>
        <div className="glass card" style={{ textAlign: 'center' }}>
          <p className="score-mono" style={{ fontSize: '1.25rem', fontWeight: 700 }}>{stats.acesA} / {stats.acesB}</p>
          <p className="muted">Aces</p>
        </div>
        <div className="glass card" style={{ textAlign: 'center' }}>
          <p className="score-mono err" style={{ fontSize: '1.25rem', fontWeight: 700 }}>{stats.dfA} / {stats.dfB}</p>
          <p className="muted">Dobles faltas</p>
        </div>
      </div>
      <h2 style={{ fontSize: '.875rem', fontWeight: 600, marginBottom: '.5rem' }}>Tabla de puntos</h2>
      <div style={{ overflowX: 'auto', borderRadius: 12, border: '1px solid rgba(255,255,255,.1)' }}>
        <table>
          <thead><tr>
            <th>#</th><th>Score</th><th>Srv</th><th>Result</th><th>Win</th><th>Balls</th>
          </tr></thead>
          <tbody>
            {points.length === 0 ? (
              <tr><td colSpan={6} style={{ textAlign: 'center', padding: '2rem', color: '#64748b' }}>Sin puntos</td></tr>
            ) : points.map(p => (
              <tr key={p.point_id}>
                <td className="score-mono">{p.point_id}</td>
                <td className="score-mono">{p.score_before}</td>
                <td>{p.server}</td>
                <td>{p.point_result}</td>
                <td className="neon" style={{ fontWeight: 600 }}>{p.winner}</td>
                <td className="score-mono">{p.ball_count ?? '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {points.length > 0 && (
        <button className="btn btn-outline" style={{ width: '100%', marginTop: '1rem' }} onClick={exportCSV}>Exportar CSV</button>
      )}
    </div>
  );
}

function App() {
  const page = useStore(s => s.page);
  if (page === 'new') return <NewMatch />;
  if (page === 'capture') return <Capture />;
  if (page === 'stats') return <Stats />;
  return <Home />;
}

createRoot(document.getElementById('root')).render(<App />);
