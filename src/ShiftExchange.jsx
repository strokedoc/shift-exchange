import { useState, useEffect } from "react";
import { ref, get, set } from "firebase/database";
import { db } from "./firebase.js";

const DEFAULT_PIN = "0000";

const TYPES = [
  { key:"ts", label:"Telestroke", short:"TS", cardBg:"bg-sky-50",     cardText:"text-sky-700",     badge:"bg-sky-100 text-sky-700",        btn:"bg-sky-600 hover:bg-sky-700"      },
  { key:"tn", label:"Teleneuro",  short:"TN", cardBg:"bg-violet-50",  cardText:"text-violet-700",  badge:"bg-violet-100 text-violet-700",  btn:"bg-violet-600 hover:bg-violet-700" },
  { key:"ip", label:"Cabarrus",   short:"CB", cardBg:"bg-emerald-50", cardText:"text-emerald-700", badge:"bg-emerald-100 text-emerald-700", btn:"bg-emerald-600 hover:bg-emerald-700"},
];
const getType = k => TYPES.find(t => t.key === k);
const NAMES = [
  "Stephanie McNeill",
  "Christian Sonnefeld",
  "Mary Hollist",
  "Eric Marin",
  "Harsh Patel",
  "Jay Madey",
  "Crystal Yu",
  "Abhinav Katti",
  "Nakia Smith",
  "Varun Pala",
  "Satheesh Bokka",
  "Briana Wasserstrom",
];

const DEFAULTS = {
  "Stephanie McNeill":  { ts:5, tn:12, ip:9 },
  "Christian Sonnefeld":{ ts:4, tn:13, ip:9 },
  "Mary Hollist":       { ts:4, tn:13, ip:9 },
  "Eric Marin":         { ts:4, tn:14, ip:8 },
  "Harsh Patel":        { ts:5, tn:12, ip:9 },
  "Jay Madey":          { ts:4, tn:14, ip:8 },
  "Crystal Yu":         { ts:5, tn:12, ip:9 },
  "Abhinav Katti":      { ts:5, tn:12, ip:9 },
  "Nakia Smith":        { ts:4, tn:14, ip:8 },
  "Varun Pala":         { ts:5, tn:12, ip:9 },
  "Satheesh Bokka":     { ts:4, tn:13, ip:9 },
  "Briana Wasserstrom": { ts:5, tn:12, ip:9 },
};

function fresh(names = NAMES) {
  return {
    physicians: names.map((name,i) => ({ id:i+1, name, ...(DEFAULTS[name] ?? { ts:5, tn:12, ip:9 }) })),
    pool: [],
    exchangeOpen: true,
    claimOpen: false,      // matching active (Round 2)
    adminPin: DEFAULT_PIN,
  };
}

// A pool entry is a 1:1 swap order: give `qty` of giveType for `qty` of wantType.
function normEntry(p) {
  return {
    id: p.id,
    fromId: p.fromId,
    fromName: p.fromName,
    giveType: p.giveType ?? p.type,
    wantType: p.wantType ?? p.type,
    qty: p.qty ?? p.giveQty ?? p.wantQty ?? 0,
    at: p.at,
  };
}

// Greedily settle offers, oldest-first, partial allowed. Each match moves shifts
// only between the parties involved and decrements their orders, so nobody can
// exceed what they declared. Direct 2-way swaps are settled first; any leftover
// is then checked for 3-way cycles (A→B→C→A). With 3 shift types there are only
// two possible cycles, so this stays bounded and deterministic.
function resolveMatches(state) {
  const physicians = state.physicians.map(p => ({ ...p }));
  const byId = Object.fromEntries(physicians.map(p => [p.id, p]));
  let pool = (state.pool ?? []).map(e => ({ ...e }));

  const move = (offer, m) => { byId[offer.fromId][offer.giveType] -= m; byId[offer.fromId][offer.wantType] += m; offer.qty -= m; };

  let guard = 0, again = true;
  while (again && guard < 100000) {
    again = false;
    guard++;
    pool.sort((a, b) => a.at - b.at);

    // 1) Direct pairwise swaps (preferred — only two people involved)
    for (let i = 0; i < pool.length && !again; i++) {
      const A = pool[i];
      if (A.qty <= 0) continue;
      for (let j = 0; j < pool.length; j++) {
        const B = pool[j];
        if (i === j || B.qty <= 0 || A.fromId === B.fromId) continue;
        if (A.giveType === B.wantType && A.wantType === B.giveType) {
          const m = Math.min(A.qty, B.qty);
          move(A, m); move(B, m);
          again = true;
          break;
        }
      }
    }
    if (again) continue;

    // 2) Three-way cycle: A gives x wants y, B gives y wants z, C gives z wants x
    for (let i = 0; i < pool.length && !again; i++) {
      const A = pool[i];
      if (A.qty <= 0) continue;
      for (let j = 0; j < pool.length && !again; j++) {
        const B = pool[j];
        if (B.qty <= 0 || B.fromId === A.fromId || B.giveType !== A.wantType) continue;
        for (let k = 0; k < pool.length; k++) {
          const C = pool[k];
          if (C.qty <= 0 || C.fromId === A.fromId || C.fromId === B.fromId) continue;
          if (C.giveType !== B.wantType || C.wantType !== A.giveType) continue;
          const m = Math.min(A.qty, B.qty, C.qty);
          move(A, m); move(B, m); move(C, m);
          again = true;
          break;
        }
      }
    }
  }
  pool = pool.filter(e => e.qty > 0);
  return { ...state, physicians, pool };
}

export default function App() {
  const [state,    setState]   = useState(null);
  const [loading,  setLoading] = useState(true);
  const [saving,   setSaving]  = useState(false);
  const [userId,   setUserId]  = useState(null);
  const [ofType,   setOfType]  = useState("ts");
  const [ofQty,    setOfQty]   = useState(1);
  const [wantType, setWantType] = useState("tn");
  const [toast,    setToast]   = useState(null);
  const [syncing,  setSyncing] = useState(false);

  // Admin modal
  const [modal,      setModal]      = useState(false);
  const [unlocked,   setUnlocked]   = useState(false);
  const [pin,        setPin]        = useState("");
  const [pinErr,     setPinErr]     = useState(false);
  const [panel,      setPanel]      = useState(null); // "names"|"alloc"|"changepin"
  const [tmpNames,   setTmpNames]   = useState([]);
  const [allocDraft, setAllocDraft] = useState([]);
  const [newPin,     setNewPin]     = useState("");
  const [confPin,    setConfPin]    = useState("");

  // ── Storage ──────────────────────────────────────────────
  const pull = async () => {
    try {
      const snapshot = await get(ref(db, "appstate"));
      if (!snapshot.exists()) return null;
      const d = snapshot.val();
      const pool = (d.pool ? Object.values(d.pool) : []).map(normEntry);
      return { ...d, pool, claimOpen: d.claimOpen ?? false };
    } catch { return null; }
  };

  const push = async s => {
    setSaving(true);
    try {
      await set(ref(db, "appstate"), s);
      setState(s);
      return true;
    } catch { toast2("Save failed — retry", "err"); return false; }
    finally { setSaving(false); }
  };

  useEffect(() => {
    (async () => {
      let d = await pull();
      if (!d) { d = fresh(); await set(ref(db, "appstate"), d).catch(() => {}); }
      if (!d.adminPin) d = { ...d, adminPin: DEFAULT_PIN };
      setState(d); setLoading(false);
    })();
  }, []);

  const toast2 = (msg, type="ok") => { setToast({msg,type}); setTimeout(()=>setToast(null),3000); };

  const closeModal = () => { setModal(false); setPanel(null); };
  const lockAdmin  = () => { setUnlocked(false); setPin(""); setPanel(null); setNewPin(""); setConfPin(""); };

  // ── Derived ──────────────────────────────────────────────
  const me   = state?.physicians.find(p => p.id === userId);
  const mine = (state?.pool??[]).filter(p => p.fromId === userId);

  // ── Shift actions ────────────────────────────────────────
  const offer = async () => {
    const qty = Number(ofQty);
    if (!me || qty < 1) return;
    if (ofType === wantType) return toast2("Give and want must be different types","err");
    // Cap by what you actually hold minus what you've already put up to give.
    const pendingGive = (state.pool??[]).filter(p => p.fromId===me.id && p.giveType===ofType).reduce((s,p)=>s+p.qty,0);
    const avail = me[ofType] - pendingGive;
    if (avail < qty) return toast2(`Only ${Math.max(0,avail)} ${getType(ofType).label} left to offer`,"err");
    let next = {
      ...state,
      pool: [...(state.pool??[]), {
        id:`${Date.now()}-${Math.random().toString(36).slice(2)}`,
        fromId:me.id, fromName:me.name,
        giveType:ofType, wantType, qty, at:Date.now(),
      }],
    };
    if (next.claimOpen) next = resolveMatches(next); // auto-settle if matching is live
    const ok = await push(next);
    if (ok) { toast2(`Offered ${qty}× ${getType(ofType).label}`); setOfQty(1); }
  };

  const retract = async item => {
    // Removes only the unmatched remainder; already-settled trades are permanent.
    const ok = await push({
      ...state,
      pool: (state.pool??[]).filter(p => p.id!==item.id),
    });
    if (ok) toast2("Offer retracted");
  };

  // ── Admin actions ────────────────────────────────────────
  const tryPin = () => {
    if (pin === state.adminPin) { setUnlocked(true); setPin(""); setPinErr(false); }
    else { setPinErr(true); setPin(""); setTimeout(()=>setPinErr(false),1500); }
  };

  const saveNames = async () => {
    const ph = state.physicians.map((p,i)=>({...p, name:tmpNames[i]?.trim()||p.name}));
    const pl = (state.pool??[]).map(item=>{ const x=ph.find(p=>p.id===item.fromId); return x?{...item,fromName:x.name}:item; });
    const ok = await push({...state, physicians:ph, pool:pl});
    if (ok) { setPanel(null); toast2("Names saved"); }
  };

  const saveAlloc = async () => {
    // Row (per-physician) and column (per-type) totals should stay static.
    const rowsOff = allocDraft.filter((p,i)=> state.physicians[i] &&
      (p.ts+p.tn+p.ip) !== (state.physicians[i].ts+state.physicians[i].tn+state.physicians[i].ip)).length;
    const colsOff = ["ts","tn","ip"].filter(k =>
      allocDraft.reduce((s,p)=>s+p[k],0) !== state.physicians.reduce((s,p)=>s+p[k],0));
    if (rowsOff > 0 || colsOff.length > 0) {
      const lines = [];
      if (rowsOff > 0) lines.push(`• ${rowsOff} physician row total(s) changed`);
      if (colsOff.length > 0) lines.push(`• Column total(s) changed: ${colsOff.map(k=>getType(k).short).join(", ")}`);
      const ok = confirm(
        `Totals no longer match the current allocation:\n${lines.join("\n")}\n\n` +
        `This changes the overall number of shifts. Override and save anyway?`
      );
      if (!ok) return;
    }
    const ok = await push({...state, physicians:allocDraft, pool:[]});
    if (ok) { setPanel(null); toast2("Allocations saved — pool cleared"); }
  };

  const savePin = async () => {
    if (newPin.length < 4) return toast2("Min 4 digits","err");
    if (!/^\d+$/.test(newPin)) return toast2("Digits only","err");
    if (newPin !== confPin) return toast2("PINs don't match","err");
    const ok = await push({...state, adminPin:newPin});
    if (ok) { setPanel(null); setNewPin(""); setConfPin(""); toast2("PIN updated ✓"); }
  };

  const resetAll = async () => {
    if (!confirm("Reset all allocations to initial values? Clears the pool. Cannot be undone.")) return;
    const ok = await push({...fresh(state.physicians.map(p=>p.name)), adminPin:state.adminPin});
    if (ok) { setUserId(null); lockAdmin(); closeModal(); toast2("Reset complete"); }
  };

  // ── Loading ──────────────────────────────────────────────
  if (loading) return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center">
      <p className="text-slate-400 text-sm animate-pulse">Loading…</p>
    </div>
  );

  // ── Exchange status ──────────────────────────────────────
  const xStatus = !state.exchangeOpen
    ? { label: "Closed",                       bg: "bg-red-100",   text: "text-red-600",   dot: "bg-red-500",   pulse: false }
    : !state.claimOpen
    ? { label: "Round 1 — Collecting Offers",  bg: "bg-amber-100", text: "text-amber-700", dot: "bg-amber-400", pulse: true  }
    : { label: "Round 2 — Matching Live",      bg: "bg-green-100", text: "text-green-700", dot: "bg-green-500", pulse: true  };

  // ── Name selection ───────────────────────────────────────
  if (!userId) return (
    <div className="min-h-screen bg-slate-50 p-4">
      <div className="max-w-sm mx-auto pt-10">
        <h1 className="text-2xl font-bold text-center text-slate-800">Shift Exchange</h1>
        <p className="text-sm text-center text-slate-500 mt-1 mb-3">Tap your name to continue</p>
        <div className="flex justify-center mb-7">
          <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium ${xStatus.bg} ${xStatus.text}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${xStatus.dot} ${xStatus.pulse?"animate-pulse":""}`} />
            {xStatus.label}
          </span>
        </div>
        <div className="space-y-2">
          {state.physicians.map(p => (
            <button key={p.id} onClick={()=>setUserId(p.id)}
              className="w-full py-4 px-5 bg-white rounded-xl border border-slate-200 shadow-sm flex items-center justify-between hover:bg-slate-50 active:scale-95 transition-all">
              <span className="font-medium text-slate-800">{p.name}</span>
              <span className="text-xs text-slate-400">{p.ts+p.tn+p.ip} shifts</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );

  const ofT = getType(ofType);

  // Pool aggregates (all pending = still unmatched)
  const giveByType = Object.fromEntries(TYPES.map(t => [
    t.key, (state.pool??[]).filter(p => p.giveType===t.key).reduce((s,p)=>s+p.qty,0)
  ]));
  const wantByType = Object.fromEntries(TYPES.map(t => [
    t.key, (state.pool??[]).filter(p => p.wantType===t.key).reduce((s,p)=>s+p.qty,0)
  ]));
  const pendingGiveByType = Object.fromEntries(TYPES.map(t => [
    t.key, (state.pool??[]).filter(p => p.fromId===me.id && p.giveType===t.key).reduce((s,p)=>s+p.qty,0)
  ]));
  const poolTotal = (state.pool??[]).reduce((s,p)=>s+p.qty,0);

  return (
    <div className="min-h-screen bg-slate-50">

      {/* ── Header ── */}
      <header className="sticky top-0 z-20 bg-white border-b border-slate-200 shadow-sm">
        <div className="max-w-md mx-auto px-4 py-3 flex items-center justify-between">
          <div>
            <p className="font-bold text-slate-800 text-sm leading-none">Shift Exchange</p>
            <p className="text-xs text-slate-400 mt-0.5">{me.name}</p>
          </div>
          <div className="flex items-center gap-1">
            <span className={`text-xs px-2.5 py-1 rounded-full font-medium flex items-center gap-1.5 ${xStatus.bg} ${xStatus.text}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${xStatus.dot} ${xStatus.pulse?"animate-pulse":""}`} />
              {!state.exchangeOpen ? "Closed" : !state.claimOpen ? "Round 1" : "Round 2"}
            </span>
            <button onClick={()=>setModal(true)}
              className="ml-1 w-9 h-9 rounded-xl bg-slate-100 hover:bg-slate-200 flex items-center justify-center text-slate-500 transition-colors"
              title="Admin Controls">
              ⚙️
            </button>
            <button onClick={()=>{setUserId(null); lockAdmin();}}
              className="text-xs text-slate-400 hover:text-slate-700 px-2 py-1 rounded-lg hover:bg-slate-100">
              Switch
            </button>
          </div>
        </div>
        {saving && <div className="h-0.5 bg-sky-500 animate-pulse" />}
      </header>

      {/* ── Page content ── */}
      <div className="max-w-md mx-auto p-4 space-y-4 pb-12">

        {/* My Balance */}
        <section className="bg-white rounded-2xl p-4 shadow-sm border border-slate-100">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-slate-700">My Shifts</h2>
            <span className="text-xs text-slate-400">{me.ts+me.tn+me.ip} total</span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {TYPES.map(t => (
              <div key={t.key} className={`${t.cardBg} rounded-xl p-3 text-center`}>
                <p className={`text-3xl font-bold ${t.cardText}`}>{me[t.key]}</p>
                <p className={`text-xs mt-1 ${t.cardText} opacity-75`}>{t.label}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Offer Shifts */}
        {state.exchangeOpen && (
          <section className="bg-white rounded-2xl p-4 shadow-sm border border-slate-100">
            <h2 className="text-sm font-semibold text-slate-700 mb-1">Offer a Swap</h2>
            <p className="text-xs text-slate-400 mb-3">
              {state.claimOpen
                ? "Matching is live — your offer settles (fully or partly) the moment a two- or three-way match exists."
                : "Offers are collected now; they settle when admin opens Round 2."}
            </p>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1.5">Giving up</p>
            <div className="grid grid-cols-3 gap-1.5 mb-3">
              {TYPES.map(t => (
                <button key={t.key} onClick={()=>{setOfType(t.key);setOfQty(1);}}
                  className={`py-2.5 rounded-xl text-sm font-medium transition-all ${ofType===t.key?`${t.btn} text-white shadow-sm`:"bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>
                  {t.label}
                </button>
              ))}
            </div>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1.5">Wants in return</p>
            <div className="grid grid-cols-3 gap-1.5 mb-3">
              {TYPES.map(t => (
                <button key={t.key} onClick={()=>setWantType(t.key)} disabled={t.key===ofType}
                  className={`py-2.5 rounded-xl text-sm font-medium transition-all disabled:opacity-30 ${wantType===t.key?`${t.btn} text-white shadow-sm`:"bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>
                  {t.label}
                </button>
              ))}
            </div>
            <div className="flex gap-2 items-center">
              <div className="flex-1 flex items-center bg-slate-100 rounded-xl overflow-hidden">
                <button onClick={()=>setOfQty(q=>Math.max(1,q-1))} className="px-5 py-3 text-slate-700 text-xl font-bold hover:bg-slate-200 select-none">−</button>
                <span className="flex-1 text-center text-lg font-bold text-slate-800 select-none">{ofQty}</span>
                <button onClick={()=>setOfQty(q=>Math.min(Math.max(1,me[ofType]-pendingGiveByType[ofType]),q+1))} className="px-5 py-3 text-slate-700 text-xl font-bold hover:bg-slate-200 select-none">+</button>
              </div>
              <button onClick={offer} disabled={saving || ofType===wantType || me[ofType]-pendingGiveByType[ofType] <= 0}
                className={`${ofT.btn} text-white px-5 py-3 rounded-xl font-semibold text-sm disabled:opacity-40 shadow-sm`}>
                {saving?"…":"Offer"}
              </button>
            </div>
            <p className="text-xs text-center text-slate-400 mt-2">
              Swap <span className={`font-semibold ${ofT.cardText}`}>{ofQty}× {ofT.label}</span>
              {" → "}<span className={`font-semibold ${getType(wantType).cardText}`}>{ofQty}× {getType(wantType).label}</span>
              {" · "}<span>{Math.max(0,me[ofType]-pendingGiveByType[ofType])} available to give</span>
            </p>
          </section>
        )}

        {/* My Active Offers */}
        {mine.length > 0 && (
          <section className="bg-white rounded-2xl p-4 shadow-sm border border-slate-100">
            <h2 className="text-sm font-semibold text-slate-700 mb-1">My Open Offers</h2>
            <p className="text-xs text-slate-400 mb-3">Still waiting for a counterparty. They shrink as they match.</p>
            <div className="space-y-2">
              {mine.map(item => {
                const g = getType(item.giveType);
                const w = getType(item.wantType);
                return (
                  <div key={item.id} className="flex items-center justify-between py-1">
                    <div className="flex items-center gap-1.5">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${g.badge}`}>{g.short}</span>
                      <span className="text-xs text-slate-300">→</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${w.badge}`}>{w.short}</span>
                      <span className="text-sm font-medium text-slate-700">{item.qty} shift{item.qty>1?"s":""}</span>
                    </div>
                    <button onClick={()=>retract(item)} disabled={saving}
                      className="text-xs text-red-400 hover:text-red-600 px-3 py-1.5 rounded-lg hover:bg-red-50 disabled:opacity-40">
                      Retract
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Pending Pool */}
        <section className="bg-white rounded-2xl p-4 shadow-sm border border-slate-100">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-slate-700">
              {state.claimOpen ? "Still Looking for a Match" : "Offers on the Board"}
            </h2>
            <button onClick={async()=>{setSyncing(true);const d=await pull();if(d)setState(d);setSyncing(false);toast2("Synced ✓");}}
              disabled={syncing} className="text-xs text-slate-400 hover:text-slate-700 px-2 py-1 rounded-lg hover:bg-slate-100 disabled:opacity-40">
              {syncing?"…":"↻ Refresh"}
            </button>
          </div>

          {poolTotal === 0 ? (
            <p className="text-center text-slate-400 text-sm py-8">
              {state.claimOpen ? "Everything has matched — pool is clear 🎉" : "No offers yet"}
            </p>
          ) : (
            <>
              {/* Give vs want totals per type — shows where the imbalance is */}
              <div className="grid grid-cols-3 gap-2 mb-4">
                {TYPES.map(t => (
                  <div key={t.key} className={`${t.cardBg} rounded-xl p-3 text-center`}>
                    <p className={`text-xs ${t.cardText} opacity-75 mb-1`}>{t.label}</p>
                    <p className={`text-sm font-bold ${t.cardText}`}>{giveByType[t.key]} <span className="font-normal opacity-60">offered</span></p>
                    <p className={`text-sm font-bold ${t.cardText}`}>{wantByType[t.key]} <span className="font-normal opacity-60">wanted</span></p>
                  </div>
                ))}
              </div>
              <div className="h-px bg-slate-100 mb-3" />
              <div className="space-y-1.5">
                {[...(state.pool??[])].sort((a,b)=>a.at-b.at).map(item => {
                  const g = getType(item.giveType);
                  const w = getType(item.wantType);
                  const isMine = item.fromId === userId;
                  return (
                    <div key={item.id} className={`flex items-center justify-between text-xs py-1 px-2 rounded-lg ${isMine?"bg-slate-50":""}`}>
                      <span className={`truncate ${isMine?"font-semibold text-slate-700":"text-slate-500"}`}>{isMine?"You":item.fromName}</span>
                      <div className="flex items-center gap-1">
                        <span className={`px-1.5 py-0.5 rounded-full font-medium ${g.badge}`}>{item.qty} {g.short}</span>
                        <span className="text-slate-300">→</span>
                        <span className={`px-1.5 py-0.5 rounded-full font-medium ${w.badge}`}>{item.qty} {w.short}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
              {state.claimOpen && (
                <p className="text-xs text-slate-400 text-center mt-3">
                  Two-way and three-way swaps settle automatically — fully or partially — the moment a match exists.
                </p>
              )}
            </>
          )}
        </section>

        {/* Team Overview */}
        <section className="bg-white rounded-2xl p-4 shadow-sm border border-slate-100">
          <h2 className="text-sm font-semibold text-slate-700 mb-3">Team Overview</h2>
          <div className="text-xs">
            <div className="grid grid-cols-5 gap-1 text-slate-400 font-semibold pb-2 border-b border-slate-100">
              <span className="col-span-2">Physician</span>
              <span className="text-center text-sky-400">TS</span>
              <span className="text-center text-violet-400">TN</span>
              <span className="text-center text-emerald-500">CB</span>
            </div>
            {state.physicians.map(p => {
              const isMe = p.id === userId;
              return (
                <div key={p.id} className={`grid grid-cols-5 gap-1 py-1.5 border-b border-slate-50 ${isMe?"font-semibold":""}`}>
                  <span className={`col-span-2 truncate ${isMe?"text-sky-700":"text-slate-600"}`}>{isMe?"▸ ":""}{p.name}</span>
                  <span className={`text-center ${isMe?"text-sky-700 font-bold":"text-slate-500"}`}>{p.ts}</span>
                  <span className={`text-center ${isMe?"text-violet-700 font-bold":"text-slate-500"}`}>{p.tn}</span>
                  <span className={`text-center ${isMe?"text-emerald-700 font-bold":"text-slate-500"}`}>{p.ip}</span>
                </div>
              );
            })}
            <div className="grid grid-cols-5 gap-1 pt-2 mt-1 border-t border-slate-200 font-semibold text-slate-500">
              <span className="col-span-2">Totals</span>
              <span className="text-center text-sky-600">{state.physicians.reduce((s,p)=>s+p.ts,0)}</span>
              <span className="text-center text-violet-600">{state.physicians.reduce((s,p)=>s+p.tn,0)}</span>
              <span className="text-center text-emerald-600">{state.physicians.reduce((s,p)=>s+p.ip,0)}</span>
            </div>
          </div>
        </section>

      </div>

      {/* ── Admin Modal ── */}
      {modal && (
        <div className="fixed inset-0 z-50 flex items-end justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={closeModal} />
          <div className="relative w-full max-w-md bg-white rounded-t-2xl max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between px-4 py-4 border-b border-slate-100 flex-shrink-0">
              <div className="flex items-center gap-2">
                <span className="text-lg">{unlocked?"🔓":"🔒"}</span>
                <h2 className="font-bold text-slate-800">Admin Controls</h2>
                {unlocked && <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-medium">Unlocked</span>}
              </div>
              <button onClick={closeModal} className="w-8 h-8 rounded-full bg-slate-100 hover:bg-slate-200 flex items-center justify-center text-slate-500 text-sm">✕</button>
            </div>

            <div className="overflow-y-auto flex-1 px-4 py-4 space-y-3">

              {!unlocked && (
                <div className="flex flex-col items-center gap-4 py-4">
                  <div className="w-16 h-16 bg-slate-100 rounded-2xl flex items-center justify-center text-3xl">🔐</div>
                  <div className="text-center">
                    <p className="font-semibold text-slate-700">Admin access required</p>
                    <p className="text-xs text-slate-400 mt-1">Enter your PIN to unlock</p>
                  </div>
                  <div className="w-full max-w-xs space-y-3">
                    <input
                      type="password" inputMode="numeric" maxLength={8}
                      value={pin}
                      onChange={e=>{setPin(e.target.value.replace(/\D/g,"")); setPinErr(false);}}
                      onKeyDown={e=>e.key==="Enter"&&tryPin()}
                      placeholder="• • • •"
                      className={`w-full border-2 rounded-xl px-4 py-3 text-center text-2xl tracking-[0.4em] font-bold focus:outline-none transition-all ${pinErr?"border-red-400 bg-red-50 text-red-500":"border-slate-200 focus:border-sky-400"}`}
                    />
                    {pinErr && <p className="text-xs text-red-500 text-center font-medium">Incorrect PIN</p>}
                    <button onClick={tryPin} className="w-full py-3 bg-sky-600 hover:bg-sky-700 text-white rounded-xl font-semibold text-sm">
                      Unlock
                    </button>
                  </div>
                </div>
              )}

              {unlocked && (
                <>
                  <button onClick={lockAdmin}
                    className="w-full py-2.5 rounded-xl text-xs font-semibold bg-amber-50 text-amber-700 hover:bg-amber-100">
                    🔒 Lock Admin Panel
                  </button>

                  <div className="h-px bg-slate-100" />

                  {/* Round controls */}
                  {!state.exchangeOpen && (
                    <button onClick={()=>push({...state, exchangeOpen:true, claimOpen:false})} disabled={saving}
                      className="w-full py-3 rounded-xl text-sm font-semibold bg-amber-50 text-amber-700 hover:bg-amber-100">
                      🔓 Open Exchange — Round 1 (Collect Offers)
                    </button>
                  )}
                  {state.exchangeOpen && !state.claimOpen && (
                    <button onClick={()=>push(resolveMatches({...state, claimOpen:true}))} disabled={saving}
                      className="w-full py-3 rounded-xl text-sm font-semibold bg-green-50 text-green-700 hover:bg-green-100">
                      ✅ Open Round 2 — Run Matching
                    </button>
                  )}
                  {state.exchangeOpen && state.claimOpen && (
                    <div className="space-y-2">
                      <button onClick={()=>push(resolveMatches(state))} disabled={saving}
                        className="w-full py-3 rounded-xl text-sm font-semibold bg-green-50 text-green-700 hover:bg-green-100">
                        🔁 Re-run Matching Now
                      </button>
                      <button onClick={()=>push({...state, claimOpen:false})} disabled={saving}
                        className="w-full py-2.5 rounded-xl text-xs font-semibold bg-slate-50 text-slate-500 hover:bg-slate-100">
                        ⏸ Back to Round 1 (pause matching)
                      </button>
                    </div>
                  )}
                  {state.exchangeOpen && (
                    <div className="space-y-2">
                      {poolTotal > 0 && (
                        <p className="text-xs text-slate-400 text-center">
                          {poolTotal} unmatched shift{poolTotal>1?"s":""} will be cancelled (no shifts move)
                        </p>
                      )}
                      <button onClick={()=>push({...state, pool:[], exchangeOpen:false, claimOpen:false})} disabled={saving}
                        className="w-full py-3 rounded-xl text-sm font-semibold bg-red-50 text-red-600 hover:bg-red-100">
                        🔒 Close Exchange &amp; Clear Pool
                      </button>
                    </div>
                  )}

                  {panel !== "names" ? (
                    <button onClick={()=>{setTmpNames(state.physicians.map(p=>p.name));setPanel("names");}}
                      className="w-full py-3 rounded-xl text-sm font-semibold bg-slate-50 text-slate-600 hover:bg-slate-100">
                      ✏️ Edit Physician Names
                    </button>
                  ) : (
                    <div className="bg-slate-50 rounded-xl p-3 space-y-2">
                      <p className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Edit names</p>
                      {state.physicians.map((p,i) => (
                        <input key={p.id} value={tmpNames[i]??p.name}
                          onChange={e=>setTmpNames(n=>{const a=[...n];a[i]=e.target.value;return a;})}
                          className="w-full border border-slate-200 bg-white rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-300"
                          placeholder={`Physician ${i+1}`} />
                      ))}
                      <div className="flex gap-2 pt-1">
                        <button onClick={saveNames} disabled={saving} className="flex-1 py-2.5 bg-sky-600 text-white rounded-xl text-sm font-semibold disabled:opacity-40">Save</button>
                        <button onClick={()=>setPanel(null)} className="flex-1 py-2.5 bg-white border border-slate-200 text-slate-600 rounded-xl text-sm font-semibold">Cancel</button>
                      </div>
                    </div>
                  )}

                  {panel !== "alloc" ? (
                    <button onClick={()=>{setAllocDraft(state.physicians.map(p=>({...p})));setPanel("alloc");}}
                      className="w-full py-3 rounded-xl text-sm font-semibold bg-slate-50 text-slate-600 hover:bg-slate-100">
                      🔢 Edit Shift Allocations
                    </button>
                  ) : (
                    <div className="bg-slate-50 rounded-xl p-3 space-y-2">
                      <p className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Counts — pool clears on save</p>
                      <p className="text-[11px] text-slate-400 leading-snug">Row (Σ) and column totals should stay the same. Anything that drifts turns red — you can still save to override.</p>
                      <div className="grid grid-cols-[1fr_2rem_2rem_2rem_2rem] gap-1 text-xs text-slate-400 font-semibold">
                        <span>Name</span><span className="text-center">TS</span><span className="text-center">TN</span><span className="text-center">CB</span><span className="text-center">Σ</span>
                      </div>
                      {allocDraft.map((p,i) => {
                        const rowTot  = p.ts+p.tn+p.ip;
                        const baseTot = state.physicians[i] ? state.physicians[i].ts+state.physicians[i].tn+state.physicians[i].ip : rowTot;
                        const off = rowTot !== baseTot;
                        return (
                          <div key={p.id} className="grid grid-cols-[1fr_2rem_2rem_2rem_2rem] gap-1 items-center">
                            <span className="text-xs text-slate-600 truncate">{p.name}</span>
                            {["ts","tn","ip"].map(k => (
                              <input key={k} type="number" min="0" max="99" value={allocDraft[i][k]}
                                onChange={e=>setAllocDraft(d=>{const a=[...d];a[i]={...a[i],[k]:Number(e.target.value)||0};return a;})}
                                className="border border-slate-200 bg-white rounded-lg px-1 py-1.5 text-xs text-center focus:outline-none focus:ring-2 focus:ring-sky-300" />
                            ))}
                            <span title={off?`Was ${baseTot}`:""} className={`text-center text-xs font-bold ${off?"text-red-500":"text-slate-400"}`}>{rowTot}</span>
                          </div>
                        );
                      })}
                      <div className="grid grid-cols-[1fr_2rem_2rem_2rem_2rem] gap-1 items-center pt-1.5 border-t border-slate-200">
                        <span className="text-xs text-slate-400 font-semibold">Totals</span>
                        {["ts","tn","ip"].map(k => {
                          const cur  = allocDraft.reduce((s,p)=>s+p[k],0);
                          const base = state.physicians.reduce((s,p)=>s+p[k],0);
                          const off  = cur !== base;
                          return <span key={k} title={off?`Was ${base}`:""} className={`text-center text-xs font-bold ${off?"text-red-500":"text-slate-500"}`}>{cur}</span>;
                        })}
                        <span className="text-center text-xs font-bold text-slate-500">{allocDraft.reduce((s,p)=>s+p.ts+p.tn+p.ip,0)}</span>
                      </div>
                      {(() => {
                        const rowsOff = allocDraft.filter((p,i)=> state.physicians[i] && (p.ts+p.tn+p.ip)!==(state.physicians[i].ts+state.physicians[i].tn+state.physicians[i].ip)).length;
                        const colsOff = ["ts","tn","ip"].filter(k => allocDraft.reduce((s,p)=>s+p[k],0)!==state.physicians.reduce((s,p)=>s+p[k],0));
                        if (!rowsOff && !colsOff.length) return null;
                        return (
                          <div className="bg-red-50 border border-red-200 rounded-lg p-2 text-[11px] text-red-600 leading-snug">
                            ⚠️ Totals differ from the current allocation
                            {rowsOff>0 && <> · {rowsOff} row{rowsOff>1?"s":""}</>}
                            {colsOff.length>0 && <> · column{colsOff.length>1?"s":""} {colsOff.map(k=>getType(k).short).join(", ")}</>}
                            . Saving will override.
                          </div>
                        );
                      })()}
                      <div className="flex gap-2">
                        <button onClick={saveAlloc} disabled={saving} className="flex-1 py-2.5 bg-sky-600 text-white rounded-xl text-sm font-semibold disabled:opacity-40">Save</button>
                        <button onClick={()=>setPanel(null)} className="flex-1 py-2.5 bg-white border border-slate-200 text-slate-600 rounded-xl text-sm font-semibold">Cancel</button>
                      </div>
                    </div>
                  )}

                  {panel !== "changepin" ? (
                    <button onClick={()=>setPanel("changepin")}
                      className="w-full py-3 rounded-xl text-sm font-semibold bg-slate-50 text-slate-600 hover:bg-slate-100">
                      🔑 Change Admin PIN
                    </button>
                  ) : (
                    <div className="bg-slate-50 rounded-xl p-3 space-y-2">
                      <p className="text-xs text-slate-500 font-semibold uppercase tracking-wide">New PIN (digits, min 4)</p>
                      <input type="password" inputMode="numeric" maxLength={8} value={newPin}
                        onChange={e=>setNewPin(e.target.value.replace(/\D/g,""))} placeholder="New PIN"
                        className="w-full border border-slate-200 bg-white rounded-lg px-3 py-2 text-sm text-center tracking-widest font-bold focus:outline-none focus:ring-2 focus:ring-sky-300" />
                      <input type="password" inputMode="numeric" maxLength={8} value={confPin}
                        onChange={e=>setConfPin(e.target.value.replace(/\D/g,""))} placeholder="Confirm PIN"
                        className="w-full border border-slate-200 bg-white rounded-lg px-3 py-2 text-sm text-center tracking-widest font-bold focus:outline-none focus:ring-2 focus:ring-sky-300" />
                      <div className="flex gap-2 pt-1">
                        <button onClick={savePin} disabled={saving} className="flex-1 py-2.5 bg-sky-600 text-white rounded-xl text-sm font-semibold disabled:opacity-40">Save PIN</button>
                        <button onClick={()=>{setPanel(null);setNewPin("");setConfPin("");}} className="flex-1 py-2.5 bg-white border border-slate-200 text-slate-600 rounded-xl text-sm font-semibold">Cancel</button>
                      </div>
                    </div>
                  )}

                  <button onClick={resetAll} disabled={saving}
                    className="w-full py-3 rounded-xl text-sm font-semibold bg-red-50 text-red-500 hover:bg-red-100">
                    ↺ Full Reset to Initial Allocations
                  </button>

                  <p className="text-xs text-slate-400 text-center pb-2">All changes are shared with the team</p>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-6 inset-x-4 max-w-sm mx-auto py-3 px-5 rounded-2xl shadow-xl text-white text-sm font-medium text-center z-50 ${toast.type==="err"?"bg-red-500":"bg-slate-800"}`}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
