import React, { useCallback, useMemo, useRef, useState } from "react";
import Papa from "papaparse";
import * as htmlToImage from "html-to-image";
import {
  LineChart, Line,
  BarChart, Bar,
  AreaChart, Area,
  ScatterChart, Scatter,
  XAxis, YAxis, Tooltip, CartesianGrid,
  ResponsiveContainer, Legend, Brush
} from "recharts";

// ---- Optional LLM (WebLLM) ----
let WebLLMEngine = null; // lazy-loaded engine

/** ==========================
 *  Helpers & Styling
 *  ========================== */

// Palettes
const PALETTES = {
  Breeze: ["#2563eb","#16a34a","#d946ef","#f97316","#22c55e","#ef4444","#0ea5e9","#a855f7","#f59e0b","#10b981"],
  Midnight: ["#60a5fa","#34d399","#f472b6","#fbbf24","#fca5a5","#93c5fd","#a7f3d0","#c4b5fd","#fde68a","#6ee7b7"],
  Warm: ["#b91c1c","#c2410c","#b45309","#a16207","#15803d","#0e7490","#7c3aed","#9d174d","#3f6212","#1e3a8a"],
  Cool: ["#0891b2","#0ea5e9","#38bdf8","#22c55e","#10b981","#84cc16","#a3e635","#06b6d4","#6366f1","#14b8a6"],
};
const paletteNames = Object.keys(PALETTES);
const colorFor = (palette, i) => PALETTES[palette][i % PALETTES[palette].length];

// Date parsing
const tryParseDate = (v) => {
  if (typeof v === "string") {
    const parts = v.trim().split(/[T\s]/)[0];
    if (parts.includes("/")) {
      const [a,b,c] = parts.split("/").map(Number);
      if (String(c).length === 4) { // DD/MM/YYYY
        const dt = new Date(c, (b||1)-1, a||1);
        if (!isNaN(dt.getTime())) return dt;
      }
      const dt2 = new Date(c, (a||1)-1, b||1); // MM/DD/YYYY
      if (!isNaN(dt2.getTime())) return dt2;
    }
    if (parts.includes("-")) {
      const dt = new Date(parts);
      if (!isNaN(dt.getTime())) return dt;
    }
  }
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
};

// Quantiles
const quantile = (arr, p) => {
  if (!arr.length) return null;
  const a = [...arr].sort((x,y)=>x-y);
  const idx = (a.length-1)*p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo===hi) return a[lo];
  return a[lo] + (a[hi]-a[lo])*(idx-lo);
};

const detectType = (values) => {
  let num=0, date=0, nonEmpty=0;
  for (let v of values.slice(0,300)) {
    if (v===undefined || v===null || String(v).trim()==="") continue;
    nonEmpty++;
    if (!isNaN(Number(v))) num++;
    if (tryParseDate(v)) date++;
  }
  if (date > nonEmpty*0.6) return "date";
  if (num  > nonEmpty*0.6) return "numeric";
  return "categorical";
};

const summarize = (rows, key, type) => {
  const vals = rows.map(r=>r[key]).filter(v=>v!==undefined && v!==null && String(v).trim()!=="");
  const missing = rows.length - vals.length;
  if (type==="numeric") {
    const nums = vals.map(Number).filter(v=>!isNaN(v));
    const n = nums.length;
    if (!n) return {count:0, missing, mean:null, min:null, max:null};
    const sum = nums.reduce((a,b)=>a+b,0);
    return {count:n, missing, mean:sum/n, min:Math.min(...nums), max:Math.max(...nums)};
  } else if (type==="categorical") {
    const freq = {};
    for (let v of vals) freq[v]=(freq[v]||0)+1;
    return {count:vals.length, missing, top:Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,8)};
  }
  const dates = vals.map(tryParseDate).filter(Boolean).sort((a,b)=>a-b);
  return {count:vals.length, missing, min:dates[0]||null, max:dates[dates.length-1]||null};
};

const groupBy = (arr, keyFn) => {
  const m = new Map();
  for (let item of arr) {
    const k = keyFn(item);
    m.set(k, (m.get(k)||[]).concat(item));
  }
  return m;
};

const formatDateKey = (d, g) => {
  const y=d.getFullYear(); const m=String(d.getMonth()+1).padStart(2,"0"); const da=String(d.getDate()).padStart(2,"0");
  if (g==="year") return `${y}`;
  if (g==="month") return `${y}-${m}`;
  return `${y}-${m}-${da}`;
};

const suggestViz = (cols, types) => {
  const dates = cols.filter(c=>types[c]==="date");
  const nums  = cols.filter(c=>types[c]==="numeric");
  const cats  = cols.filter(c=>types[c]==="categorical");
  if (dates.length && nums.length) return {x:dates[0], y:nums[0], split:cats[0]||"", chart:"line"};
  if (cats.length && nums.length) return {x:cats[0], y:nums[0], split:"", chart:"bar"};
  if (nums.length>=2) return {x:nums[0], y:nums[1], split:"", chart:"scatter"};
  return {x:dates[0]||cats[0]||"", y:"", split:"", chart:"line"};
};

/** ==========================
 *  Component
 *  ========================== */
export default function App() {
  // data
  const [rows, setRows] = useState([]);
  const [columns, setColumns] = useState([]);
  const [types, setTypes] = useState({});

  // roles
  const [xCol, setX] = useState("");
  const [y1Col, setY1] = useState("");
  const [y2Col, setY2] = useState(""); // second measure
  const [splitCol, setSplit] = useState("");

  // options
  const [granularity, setGran] = useState("month");
  const [dateRange, setRange] = useState({start:"", end:""});
  const [chart, setChart] = useState("line"); // line | bar | area | scatter
  const [agg1, setAgg1] = useState("sum");
  const [agg2, setAgg2] = useState("avg");
  const [y1Scale, setY1Scale] = useState("linear");
  const [y2Scale, setY2Scale] = useState("linear");
  const [barMode, setBarMode] = useState("grouped"); // grouped | stacked | percent
  const [topK, setTopK] = useState(6);
  const [palette, setPalette] = useState(paletteNames[0]);

  // filters (simple builder: multiple rules)
  const [rules, setRules] = useState([]); // [{col, kind:'cat'|'num', mode:'include'|'exclude', values:Set, min,max}]
  const addRule = () => setRules(r=>[...r, {id:crypto.randomUUID(), col:"", kind:"cat", mode:"include", values:new Set(), min:null, max:null}]);
  const removeRule = (id) => setRules(r=>r.filter(x=>x.id!==id));
  const updateRule = (id, partial) => setRules(r=>r.map(x=>x.id===id? {...x, ...partial}:x));

  // LLM
  const [llmLoading, setLlmLoading] = useState(false);
  const [llmReady, setLlmReady] = useState(false);
  const [llmReply, setLlmReply] = useState("");

  const chartRef = useRef(null);

  /** ---------- CSV load ---------- */
  const onCSV = useCallback((file) => {
    Papa.parse(file, {
      header: true, skipEmptyLines: true,
      complete: (res) => {
        const data = res.data;
        const cols = res.meta.fields || Object.keys(data[0]||{});
        const t = {};
        cols.forEach(c => t[c]=detectType(data.map(r=>r[c])));
        setRows(data); setColumns(cols); setTypes(t);

        const s = suggestViz(cols, t);
        setX(s.x); setY1(s.y); setSplit(s.split); setChart(s.chart); setY2("");
        if (s.x && t[s.x]==="date") {
          const dates = data.map(r=>tryParseDate(r[s.x])).filter(Boolean).sort((a,b)=>a-b);
          if (dates.length) setRange({start:dates[0].toISOString().slice(0,10), end:dates.at(-1).toISOString().slice(0,10)});
          else setRange({start:"",end:""});
        } else setRange({start:"",end:""});
      }
    });
  }, []);

  /** ---------- filtering ---------- */
  const baseFiltered = useMemo(() => {
    if (!rows.length) return [];
    let out = [...rows];

    // time window if X is date
    if (xCol && types[xCol]==="date" && dateRange.start && dateRange.end) {
      const s = new Date(dateRange.start), e = new Date(dateRange.end);
      out = out.filter(r => {
        const d = tryParseDate(r[xCol]);
        return d && d>=s && d<=e;
      });
    }

    // apply rules
    for (let rule of rules) {
      if (!rule.col) continue;
      const kind = types[rule.col]==="numeric" ? "num" : "cat";
      if (kind==="cat") {
        const set = rule.values || new Set();
        if (set.size===0) continue;
        if (rule.mode==="include") out = out.filter(r => set.has(String(r[rule.col])));
        else out = out.filter(r => !set.has(String(r[rule.col])));
      } else {
        const min = rule.min ?? -Infinity; const max = rule.max ?? Infinity;
        out = out.filter(r => {
          const v = Number(r[rule.col]); if (isNaN(v)) return false;
          return v>=min && v<=max;
        });
      }
    }

    return out;
  }, [rows, xCol, types, dateRange.start, dateRange.end, rules]);

  /** ---------- aggregation ---------- */
  const { data, seriesKeys, y2Enabled } = useMemo(() => {
    if (!baseFiltered.length || !xCol) return {data:[], seriesKeys:[], y2Enabled:false};

    const isXDate = types[xCol]==="date";
    const toKey = (r) => {
      if (!isXDate) return String(r[xCol]);
      const d = tryParseDate(r[xCol]); if (!d) return null;
      return formatDateKey(d, granularity);
    };

    const grouped = groupBy(baseFiltered.filter(r=>toKey(r)!==null), toKey);

    const catsAll = splitCol ? Array.from(new Set(baseFiltered.map(r=>String(r[splitCol])))) : [];
    const cats = splitCol ? catsAll.slice(0, Math.max(1, topK)) : [];

    const isY1 = types[y1Col]==="numeric";
    const isY2 = types[y2Col]==="numeric";
    const y2Ok = isY2 && !splitCol; // we disable Y2 when Split is active

    const aggFn = (arr, key, mode) => {
      if (!key || types[key]!=="numeric") return arr.length;
      const ns = arr.map(a=>Number(a[key])).filter(v=>!isNaN(v));
      if (!ns.length) return 0;
      if (mode==="sum") return ns.reduce((a,b)=>a+b,0);
      if (mode==="avg") return ns.reduce((a,b)=>a+b,0)/ns.length;
      if (mode==="min") return Math.min(...ns);
      if (mode==="max") return Math.max(...ns);
      return ns.length;
    };

    const result = [];

    if (splitCol) {
      for (let [k, arr] of grouped.entries()) {
        const item = { x:k };
        for (let c of cats) {
          const sub = arr.filter(a=>String(a[splitCol])===c);
          item[c] = aggFn(sub, y1Col, agg1); // Y1 over categories
        }
        result.push(item);
      }
      result.sort((a,b)=>String(a.x).localeCompare(String(b.x)));
      return { data: result, seriesKeys: cats, y2Enabled: false };
    }

    // no split: we can include Y1 and optional Y2
    for (let [k, arr] of grouped.entries()) {
      const item = { x:k };
      item[y1Col||"Y1"] = aggFn(arr, y1Col, agg1);
      if (y2Ok) item[y2Col||"Y2"] = aggFn(arr, y2Col, agg2);
      result.push(item);
    }
    result.sort((a,b)=>String(a.x).localeCompare(String(b.x)));

    const keys = Object.keys(result[0]||{}).filter(k=>k!=="x");
    return { data: result, seriesKeys: keys, y2Enabled: y2Ok };
  }, [baseFiltered, xCol, y1Col, y2Col, splitCol, granularity, agg1, agg2, topK, types]);

  // 100% stacked transform for bars with split
  const percentified = useMemo(() => {
    if (chart!=="bar" || barMode!=="percent" || !data.length) return data;
    const ks = seriesKeys;
    return data.map(row => {
      const total = ks.reduce((s,k)=>s+(Number(row[k])||0),0) || 1;
      const out = {...row};
      ks.forEach(k => out[k] = (Number(row[k])||0)/total*100);
      return out;
    });
  }, [data, chart, barMode, seriesKeys]);

  /** ---------- Export ---------- */
  const exportPNG = async () => {
    if (!chartRef.current) return;
    try {
      const url = await htmlToImage.toPng(chartRef.current, { cacheBust:true, backgroundColor:"#0b1220" });
      const a = document.createElement("a"); a.href = url; a.download = `datavue-${Date.now()}.png`; a.click();
    } catch(e) { console.error(e); alert("PNG export failed."); }
  };

  /** ---------- LLM ---------- */
  const loadLLM = async () => {
    setLlmLoading(true);
    try {
      const { CreateMLCEngine } = await import("@mlc-ai/web-llm");
      const MODEL = "Llama-3.2-1B-Instruct-q4f16_1-MLC";
      WebLLMEngine = await CreateMLCEngine(MODEL, { initProgressCallback: ()=>{} });
      setLlmReady(true);
    } catch (e) {
      console.error(e);
      alert("WebLLM failed to load. You can continue using the app without it.");
    } finally { setLlmLoading(false); }
  };

  const askLLM = async () => {
    if (!WebLLMEngine) return;
    const payload = {
      columns: columns.map(c=>({name:c, type:types[c]})),
      selection: {x:xCol, y1:y1Col, y2:y2Col, split:splitCol, chart, agg1, agg2, granularity},
      sample: rows.slice(0, 30),
      head: data.slice(0, 50)
    };
    const prompt = `
You are a senior data analyst. Based on the JSON, write:
- a crisp 5-bullet insight list (plain sentences),
- 1 sentence on whether the chosen chart is appropriate,
- 3 next EDA steps.

JSON:\n${JSON.stringify(payload).slice(0, 12000)}
`.trim();
    setLlmReply("Thinking…");
    try {
      const r = await WebLLMEngine.chat.completions.create({
        messages: [{role:"user", content: prompt}],
        temperature: 0.2, max_tokens: 500
      });
      setLlmReply(r?.choices?.[0]?.message?.content || "(no answer)");
    } catch(e) {
      console.error(e); setLlmReply("Error from WebLLM.");
    }
  };

  /** ---------- UI Parts ---------- */
  const Shelf = ({label, value, onDropHere, onClear, accept}) => (
    <div
      onDragOver={(e)=>e.preventDefault()}
      onDrop={(e)=>onDropHere(e)}
      className="border border-slate-600/40 rounded-2xl p-3 bg-slate-800/50 hover:bg-slate-800/80 transition min-h-[56px] flex items-center justify-between"
      title={label}
    >
      <div className="text-sm text-slate-300">{label} {accept? <span className="text-xs text-slate-500">({accept})</span>:null}</div>
      <div className="flex items-center gap-2">
        <div className="font-medium text-slate-100">{value || <span className="text-slate-500">drop or pick…</span>}</div>
        {value ? <button onClick={onClear} className="text-xs px-2 py-1 rounded bg-slate-700 hover:bg-slate-600">Clear</button> : null}
      </div>
    </div>
  );

  const onDragStart = (e, col) => e.dataTransfer.setData("text/col", col);
  const onDropTo = (e, setter) => {
    const col = e.dataTransfer.getData("text/col"); if (!col) return;
    setter(col);
  };

  /** ---------- Render ---------- */
  return (
    <div className="w-full min-h-screen bg-[#0b1220] text-slate-100">
      <div className="max-w-7xl mx-auto p-4">
        <header className="flex flex-wrap items-center justify-between mb-4 gap-3">
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight">DataVue — Interactive EDA Studio</h1>
          <div className="flex flex-wrap gap-2">
            <label className="cursor-pointer inline-flex items-center gap-2 bg-slate-800 rounded-xl px-3 py-2 shadow border border-slate-700">
              <span className="text-sm font-medium">Upload CSV</span>
              <input type="file" accept=".csv,text/csv" className="hidden"
                     onChange={(e)=>{ const f=e.target.files?.[0]; if (f) onCSV(f); }} />
            </label>
            <button onClick={exportPNG} className="bg-slate-800 rounded-xl px-3 py-2 shadow border border-slate-700 text-sm">
              Download PNG
            </button>
            <div className="flex items-center gap-2 bg-slate-800 rounded-xl px-3 py-2 shadow border border-slate-700">
              <span className="text-xs text-slate-300">Palette</span>
              <select value={palette} onChange={(e)=>setPalette(e.target.value)} className="bg-slate-900 rounded px-2 py-1 text-sm">
                {paletteNames.map(p=><option key={p} value={p}>{p}</option>)}
              </select>
            </div>
          </div>
        </header>

        {!rows.length ? (
          <div className="grid md:grid-cols-3 gap-4">
            <div className="md:col-span-2 bg-slate-800/60 rounded-2xl p-6 shadow border border-slate-700">
              <h2 className="text-xl font-semibold mb-2">Welcome</h2>
              <p className="text-sm text-slate-300 mb-3">Upload a CSV. We’ll suggest a good first chart automatically.</p>
              <ol className="list-decimal pl-6 space-y-1 text-sm text-slate-300">
                <li>Pick <strong>X</strong>, <strong>Y₁</strong>, optional <strong>Y₂</strong>, and optional <strong>Split</strong>.</li>
                <li>Use <strong>Bar mode</strong> for stacked / 100% stacked comparisons.</li>
                <li>Zoom with the brush; switch to <strong>Log</strong> for wide ranges.</li>
              </ol>
            </div>
            <div className="bg-slate-800/60 rounded-2xl p-6 shadow border border-slate-700">
              <h3 className="font-semibold mb-2">Pro tip</h3>
              <ul className="text-sm text-slate-300 list-disc pl-5">
                <li>Use <em>Split</em> to compare categories.</li>
                <li>Use <em>Filters</em> to focus on segments.</li>
              </ul>
            </div>
          </div>
        ) : (
          <div className="grid lg:grid-cols-[300px_1fr] gap-4">
            {/* Left rail */}
            <aside className="space-y-4">
              {/* Columns */}
              <div className="bg-slate-800/60 rounded-2xl p-4 shadow border border-slate-700">
                <div className="flex items-center justify-between mb-2">
                  <h2 className="font-semibold">Columns</h2>
                  <span className="text-xs text-slate-400">{columns.length}</span>
                </div>
                <div className="space-y-2 max-h-[40vh] overflow-auto pr-1">
                  {columns.map(c=>(
                    <div key={c}
                      draggable
                      onDragStart={(e)=>onDragStart(e,c)}
                      title={`${c} (${types[c]})`}
                      className="cursor-grab active:cursor-grabbing select-none bg-slate-900 rounded-xl px-3 py-2 shadow border border-slate-700 flex items-center justify-between hover:translate-x-[1px] transition"
                    >
                      <span className="truncate mr-2">{c}</span>
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-700 text-slate-200 border border-slate-600">
                        {types[c]}
                      </span>
                    </div>
                  ))}
                </div>

                {/* Dropdown role pickers for non-drag users */}
                <div className="mt-3 grid grid-cols-1 gap-2">
                  <select value={xCol} onChange={(e)=>setX(e.target.value)} className="bg-slate-900 rounded-xl px-3 py-2 border border-slate-700">
                    <option value="">— choose X —</option>
                    {columns.map(c=><option key={c} value={c}>{c} ({types[c]})</option>)}
                  </select>
                  <select value={y1Col} onChange={(e)=>setY1(e.target.value)} className="bg-slate-900 rounded-xl px-3 py-2 border border-slate-700">
                    <option value="">— choose Y₁ —</option>
                    {columns.map(c=><option key={c} value={c}>{c} ({types[c]})</option>)}
                  </select>
                  <select value={splitCol} onChange={(e)=>{ setSplit(e.target.value); setY2(""); }} className="bg-slate-900 rounded-xl px-3 py-2 border border-slate-700">
                    <option value="">— split by (optional) —</option>
                    {columns.map(c=><option key={c} value={c}>{c} ({types[c]})</option>)}
                  </select>
                  <select value={y2Col} onChange={(e)=>setY2(e.target.value)} disabled={!!splitCol} className="bg-slate-900 rounded-xl px-3 py-2 border border-slate-700 disabled:opacity-50">
                    <option value="">— choose Y₂ (optional) —</option>
                    {columns.map(c=><option key={c} value={c}>{c} ({types[c]})</option>)}
                  </select>
                </div>
              </div>

              {/* Filters */}
              <div className="bg-slate-800/60 rounded-2xl p-4 shadow border border-slate-700">
                <div className="flex items-center justify-between mb-2">
                  <h2 className="font-semibold">Filters</h2>
                  <button onClick={addRule} className="text-xs px-2 py-1 rounded bg-slate-700 hover:bg-slate-600">Add rule</button>
                </div>
                <div className="space-y-3">
                  {rules.map(rule=>{
                    const t = types[rule.col];
                    const isNum = t==="numeric";
                    const id = rule.id;
                    return (
                      <div key={id} className="rounded-xl bg-slate-900 p-3 border border-slate-700">
                        <div className="flex items-center gap-2 mb-2">
                          <select value={rule.col} onChange={(e)=>{
                            const col=e.target.value; const k=types[col]==="numeric"?"num":"cat";
                            updateRule(id, {col, kind:k, values:new Set(), min:null, max:null});
                          }} className="bg-slate-950 rounded px-2 py-1 border border-slate-700">
                            <option value="">(column)</option>
                            {columns.map(c=><option key={c} value={c}>{c}</option>)}
                          </select>
                          {(!isNum) && (
                            <select value={rule.mode} onChange={(e)=>updateRule(id,{mode:e.target.value})} className="bg-slate-950 rounded px-2 py-1 border border-slate-700">
                              <option value="include">include</option>
                              <option value="exclude">exclude</option>
                            </select>
                          )}
                          <button onClick={()=>removeRule(id)} className="ml-auto text-xs px-2 py-1 rounded bg-slate-700 hover:bg-slate-600">Remove</button>
                        </div>
                        {/* Rule body */}
                        {!rule.col ? <div className="text-xs text-slate-400">Pick a column</div> :
                          (isNum ? (
                            <div className="grid grid-cols-2 gap-2">
                              <input type="number" placeholder="min" className="bg-slate-950 rounded px-2 py-1 border border-slate-700"
                                     value={rule.min ?? ""} onChange={e=>updateRule(id,{min: e.target.value===""?null:Number(e.target.value)})}/>
                              <input type="number" placeholder="max" className="bg-slate-950 rounded px-2 py-1 border border-slate-700"
                                     value={rule.max ?? ""} onChange={e=>updateRule(id,{max: e.target.value===""?null:Number(e.target.value)})}/>
                            </div>
                          ) : (
                            <div className="max-h-28 overflow-auto flex flex-wrap gap-1">
                              {Array.from(new Set(baseFiltered.map(r=>String(r[rule.col])))).slice(0,60).map(v=>{
                                const selected = rule.values?.has(v);
                                return (
                                  <button key={v}
                                    onClick={()=> {
                                      const set = new Set(rule.values||[]);
                                      if (set.has(v)) set.delete(v); else set.add(v);
                                      updateRule(id,{values:set});
                                    }}
                                    className={`text-xs px-2 py-1 rounded border ${selected? "bg-slate-600 border-slate-500":"bg-slate-950 border-slate-700"}`}
                                  >{v}</button>
                                );
                              })}
                              {Array.from(new Set(baseFiltered.map(r=>String(r[rule.col])))).length>60 &&
                                <div className="text-[10px] text-slate-400">…showing first 60 values</div>}
                            </div>
                          ))
                        }
                      </div>
                    );
                  })}
                </div>
              </div>
            </aside>

            {/* Main workspace */}
            <main className="space-y-4">
              {/* Shelves with undo */}
              <div className="grid md:grid-cols-4 gap-3">
                <Shelf label="X-Axis" value={xCol} onDropHere={(e)=>onDropTo(e,setX)} onClear={()=>setX("")} accept="date/categorical/numeric" />
                <Shelf label="Y₁ (left axis)" value={y1Col} onDropHere={(e)=>onDropTo(e,setY1)} onClear={()=>setY1("")} accept="numeric" />
                <Shelf label={`Y₂ (right axis) ${splitCol ? "— disabled when Split is set" : ""}`} value={y2Col} onDropHere={(e)=>onDropTo(e,setY2)} onClear={()=>setY2("")} accept="numeric" />
                <Shelf label="Split by (optional)" value={splitCol} onDropHere={(e)=>{ onDropTo(e,setSplit); setY2(""); }} onClear={()=>setSplit("")} accept="categorical" />
              </div>

              {/* Controls */}
              <div className="bg-slate-800/60 rounded-2xl p-4 shadow border border-slate-700 grid xl:grid-cols-8 md:grid-cols-4 sm:grid-cols-2 gap-3 items-end">
                <div>
                  <label className="block text-xs text-slate-300" title="Geometry">Chart</label>
                  <select value={chart} onChange={e=>setChart(e.target.value)} className="mt-1 w-full bg-slate-900 rounded-xl px-3 py-2 border border-slate-700">
                    <option value="line">Line</option>
                    <option value="bar">Bar</option>
                    <option value="area">Area</option>
                    <option value="scatter">Scatter</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs text-slate-300" title="Roll-up for Y₁ over X">Agg (Y₁)</label>
                  <select value={agg1} onChange={e=>setAgg1(e.target.value)} className="mt-1 w-full bg-slate-900 rounded-xl px-3 py-2 border border-slate-700">
                    <option value="sum">Sum</option><option value="avg">Average</option><option value="min">Min</option><option value="max">Max</option><option value="count">Count</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-slate-300">Y₁ scale</label>
                  <select value={y1Scale} onChange={e=>setY1Scale(e.target.value)} className="mt-1 w-full bg-slate-900 rounded-xl px-3 py-2 border border-slate-700">
                    <option value="linear">Linear</option><option value="log">Log</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs text-slate-300" title="Roll-up for Y₂ over X">Agg (Y₂)</label>
                  <select value={agg2} onChange={e=>setAgg2(e.target.value)} disabled={!!splitCol} className="mt-1 w-full bg-slate-900 rounded-xl px-3 py-2 border border-slate-700 disabled:opacity-50">
                    <option value="sum">Sum</option><option value="avg">Average</option><option value="min">Min</option><option value="max">Max</option><option value="count">Count</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-slate-300">Y₂ scale</label>
                  <select value={y2Scale} onChange={e=>setY2Scale(e.target.value)} disabled={!y2Enabled} className="mt-1 w-full bg-slate-900 rounded-xl px-3 py-2 border border-slate-700 disabled:opacity-50">
                    <option value="linear">Linear</option><option value="log">Log</option>
                  </select>
                </div>

                {types[xCol]==="date" && (
                  <>
                    <div>
                      <label className="block text-xs text-slate-300">Granularity</label>
                      <select value={granularity} onChange={(e)=>setGran(e.target.value)} className="mt-1 w-full bg-slate-900 rounded-xl px-3 py-2 border border-slate-700">
                        <option value="day">Day</option><option value="month">Month</option><option value="year">Year</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-slate-300">Start</label>
                      <input type="date" value={dateRange.start} onChange={(e)=>setRange(r=>({...r,start:e.target.value}))} className="mt-1 w-full bg-slate-900 rounded-xl px-3 py-2 border border-slate-700"/>
                    </div>
                    <div>
                      <label className="block text-xs text-slate-300">End</label>
                      <input type="date" value={dateRange.end} onChange={(e)=>setRange(r=>({...r,end:e.target.value}))} className="mt-1 w-full bg-slate-900 rounded-xl px-3 py-2 border border-slate-700"/>
                    </div>
                  </>
                )}

                {chart==="bar" && (
                  <div>
                    <label className="block text-xs text-slate-300">Bar mode</label>
                    <select value={barMode} onChange={(e)=>setBarMode(e.target.value)} className="mt-1 w-full bg-slate-900 rounded-xl px-3 py-2 border border-slate-700">
                      <option value="grouped">Grouped</option>
                      <option value="stacked">Stacked</option>
                      <option value="percent">100% stacked</option>
                    </select>
                  </div>
                )}
                {splitCol && (
                  <div>
                    <label className="block text-xs text-slate-300">Top categories</label>
                    <input type="number" min={1} max={20} value={topK} onChange={(e)=>setTopK(Number(e.target.value)||6)}
                      className="mt-1 w-full bg-slate-900 rounded-xl px-3 py-2 border border-slate-700"/>
                  </div>
                )}
              </div>

              {/* Chart */}
              <div ref={chartRef} className="bg-slate-800/60 rounded-2xl p-4 shadow border border-slate-700">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-semibold">Visualization</h3>
                  <div className="text-xs text-slate-400">{data.length} points</div>
                </div>
                {(!xCol || !y1Col) ? (
                  <div className="text-sm text-slate-400">Pick X and Y₁ to see a chart.</div>
                ) : (
                  <div className="w-full h-[460px]">
                    <ResponsiveContainer width="100%" height="100%">
                      {(() => {
                        const axisCommon = (
                          <>
                            <CartesianGrid strokeDasharray="3 3" />
                            <XAxis dataKey="x" />
                            <YAxis yAxisId="left" scale={y1Scale} />
                            {y2Enabled && <YAxis yAxisId="right" orientation="right" scale={y2Scale} />}
                            <Tooltip wrapperStyle={{background:"#0f172a", border:"1px solid #334155", borderRadius:8, color:"#e2e8f0"}} />
                            <Legend />
                            <Brush dataKey="x" height={24} />
                          </>
                        );

                        if (chart==="bar") {
                          const renderBars = () => {
                            // Stacking only makes sense with multiple series (split or y2)
                            const stackId = barMode==="grouped" ? undefined : "S";
                            const keys = seriesKeys;
                            return keys.map((k,i)=>(
                              <Bar key={k} dataKey={k}
                                yAxisId={(y2Enabled && k===y2Col) ? "right" : "left"}
                                stackId={stackId}
                                fill={colorFor(palette,i)} />
                            ));
                          };
                          return (
                            <BarChart data={percentified} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                              {axisCommon}
                              {renderBars()}
                            </BarChart>
                          );
                        }

                        if (chart==="area") {
                          return (
                            <AreaChart data={data} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                              {axisCommon}
                              {seriesKeys.map((k,i)=>(
                                <Area key={k} dataKey={k}
                                  yAxisId={(y2Enabled && k===y2Col) ? "right" : "left"}
                                  type="monotone" dot={false}
                                  stroke={colorFor(palette,i)} fill={colorFor(palette,i)} />
                              ))}
                            </AreaChart>
                          );
                        }

                        if (chart==="scatter") {
                          return (
                            <ScatterChart margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                              {axisCommon}
                              {seriesKeys.map((k,i)=>(
                                <Scatter key={k} name={k}
                                  yAxisId={(y2Enabled && k===y2Col) ? "right" : "left"}
                                  data={data.map(d=>({ x:d.x, y:d[k] }))}
                                  fill={colorFor(palette,i)} />
                              ))}
                            </ScatterChart>
                          );
                        }

                        // default: line
                        return (
                          <LineChart data={data} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                            {axisCommon}
                            {seriesKeys.map((k,i)=>(
                              <Line key={k} dataKey={k}
                                yAxisId={(y2Enabled && k===y2Col) ? "right" : "left"}
                                type="monotone" dot={false} stroke={colorFor(palette,i)} />
                            ))}
                          </LineChart>
                        );
                      })()}
                    </ResponsiveContainer>
                  </div>
                )}
              </div>

              {/* Insights & Stats */}
              <div className="grid md:grid-cols-2 gap-4">
                <div className="bg-slate-800/60 rounded-2xl p-4 shadow border border-slate-700">
                  <h4 className="font-semibold mb-2">Column summary</h4>
                  {y1Col ? (
                    <div className="text-sm text-slate-300">
                      {(() => {
                        const s = summarize(rows, y1Col, types[y1Col]);
                        if (!s) return null;
                        if (types[y1Col]!=="numeric") return <div>Type: {types[y1Col]}</div>;
                        return (
                          <ul className="space-y-0.5">
                            <li>Count: {s.count}</li>
                            <li>Missing: {s.missing}</li>
                            <li>Mean: {typeof s.mean === 'number' ? s.mean.toFixed(2) : '—'}</li>
                            <li>Min/Max: {s.min ?? '—'} / {s.max ?? '—'}</li>
                          </ul>
                        );
                      })()}
                    </div>
                  ) : <div className="text-sm text-slate-400">Pick Y₁ to see stats.</div>}
                </div>

                <div className="bg-slate-800/60 rounded-2xl p-4 shadow border border-slate-700">
                  <h4 className="font-semibold mb-2">AI Assistant (free, in-browser)</h4>
                  <div className="flex flex-wrap gap-2 mb-2">
                    <button onClick={loadLLM} disabled={llmLoading || llmReady}
                      className="bg-slate-900 rounded-xl px-3 py-2 shadow border border-slate-700 text-sm disabled:opacity-60">
                      {llmReady ? "Model Ready ✓" : (llmLoading ? "Loading model…" : "Load WebLLM")}
                    </button>
                    <button onClick={askLLM} disabled={!llmReady}
                      className="bg-slate-900 rounded-xl px-3 py-2 shadow border border-slate-700 text-sm disabled:opacity-60">
                      Ask AI for insights
                    </button>
                  </div>
                  <div className="text-sm leading-6 bg-slate-900 rounded-xl p-3 border border-slate-700 max-h-48 overflow-auto whitespace-pre-wrap">
                    {llmReply || "Load the model, then click Ask AI for a readable, bullet-point summary."}
                  </div>
                </div>
              </div>
            </main>
          </div>
        )}

        <footer className="mt-6 text-xs text-slate-400 flex items-center justify-between">
          <div>Zoom with the brush • Try Log scale for big ranges • Switch palettes for readability</div>
          <div>© {new Date().getFullYear()} DataVue</div>
        </footer>
      </div>
    </div>
  );
}
