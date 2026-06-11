import { useState, useEffect } from "react";
import { ref, get, set } from "firebase/database";
import { db } from "./firebase.js";

const DEFAULT_PIN = "0000";

const TYPES = [
  { key:"ts", label:"Telestroke", short:"TS", cardBg:"bg-sky-50",     cardText:"text-sky-700",     badge:"bg-sky-100 text-sky-700",        btn:"bg-sky-600 hover:bg-sky-700"      },
  { key:"tn", label:"Teleneuro",  short:"TN", cardBg:"bg-violet-50",  cardText:"text-violet-700",  badge:"bg-violet-100 text-violet-700",  btn:"bg-violet-600 hover:bg-violet-700" },
  { key:"ip", label:"In-Person",  short:"IP", cardBg:"bg-emerald-50", cardText:"text-emerald-700", badge:"bg-emerald-100 text-emerald-700", btn:"bg-emerald-600 hover:bg-emerald-700"},
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

function fresh(names = NAMES) {
  return {
    physicians: names.map((name,i) => ({ id:i+1, name, ts:i<4?5:4, tn:13, ip:i<4?8:9 })),
    pool: [],
    exchangeOpen: true,
    claimOpen: false,
    claimLimit: 2,
    claimedCounts: {},
    offeredCounts: {},
    adminPin: DEFAULT_PIN,
  };
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
  const [draftLimit,         setDraftLimit]         = useState("2");
  const [selectedClaimType,  setSelectedClaimType]  = useState(null);
  const [selectedClaimQty,   setSelectedClaimQty]   = useState(1);

  // ── Storage ──────────────────────────────────────────────
  const pull = async () => {
    try {
      const snapshot = await get(ref(db, "appstate"));
      if (!snapshot.exists()) return null;
      const d = snapshot.val();
      // Firebase drops empty arrays; normalize pool back to array
      return { ...d, pool: d.pool ? Object.values(d.pool) : [], claimOpen: d.claimOpen ?? false, claimLimit: d.claimLimit ?? 2, claimedCounts: d.claimedCounts ?? {}, offeredCounts: d.offeredCounts ?? {} };
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
  const me  = state?.physicians.find(p => p.id === userId);
  const mine = (state?.pool??[]).filter(p => p.fromId === userId);
  const pool = (state?.pool??[]).filter(p => p.fromId !== userId);

  // ── Shift actions ────────────────────────────────────────
  const offer = async () => {
    const qty = Number(ofQty);
    if (!me || qty < 1) return;
    if (me[ofType] < qty) return toast2(`Only ${me[ofType]} ${getType(ofType).label} left`,"err");
    const ok = await push({
      ...state,
      physicians: state.physicians.map(p => p.id===me.id ? {...p,[ofType]:p[ofType]-qty} : p),
      pool: [...(state.pool??[]), {id:`${Date.now()}-${Math.random().toString(36).slice(2)}`, fromId:me.id, fromName:me.name, type:ofType, wantType, qty, at:Date.now()}],
      offeredCounts: { ...(state.offeredCounts??{}), [me.id]: (state.offeredCounts?.[me.id]??0) + qty },
    });
    if (ok) { toast2(`Offered ${qty}× ${getType(ofType).label}`); setOfQty(1); }
  };

  const retract = async item => {
    const ok = await push({
      ...state,
      physicians: state.physicians.map(p => p.id===me.id ? {...p,[item.type]:p[item.type]+item.qty} : p),
      pool: (state.pool??[]).filter(p => p.id!==item.id),
      offeredCounts: { ...(state.offeredCounts??{}), [me.id]: Math.max(0,(state.offeredCounts?.[me.id]??0) - item.qty) },
    });
    if (ok) toast2("Offer retracted");
  };

  const claimByType = async (type, qty) => {
    const myOffered = state.offeredCounts?.[me.id] ?? 0;
    const myClaimed = state.claimedCounts?.[me.id] ?? 0;
    if (qty > myOffered - myClaimed)
      return toast2("Offer shifts first — you can only claim as many as you've offered","err");
    if (state.claimLimit > 0 && myClaimed + qty > state.claimLimit)
      return toast2(`Limit reached — max ${state.claimLimit} shifts in Round 2`,"err");
    // Consume pool items of this type FIFO (oldest first), skipping own offers
    const available = (state.pool??[])
      .filter(p => p.type === type && p.fromId !== me.id)
      .sort((a, b) => a.at - b.at);
    let remaining = qty;
    let newPool = [...(state.pool??[])];
    for (const item of available) {
      if (remaining <= 0) break;
      if (item.qty <= remaining) {
        newPool = newPool.filter(p => p.id !== item.id);
        remaining -= item.qty;
      } else {
        newPool = newPool.map(p => p.id === item.id ? {...p, qty: p.qty - remaining} : p);
        remaining = 0;
      }
    }
    if (remaining > 0) return toast2(`Only ${qty - remaining} ${getType(type).label} available`,"err");
    const ok = await push({
      ...state,
      physicians: state.physicians.map(p => p.id===me.id ? {...p,[type]:p[type]+qty} : p),
      pool: newPool,
      claimedCounts: { ...(state.claimedCounts??{}), [me.id]: myClaimed + qty },
    });
    if (ok) {
      setSelectedClaimType(null);
      setSelectedClaimQty(1);
      toast2(`Claimed ${qty}× ${getType(type).label}`);
    }
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
    ? { label: "Closed",                                        bg: "bg-red-100",    text: "text-red-600",    dot: "bg-red-500",    pulse: false }
    : !state.claimOpen
    ? { label: "Round 1 — Offers Only",                         bg: "bg-amber-100",  text: "text-amber-700",  dot: "bg-amber-400",  pulse: true  }
    : state.claimLimit > 0
    ? { label: `Round 2 — Max ${state.claimLimit} per person`,  bg: "bg-green-100",  text: "text-green-700",  dot: "bg-green-500",  pulse: true  }
    : { label: "Round 3 — Unrestricted",                        bg: "bg-violet-100", text: "text-violet-700", dot: "bg-violet-500", pulse: true  };

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

  // Even-exchange balance
  const myOffered     = state.offeredCounts?.[me.id] ?? 0;
  const myClaimed     = state.claimedCounts?.[me.id] ?? 0;
  const offerBalance  = myOffered - myClaimed;
  const adminRem      = state.claimOpen && state.claimLimit > 0
                          ? state.claimLimit - myClaimed : Infinity;
  const claimableLeft = Math.min(offerBalance, adminRem);

  // Pool totals by type (excluding own offers)
  const poolByType = Object.fromEntries(TYPES.map(t => [
    t.key, (state.pool??[]).filter(p => p.type===t.key && p.fromId!==me.id).reduce((s,p)=>s+p.qty,0)
  ]));
  // My outstanding offers by type
  const myOffersByType = Object.fromEntries(TYPES.map(t => [
    t.key, (state.pool??[]).filter(p => p.type===t.key && p.fromId===me.id).reduce((s,p)=>s+p.qty,0)
  ]));
  // Selected claim helpers
  const selT          = selectedClaimType ? getType(selectedClaimType) : null;
  const maxForSelType = selectedClaimType ? Math.min(poolByType[selectedClaimType], claimableLeft) : 0;
  const safeCqty      = Math.min(selectedClaimQty, maxForSelType);

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
              {!state.exchangeOpen ? "Closed" : !state.claimOpen ? "Round 1" : state.claimLimit > 0 ? "Round 2" : "Round 3"}
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
            <h2 className="text-sm font-semibold text-slate-700 mb-3">Offer Shifts</h2>
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
                <button key={t.key} onClick={()=>setWantType(t.key)}
                  className={`py-2.5 rounded-xl text-sm font-medium transition-all ${wantType===t.key?`${t.btn} text-white shadow-sm`:"bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>
                  {t.label}
                </button>
              ))}
            </div>
            <div className="flex gap-2 items-center">
              <div className="flex-1 flex items-center bg-slate-100 rounded-xl overflow-hidden">
                <button onClick={()=>setOfQty(q=>Math.max(1,q-1))} className="px-5 py-3 text-slate-700 text-xl font-bold hover:bg-slate-200 select-none">−</button>
                <span className="flex-1 text-center text-lg font-bold text-slate-800 select-none">{ofQty}</span>
                <button onClick={()=>setOfQty(q=>Math.min(me[ofType],q+1))} className="px-5 py-3 text-slate-700 text-xl font-bold hover:bg-slate-200 select-none">+</button>
              </div>
              <button onClick={offer} disabled={saving||me[ofType]===0}
                className={`${ofT.btn} text-white px-5 py-3 rounded-xl font-semibold text-sm disabled:opacity-40 shadow-sm`}>
                {saving?"…":"Offer"}
              </button>
            </div>
            <p className="text-xs text-center text-slate-400 mt-2">
              Offering <span className={`font-semibold ${ofT.cardText}`}>{ofQty}× {ofT.label}</span>
              {" · "}wants <span className={`font-semibold ${getType(wantType).cardText}`}>{ofQty}× {getType(wantType).label}</span>
            </p>
          </section>
        )}

        {/* My Active Offers */}
        {mine.length > 0 && (
          <section className="bg-white rounded-2xl p-4 shadow-sm border border-slate-100">
            <h2 className="text-sm font-semibold text-slate-700 mb-3">My Active Offers</h2>
            <div className="space-y-2">
              {mine.map(item => {
                const t = getType(item.type);
                return (
                  <div key={item.id} className="flex items-center justify-between py-1">
                    <div className="flex items-center gap-1.5">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${t.badge}`}>{t.short}</span>
                      <span className="text-xs text-slate-300">→</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${getType(item.wantType??item.type).badge}`}>{getType(item.wantType??item.type).short}</span>
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

        {/* Available to Claim */}
        <section className="bg-white rounded-2xl p-4 shadow-sm border border-slate-100">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-sm font-semibold text-slate-700">Available to Claim</h2>
              {state.claimOpen && (
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${claimableLeft > 0 ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-400"}`}>
                  {claimableLeft > 0 ? `${claimableLeft} left to claim` : myOffered === 0 ? "offer shifts to unlock" : "limit reached"}
                </span>
              )}
            </div>
            <button onClick={async()=>{setSyncing(true);const d=await pull();if(d)setState(d);setSyncing(false);toast2("Synced ✓");}}
              disabled={syncing} className="text-xs text-slate-400 hover:text-slate-700 px-2 py-1 rounded-lg hover:bg-slate-100 disabled:opacity-40">
              {syncing?"…":"↻ Refresh"}
            </button>
          </div>

          {!state.claimOpen ? (
            <p className="text-center text-slate-400 text-sm py-8">
              {!state.exchangeOpen
                ? "Exchange is currently closed"
                : "Round 1 — admin will open claiming once offers are reviewed"}
            </p>
          ) : (
            <>
              {/* Grab — pool totals by type */}
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Grab</p>
              <div className="grid grid-cols-3 gap-2 mb-3">
                {TYPES.map(t => {
                  const avail = poolByType[t.key];
                  const sel = selectedClaimType === t.key;
                  const canPick = Math.min(avail, claimableLeft) > 0;
                  return (
                    <button key={t.key}
                      onClick={()=>{ setSelectedClaimType(sel ? null : t.key); setSelectedClaimQty(1); }}
                      disabled={!canPick}
                      className={`rounded-xl p-3 text-center transition-all disabled:opacity-35 ${sel ? `${t.btn} text-white shadow-md scale-[1.03]` : `${t.cardBg} hover:opacity-80`}`}>
                      <p className={`text-3xl font-bold ${sel ? "text-white" : t.cardText}`}>{avail}</p>
                      <p className={`text-xs mt-1 ${sel ? "text-white/80" : t.cardText + " opacity-75"}`}>{t.label}</p>
                    </button>
                  );
                })}
              </div>

              {/* Qty stepper + claim (visible when a type is selected) */}
              {selT && (
                <div className="flex gap-2 items-center mb-4">
                  <div className="flex-1 flex items-center bg-slate-100 rounded-xl overflow-hidden">
                    <button onClick={()=>setSelectedClaimQty(q=>Math.max(1,q-1))} className="px-5 py-3 text-slate-700 text-xl font-bold hover:bg-slate-200 select-none">−</button>
                    <span className="flex-1 text-center text-lg font-bold text-slate-800 select-none">{safeCqty}</span>
                    <button onClick={()=>setSelectedClaimQty(q=>Math.min(maxForSelType,q+1))} className="px-5 py-3 text-slate-700 text-xl font-bold hover:bg-slate-200 select-none">+</button>
                  </div>
                  <button onClick={()=>claimByType(selectedClaimType, safeCqty)} disabled={saving}
                    className={`${selT.btn} text-white px-5 py-3 rounded-xl font-semibold text-sm disabled:opacity-40 shadow-sm`}>
                    {saving ? "…" : "Claim"}
                  </button>
                </div>
              )}

              {/* My offers (offset) */}
              {myOffered > 0 && (
                <>
                  <div className="h-px bg-slate-100 mb-3" />
                  <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">My Offers</p>
                  <div className="grid grid-cols-3 gap-2">
                    {TYPES.map(t => (
                      <div key={t.key} className={`${t.cardBg} rounded-xl p-3 text-center ${myOffersByType[t.key]===0?"opacity-30":""}`}>
                        <p className={`text-3xl font-bold ${t.cardText}`}>{myOffersByType[t.key]}</p>
                        <p className={`text-xs mt-1 ${t.cardText} opacity-75`}>{t.label}</p>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {Object.values(poolByType).every(v=>v===0) && (
                <p className="text-center text-slate-400 text-sm py-4">
                  {state.claimLimit > 0 ? "Nothing available right now" : "All shifts have been claimed"}
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
              <span className="text-center text-emerald-500">IP</span>
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
                    <button onClick={()=>push({...state, exchangeOpen:true, claimOpen:false, claimedCounts:{}, offeredCounts:{}})} disabled={saving}
                      className="w-full py-3 rounded-xl text-sm font-semibold bg-amber-50 text-amber-700 hover:bg-amber-100">
                      🔓 Open Exchange — Round 1 (Offers Only)
                    </button>
                  )}
                  {state.exchangeOpen && !state.claimOpen && (
                    <div className="bg-slate-50 rounded-xl p-3 space-y-2">
                      <p className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Round 2 claim limit</p>
                      <div className="flex items-center gap-3">
                        <input type="number" min="1" max="99" value={draftLimit}
                          onChange={e=>setDraftLimit(e.target.value)}
                          onBlur={()=>setDraftLimit(v => String(Math.max(1, parseInt(v)||1)))}
                          className="w-20 border border-slate-200 bg-white rounded-lg px-3 py-2 text-sm text-center font-bold focus:outline-none focus:ring-2 focus:ring-sky-300" />
                        <span className="text-xs text-slate-500">max shifts per person</span>
                      </div>
                      <button onClick={()=>push({...state, claimOpen:true, claimLimit:Math.max(1,parseInt(draftLimit)||1), claimedCounts:{}})} disabled={saving}
                        className="w-full py-2.5 rounded-xl text-sm font-semibold bg-green-50 text-green-700 hover:bg-green-100">
                        ✅ Open Claiming — Round 2 (limit: {Math.max(1,parseInt(draftLimit)||1)})
                      </button>
                    </div>
                  )}
                  {state.exchangeOpen && state.claimOpen && state.claimLimit > 0 && (
                    <button onClick={()=>push({...state, claimLimit:0, claimedCounts:{}})} disabled={saving}
                      className="w-full py-3 rounded-xl text-sm font-semibold bg-violet-50 text-violet-700 hover:bg-violet-100">
                      🔄 Open Round 3 — Unrestricted Cleanup
                    </button>
                  )}
                  {state.exchangeOpen && (
                    <button onClick={()=>push({...state, exchangeOpen:false, claimOpen:false, claimedCounts:{}, offeredCounts:{}})} disabled={saving}
                      className="w-full py-3 rounded-xl text-sm font-semibold bg-red-50 text-red-600 hover:bg-red-100">
                      🔒 Close Exchange
                    </button>
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
                      <div className="grid grid-cols-4 gap-1 text-xs text-slate-400 font-semibold">
                        <span>Name</span><span className="text-center">TS</span><span className="text-center">TN</span><span className="text-center">IP</span>
                      </div>
                      {allocDraft.map((p,i) => (
                        <div key={p.id} className="grid grid-cols-4 gap-1 items-center">
                          <span className="text-xs text-slate-600 truncate">{p.name}</span>
                          {["ts","tn","ip"].map(k => (
                            <input key={k} type="number" min="0" max="99" value={allocDraft[i][k]}
                              onChange={e=>setAllocDraft(d=>{const a=[...d];a[i]={...a[i],[k]:Number(e.target.value)||0};return a;})}
                              className="border border-slate-200 bg-white rounded-lg px-1 py-1.5 text-xs text-center focus:outline-none focus:ring-2 focus:ring-sky-300" />
                          ))}
                        </div>
                      ))}
                      <p className="text-xs text-slate-400 text-right pt-1">
                        TS:{allocDraft.reduce((s,p)=>s+p.ts,0)} · TN:{allocDraft.reduce((s,p)=>s+p.tn,0)} · IP:{allocDraft.reduce((s,p)=>s+p.ip,0)}
                      </p>
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
