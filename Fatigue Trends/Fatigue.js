 // Fatigue Graph v0.2.0 — unofficial oss!idle add-on
 // SPDX-License-Identifier: AGPL-3.0-only
 //
 // Copyright (c) 2026 Not-Akagi
 //
 // Original add-on implementation by Not-Akagi.
 // https://github.com/Not-Akagi/oss-idle-addons
 //
 // Contains fatigue and warm-up calculations adapted from
 // oss!idle, developed by Adri and contributors.
 //
 // Original source:
 // https://github.com/oss-idle/oss-idle
 //
 // Portions of the fatigue and warm-up calculations are
 // adapted from the AGPL-3.0-licensed oss!idle source.
 // Modified and integrated into Fatigue Graph by Not-Akagi, 2026.
 //
 // Licensed under the GNU Affero General Public License v3.0 only.
 // See LICENSES/AGPL-3.0-only.txt for the full license text.

// Fatigue Graph 0.2.0. Read-only API GETs; no gameplay commands or game DB writes.
// Report-only metrics verified against oss!idle v1.2.4.0 fatigue.ts and
// warmupStage.ts. These helpers never update records or gameplay state.
function fatigueReportMetrics(report) {
  const level=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1;
  const fatigue=report?.fatigue, warm=report?.warmup, cooling=report?.cooling;
  const xpRetained=level(fatigue)?(1-0.95*fatigue)*100:undefined;
  let stage;
  // Keep the game's actual stage thresholds and cooling branch unchanged.
  if(level(warm)&&typeof cooling==='boolean') {
    stage=cooling?(warm<0.5?'tired':'pushing')
      :warm<0.25?'cold':warm<0.75?'warming':warm<0.995?'warm':'peak';
  }
  let strainMinutes;
  if(level(fatigue)&&fatigue>0) {
    // Fatigue is strictly increasing from 300 to the capped 420 minutes.
    // For Bezier(.4,0,.6,1), y(t)=3t²-2t³ and x(t)=1.2t-.6t²+.4t³.
    // Invert y by bisection, then evaluate x. This is nonlinear inversion,
    // not linear interpolation. Source solver tolerances justify rounding
    // the resulting minutes to one decimal and marking them as derived.
    if(fatigue===1)strainMinutes=420;
    else {
      let lo=0,hi=1;
      for(let i=0;i<60;i++) {
        const t=(lo+hi)/2,y=t*t*(3-2*t);
        if(y<fatigue)lo=t;else hi=t;
      }
      const t=(lo+hi)/2,x=t*(1.2+t*(-0.6+0.4*t));
      strainMinutes=300+120*x;
    }
  }else if(fatigue===0&&warm===0&&cooling===false) {
    // Cold on the rising branch is uniquely zero, regardless of gear count.
    strainMinutes=0;
  }
  return {xpRetained,stage,strainMinutes};
}

// Exact pure helpers from oss!idle v1.2.4.0; no game state is mutated.
const cubic_bezier = (x0        , y0        , x1        , y1        ) => {
	if (!(x0 >= 0 && x0 <= 1 && x1 >= 0 && x1 <= 1)) {
		throw new Error(`CubicBezier x1 & x2 values must be { 0 < x < 1 }, got { x1 : ${x0}, x2: ${x1} }`);
	}
	const ax = 1.0 - (x1 = 3.0 * (x1 - x0) - (x0 *= 3.0)) - x0;
	const ay = 1.0 - (y1 = 3.0 * (y1 - y0) - (y0 *= 3.0)) - y0;

	let i = 0;
	let r = 0.0;
	let s = 0.0;
	let d = 0.0;
	let x = 0.0;

	return (t        ) => {
		if (t < 0) return 0;
		if (t > 1) return 1;
		for (r = t, i = 0; 32 > i; i++) {
			if (1e-5 > Math.abs((x = r * (r * (r * ax + x1) + x0) - t))) {
				return r * (r * (r * ay + y1) + y0);
			} else if (1e-5 > Math.abs((d = r * (r * ax * 3.0 + x1 * 2.0) + x0))) {
				break;
			} else {
				r -= x / d;
			}
		}

		if ((s = 0.0) > (r = t)) return 0;
		else if ((d = 1.0) < r) return 1;

		// Bisection fallback when Newton's method above did not converge. Both
		// branches must move the bracket AND recompute the midpoint: the previous
		// code did `s = r` without updating `r`, so the same `x` was retested every
		// pass and the loop never terminated - on a curve where Newton fails near
		// t≈1 (consistency's pressure curve when a pressure strain lands in
		// [0.998, 1)) this hung the whole process forever, no exception. The
		// iteration cap is a hard termination guarantee (64 halvings exhaust double
		// precision over [0, 1]).
		for (i = 0; d > s && i < 64; i++) {
			if (1e-5 > Math.abs((x = r * (r * (r * ax + x1) + x0)) - t)) break;
			if (t > x) s = r;
			else d = r;
			r = 0.5 * (d - s) + s;
		}

		return r * (r * (r * ay + y1) + y0);
	};
};



const lerp=(start,end,t)=>start+(end-start)*t;
/** The character's fatigue in strained minutes, as of `at` (ms). */
                                                      

// The character tires a minute per minute its physical skills are strained and
// rests REST_RATE per other minute, played or idle: one fully strained map takes
// 2-3 easy ones to rest. From fresh, nonstop full strain starts to tell after
// 5 hours and reaches the floor at 7. Strain stops counting at STRAIN_CAP: every
// curve below is clamped to end by then.
const REST_RATE = 0.4;
const STRAIN_CAP = 7 * 60;
const ONSET_MINUTES = 5 * 60;
const FULL_MINUTES = 7 * 60;
const FATIGUE_CB = cubic_bezier(.4, 0, .6, 1);
// exhausted, the physical skills play with a quarter of their xp and earn XP_FLOOR
// of their gains: one map on loop averages about x0.1 a day
const PLAY_FLOOR = 0.25;
const XP_FLOOR = 0.05;
// The same strained minutes warm the character up over 1h30, then cool it to half
// at 5 hours and cold at 6. Cold, a physical skill plays with COLD_FLOOR of its xp
// from level COLD_LEVEL, less below; warm-up never touches xp gains. Each stamina
// gear up to GEAR_LADDER warms GEAR_SPEED faster and holds the peak GEAR_HOLD
// longer; each tier past it is worth GEAR_DECAY of the one before.
const WARM_MINUTES = 90;
const GEAR_LADDER = 10;
const GEAR_SPEED = 0.1;
const GEAR_HOLD = 3;
const GEAR_DECAY = 0.7;
const HALF_WARM_MINUTES = 5 * 60;
const COLD_MINUTES = 6 * 60;
const COLD_FLOOR = 0.5;
const COLD_LEVEL = 100;

/** The fatigue left at `now`, rested since the last play. */
const restedFatigue = (fatigue                     , now        )         =>
	Math.max(0, (fatigue?.minutes ?? 0) - REST_RATE * Math.max(0, now - (fatigue?.at ?? now)) / 60_000);

/** How far `minutes` are from `from` to `to`, eased: 0 before, 1 from `to` on. */
const ease = (minutes        , from        , to        )         =>
	to > from ? FATIGUE_CB((minutes - from) / (to - from)) : Number(minutes >= to);

/** How tired `minutes` of fatigue leave the character: 0 rested, 1 exhausted. */
const fatigueLevel = (minutes        )         => {
	const full = Math.min(FULL_MINUTES, STRAIN_CAP);
	return ease(minutes, Math.min(ONSET_MINUTES, full), full);
};

/** The stamina gear warm-up counts with: the ladder's, then tiers worth less and less. */
const warmGear = (upgrades        )         => {
	const tiers = Math.max(0, upgrades - GEAR_LADDER);
	return Math.min(upgrades, GEAR_LADDER) + (1 - GEAR_DECAY ** tiers) / (1 - GEAR_DECAY);
};

/** The strained minutes where warm-up peaks, starts cooling, is half and is cold, with `upgrades` stamina gear. */
const warmupCurve = (upgrades = 0) => {
	const gear = warmGear(upgrades);
	const cold = Math.min(COLD_MINUTES + gear * GEAR_HOLD, STRAIN_CAP);
	const half = Math.min(HALF_WARM_MINUTES + gear * GEAR_HOLD, cold);
	const peakEnd = Math.min(WARM_MINUTES + gear * GEAR_HOLD, half);
	const warm = Math.min(WARM_MINUTES / (1 + gear * GEAR_SPEED), peakEnd);
	return {
		warm, peakEnd, half, cold,
	};
};

/** How warmed up `minutes` of fatigue leave a character with `upgrades` stamina gear: 0 cold, 1 warm. */
const warmup = (minutes        , upgrades = 0)         => {
	const {
		warm, peakEnd, half, cold,
	} = warmupCurve(upgrades);
	if (minutes < warm) return ease(minutes, 0, warm);
	if (minutes < half) return lerp(1, 0.5, ease(minutes, peakEnd, half));
	return lerp(0.5, 0, ease(minutes, half, cold));
};

/** Whether `minutes` of fatigue are past warm-up's peak, cooling it down. */
const coolingDown = (minutes        , upgrades = 0)          =>
	minutes > warmupCurve(upgrades).peakEnd;

/** The share of the physical skills' xp gains a play at fatigue `level` keeps. */
const fatigueXp = (level        )         => lerp(1, XP_FLOOR, level);


function fatigueApiMetrics(profile,now) {
  if(!profile||!Number.isInteger(profile.id)||profile.id<=0||!Number.isInteger(profile.staminaUpgrades)||profile.staminaUpgrades<0
    ||!Object.prototype.hasOwnProperty.call(profile,'fatigue'))throw Error('Profile lacks valid fatigue state or Stamina upgrades');
  const state=profile.fatigue;
  if(state!==null&&(!state||!Number.isFinite(state.at)||state.at<0||!Number.isFinite(state.minutes)||state.minutes<0||state.minutes>420))throw Error('Invalid persisted strain state');
  const minutes=restedFatigue(state??undefined,now),fatigue=fatigueLevel(minutes),warm=warmup(minutes,profile.staminaUpgrades),cooling=coolingDown(minutes,profile.staminaUpgrades);
  const curve=warmupCurve(profile.staminaUpgrades);
  return {minutes,fatigue,warmup:warm,cooling,curve,xpRetained:fatigueXp(fatigue)*100,
    stage:fatigueReportMetrics({fatigue,warmup:warm,cooling}).stage,
    recoverStrain:Math.max(0,minutes-curve.peakEnd),restMinutes:Math.max(0,minutes-curve.peakEnd)/0.4};
}

let cleanup;
export function unmount() { const fn=cleanup; cleanup=undefined; fn?.(); }
export function mount() {
  unmount();
  let alive=true, db, timer, queue=Promise.resolve(), records=[], scores=[], characters=[];
  let selected='', range=86400000, activeToken, error='', busy=false, lastRead=0, graphHovered=false;
  const removers=[], sockets=new Set();
  let profileState,profileError='',profileController,profileRequest=0,lastProfileAttempt=0,profileLoading=false;
  let activity='unknown',activityCharacter,activitySerial=0,activityToken,serverSkew;
  let apiOrigin='https://api.oss.idle.rhythmgamers.net';
  const host=document.createElement('div');
  host.id='oss-idle-fatigue-graph';
  host.style.cssText='position:fixed;right:18px;bottom:18px;z-index:50000;pointer-events:none';
  const root=host.attachShadow({mode:'open'});
  const style=document.createElement('style');
  style.textContent=`
    :host{color:#eeeaf5;font:13px/1.5 system-ui,sans-serif}*{box-sizing:border-box}
    button,select{font:inherit;color:inherit;background:#292333;border:1px solid #50445f;border-radius:7px;padding:6px 10px;cursor:pointer}
    button:hover{background:#41334f}button:focus-visible,select:focus-visible{outline:2px solid #d9a5ff}
    .panel{pointer-events:auto;width:min(660px,calc(100vw - 36px));max-height:80vh;overflow:auto;background:#18131f;border:1px solid #554063;border-radius:13px;padding:18px;box-shadow:0 12px 50px #0009;margin-bottom:8px}
    [hidden]{display:none!important}h2{font-size:18px;margin:0}p{margin:8px 0}
    .top,.controls,.stats{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.top{justify-content:space-between}.controls{margin:14px 0}.controls label{display:flex;align-items:center;gap:6px}select{max-width:220px}
    .stats>div{flex:1;min-width:140px;padding:10px;background:#241c2d;border-radius:8px}.stats strong{display:block;font-size:22px}.muted{color:#b5a9c1;font-size:12px}
    .metrics{margin-top:10px;padding:10px;background:#211928;border:1px solid #3e304b;border-radius:8px;font-size:12px}
    .metrics h3{font-size:12px;margin:0 0 6px;font-weight:600}.metric-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 14px}
    .metric-grid strong{display:block;font-size:14px;overflow-wrap:anywhere}.metrics p{margin:6px 0 0}.metric-note{display:block;color:#b5a9c1;font-size:11px;line-height:1.4}
    @media(max-width:450px){.metric-grid{grid-template-columns:1fr}}
    canvas{display:block;width:100%;height:200px;margin-top:12px}table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;border-bottom:1px solid #34283f;padding:7px 5px}th{color:#baacc8}.history{max-height:235px;overflow:auto}.error{color:#ffd288}
  `;
  root.append(style);
  function el(tag,text,parent,cls) { const n=document.createElement(tag); if(text!==undefined)n.textContent=text; if(cls)n.className=cls; parent?.append(n); return n; }
  function on(n,event,fn,options) { n.addEventListener(event,fn,options); removers.push(()=>n.removeEventListener(event,fn,options)); }
  const panel=el('section',undefined,root,'panel'); panel.setAttribute('aria-label','Fatigue graph');
  const top=el('div',undefined,panel,'top'); el('h2','Fatigue trends',top); const close=el('button','Close · Alt+Shift+W',top); close.title='Toggle with Alt+Shift+W';
  panel.setAttribute('aria-keyshortcuts','Alt+Shift+W');
  const controls=el('div',undefined,panel,'controls');
  const characterSelect=el('select',undefined,el('label','Character ',controls));
  const rangeSelect=el('select',undefined,el('label','Window ',controls));
  for(const [value,name] of [[3600000,'1 hour'],[21600000,'6 hours'],[86400000,'24 hours'],[604800000,'7 days'],[0,'All recorded']]) { const o=el('option',name,rangeSelect); o.value=String(value); }
  rangeSelect.value=String(range); const exportButton=el('button','Export CSV',controls);
  const stats=el('div',undefined,panel,'stats');
  const fatigueBox=el('div',undefined,stats); el('span','Latest reported fatigue',fatigueBox,'muted'); const fatigueValue=el('strong','—',fatigueBox);
  const fatigueChange=el('span','First recorded point',fatigueBox,'muted');
  const warmBox=el('div',undefined,stats); el('span','Latest reported warm-up',warmBox,'muted'); const warmValue=el('strong','—',warmBox);
  const warmChange=el('span','First recorded point',warmBox,'muted');
  const metrics=el('section',undefined,panel,'metrics');metrics.setAttribute('aria-label','Additional training metrics');
  const metricHeader=el('div',undefined,metrics,'top');
  const metricTitle=el('h3','Training metrics · API state',metricHeader);
  const refreshButton=el('button','Refresh state',metricHeader);refreshButton.style.fontSize='11px';refreshButton.style.padding='3px 7px';
  const apiNotice=el('p','Waiting for current character state…',metrics,'metric-note');
  const metricGrid=el('div',undefined,metrics,'metric-grid');
  function metric(label) {
    const box=el('div',undefined,metricGrid);el('span',label,box,'muted');
    return {value:el('strong','Unavailable',box),note:el('span','',box,'metric-note')};
  }
  const currentFatigue=metric('Rest-adjusted fatigue');
  const currentWarmup=metric('Rest-adjusted warm-up');
  const xpMetric=metric('Physical XP retained');
  xpMetric.note.textContent='Fatigue-related XP multiplier only; other modifiers still apply.';
  const conditionMetric=metric('Training condition');
  conditionMetric.note.textContent='Game warm-up stage at the latest report.';
  const strainMetric=metric('Accumulated strain');
  const recoveryMetric=metric('Recovery to optimal warm-up');
  recoveryMetric.note.textContent='Current strain is not exposed. Complete rest recovers 0.4 strain min/min; future maps change it.';
  const currentNote=el('p','API values are separate from the recorded map-start graph.',metrics,'metric-note');
  const status=el('p','Waiting for a new map…',panel,'muted');
  const canvas=el('canvas',undefined,panel); canvas.setAttribute('role','img'); canvas.setAttribute('aria-label','Reported fatigue and warm-up by map start time; values listed in the history table');
  const legend=el('p',undefined,panel,'muted'); el('span','● Fatigue  ',legend).style.color='#f4a3b6'; el('span','● Warm-up',legend).style.color='#96d8ce';
  el('p','Points are exact reports at map start. Dashed lines connect observations; they do not measure fatigue between maps. Fatigue stays fixed within each play.',panel,'muted');
  const warning=el('p','',panel,'error'), history=el('div',undefined,panel,'history');
  function setOpen(open) { panel.hidden=!open; if(!open)graphHovered=false; if(open){render();void refreshProfile();} }
  on(canvas,'pointerenter',event=>{if(event.pointerType==='touch')return;graphHovered=true;render();});
  on(canvas,'pointerleave',()=>{graphHovered=false;render();});
  on(close,'click',()=>setOpen(false));
  // Claim the shortcut before bubble-phase gameplay handlers. A held key
  // toggles once; its release is consumed even if modifiers were released first.
  const claimedKeys=new Set();
  on(window,'keydown',e=>{
    if(e.isComposing)return;
    const code=e.code||e.key?.toLowerCase();
    const shortcut=e.altKey&&e.shiftKey&&!e.ctrlKey&&!e.metaKey&&(e.code==='KeyW'||e.key?.toLowerCase()==='w');
    if(!shortcut&&!claimedKeys.has(code))return;
    e.preventDefault();e.stopImmediatePropagation();
    if(shortcut&&!e.repeat&&!claimedKeys.has(code))setOpen(panel.hidden);
    claimedKeys.add(code);
  },true);
  on(window,'keyup',e=>{
    const code=e.code||e.key?.toLowerCase();
    if(!claimedKeys.delete(code))return;
    e.preventDefault();e.stopImmediatePropagation();
  },true);
  on(window,'blur',()=>claimedKeys.clear());
  for(const event of ['keydown','keyup','keypress','pointerdown','pointerup','mousedown','mouseup','click','dblclick','wheel','touchstart','touchend','contextmenu']) on(root,event,e=>e.stopPropagation());
  on(root,'keydown',e=>{if(e.key==='Escape')setOpen(false);});
  // Keep the client's song-search focus handler out of overlay controls.
  on(window,'focusin',e=>{if(e.composedPath().includes(host))e.stopImmediatePropagation();},true);
  on(characterSelect,'change',()=>{selected=characterSelect.value;resetProfile();render();void refreshProfile(true);});
  on(refreshButton,'click',()=>void refreshProfile(true));
  on(rangeSelect,'change',()=>{range=Number(rangeSelect.value);render();});
  document.body.append(host);
  const pct=v=>Number.isFinite(v)?`${(v*100).toFixed(1)}%`:'—';
  const level=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1;
  const time=v=>new Date(v).toLocaleString();
  const byTime=(a,b)=>a.at-b.at;
  // Differences are percentage points, rounded to the display precision.
  const delta=(now,before)=>{
    if(!Number.isFinite(now)||!Number.isFinite(before))return undefined;
    const value=Math.round((now-before)*1000)/10;
    return `${value>0?'+':''}${value.toFixed(1)} pp`;
  };
  const forCharacter=r=>String(r.characterId)===selected;
  const visible=()=>records.filter(r=>forCharacter(r)&&(!range||r.at>=Date.now()-range)).sort(byTime);
  async function query(sql,params=[]) {
    if(!window.db?.read)return [];
    const result=await window.db.read(d=>d.exec(sql,params)), first=result[0];
    return first?first.values.map(row=>Object.fromEntries(first.columns.map((c,i)=>[c,row[i]]))):[];
  }
  async function refreshScores() {
    characters=await query('SELECT id, name, local FROM character ORDER BY local ASC, overallTotalXp DESC');
    scores=await query('SELECT id, onlineId, characterId, beatmapId, playedAt, rate, accuracy FROM score ORDER BY playedAt DESC LIMIT 2000');
    if(!alive)return;
    if(!selected)selected=String(scores[0]?.characterId??characters[0]?.id??'');
    characterSelect.replaceChildren();
    const choices=new Map(characters.map(c=>[String(c.id),`${c.name} (#${c.id})`]));
    for(const r of records)if(!choices.has(String(r.characterId)))choices.set(String(r.characterId),`Character #${r.characterId}`);
    if(selected&&!choices.has(selected))choices.set(selected,`Character #${selected}`);
    for(const [id,name] of choices){const o=el('option',name,characterSelect);o.value=id;}
    characterSelect.value=selected; lastRead=Date.now();
  }
  function resetProfile() {
    profileRequest++;profileController?.abort();profileController=undefined;profileState=undefined;
    profileLoading=false;profileError='';lastProfileAttempt=0;
  }
  async function refreshProfile(force=false) {
    const id=Number(selected);
    if(!alive||panel.hidden||!Number.isInteger(id)||id<=0||profileLoading)return;
    if(Date.now()-lastProfileAttempt<(force?1000:30000))return;
    const request=++profileRequest,serial=activitySerial,controller=new AbortController();
    profileController=controller;profileLoading=true;lastProfileAttempt=Date.now();profileError='';render();
    const timeout=setTimeout(()=>controller.abort(),8000),sentAt=Date.now();
    try {
      const response=await fetch(apiOrigin+'/v1/characters/'+id,{method:'GET',credentials:'omit',cache:'no-store',signal:controller.signal});
      if(!response.ok)throw Error('Profile request failed ('+response.status+')');
      const profile=await response.json(),receivedAt=Date.now();
      if(profile.id!==id)throw Error('Profile character ID mismatch');
      fatigueApiMetrics(profile,receivedAt); // Validate without changing or persisting the payload.
      if(!alive||request!==profileRequest||Number(selected)!==id)return;
      const headerTime=Date.parse(response.headers.get('Date')??'');
      const skew=Number.isFinite(headerTime)?headerTime+500-(sentAt+receivedAt)/2:(serverSkew??0);
      profileState={profile,receivedAt,skew,serial,clock:Number.isFinite(headerTime)?'HTTP server clock':serverSkew!==undefined?'observed server clock':'device clock'};
    }catch(e) {
      if(alive&&request===profileRequest)profileError=controller.signal.aborted?'API refresh timed out or was cancelled.':e.message;
    }finally {
      clearTimeout(timeout);
      if(alive&&request===profileRequest){profileLoading=false;profileController=undefined;render();}
    }
  }
  function noteActivity(msg) {
    const p=msg.type==='play:start'?msg.result:msg.state;
    if(Number.isFinite(p?.serverNow))serverSkew=p.serverNow-Date.now();
    const record=records.find(r=>r.token===(p?.token??msg.token));
    const score=msg.type==='play:result'&&msg.result?.ok?msg.result.score:undefined;
    const nextCharacter=score?.characterId??record?.characterId??activityCharacter??scores[0]?.characterId??Number(selected);
    let next;
    if(msg.type==='play:start'&&p?.status==='ranked'||msg.type==='play:state'&&p?.phase==='active')next='active';
    else if(msg.type==='play:result'&&msg.result?.ok||msg.type==='play:aborted'||msg.type==='play:state'&&p?.phase==='idle')next='idle';
    else if(msg.type==='play:state'&&p?.phase==='finished')next='settling';
    else return;
    const token=next==='idle'?undefined:p?.token;
    if(next===activity&&token===activityToken&&nextCharacter===activityCharacter)return;
    activity=next;activityToken=token;activityCharacter=nextCharacter;
    activitySerial++;
    // Do not let a request racing a result turn an old row into a fresh current reading.
    profileRequest++;profileController?.abort();profileController=undefined;profileLoading=false;lastProfileAttempt=0;
  }
  const opened=new Promise(resolve=>{
    let req;
    try { req=indexedDB.open('oss-idle-addon-fatigue-graph-v1',1); }
    catch { error='History storage unavailable; keeping this session in memory.';resolve();return; }
    req.onupgradeneeded=()=>req.result.createObjectStore('plays',{keyPath:'token'});
    req.onsuccess=()=>{
      if(!alive){req.result.close();resolve();return;}
      db=req.result; db.onversionchange=()=>{db.close();db=undefined;};
      const read=db.transaction('plays','readonly').objectStore('plays').getAll();
      read.onsuccess=()=>{records=read.result.sort(byTime);resolve();};
      read.onerror=()=>{error='Could not load saved history.';resolve();};
    };
    req.onerror=()=>{error='History storage unavailable; keeping this session in memory.';resolve();};
    req.onblocked=()=>{error='History storage blocked by another tab.';resolve();};
  });
  function persist(record) {
    const i=records.findIndex(r=>r.token===record.token); if(i<0)records.push(record);else records[i]=record;
    records.sort(byTime); const removed=records.splice(0,Math.max(0,records.length-10000));
    if(db&&alive)try {
      const tx=db.transaction('plays','readwrite'), store=tx.objectStore('plays');store.put(record);
      for(const r of removed)store.delete(r.token);
      tx.onerror=()=>{error='Saving history failed; export CSV to keep this session.';if(alive)render();};
    }catch {error='Saving history failed; export CSV to keep this session.';}
  }
  async function receive(msg) {
    await opened;if(!alive)return;
    noteActivity(msg);
    if(msg.type==='play:start') {
      const p=msg.result;
      if(p?.status!=='ranked'||!level(p.fatigue)||!level(p.warmup)||typeof p.token!=='string')return;
      if(![p.startedAt,p.endsAt,p.serverNow,p.beatmapId,p.rate].every(Number.isFinite))return;
      await refreshScores();if(!alive)return;
      const prior=records.find(r=>r.token===p.token), characterId=prior?.characterId??Number(selected);
      if(!characterId)return;
      persist({...prior,token:p.token,characterId,beatmapId:p.beatmapId,rate:p.rate,
        at:prior?.at??Date.now()+p.startedAt-p.serverNow,endsAt:Date.now()+p.endsAt-p.serverNow,
        fatigue:p.fatigue,warmup:p.warmup,cooling:!!p.cooling,state:prior?.state??'started',identity:prior?.identity??'inferred'});
      activeToken=p.token;
    }else if(msg.type==='play:result'&&msg.result?.ok) {
      const r=records.find(r=>r.token===msg.token);if(!r)return;
      const s=msg.result.score;
      persist({...r,state:s?'completed':'finished (no score)',...(s?{characterId:s.characterId,beatmapId:s.beatmapId,
        playedAt:s.playedAt,onlineScoreId:s.id,accuracy:s.accuracy,identity:'confirmed'}:{})});
      if(activeToken===msg.token)activeToken=undefined;await refreshScores();
    }else if(msg.type==='play:aborted') {
      const r=records.find(r=>r.token===msg.token);if(r)persist({...r,state:'aborted'});
      if(activeToken===msg.token)activeToken=undefined;
    }else if(msg.type==='play:state'&&msg.state?.phase==='active')activeToken=msg.state.token;
    else if(msg.type==='play:state'&&msg.state?.phase==='idle')activeToken=undefined;
    render();void refreshProfile();
  }
  function observe(socket) {
    if(!alive||sockets.has(socket))return;
    let url;try{url=new URL(socket.url);}catch{return;}
    if(url.pathname!=='/v1/ws')return;
    const origin=url.origin.replace(/^ws/,'http');
    if(apiOrigin!==origin){apiOrigin=origin;resetProfile();}
    sockets.add(socket);
    on(socket,'close',()=>{activity='unknown';activitySerial++;render();});
    on(socket,'message',event=>{
      if(!alive||typeof event.data!=='string'||event.data.length>2000000)return;
      let msg;try{msg=JSON.parse(event.data);}catch{return;}
      if(!['play:start','play:result','play:aborted','play:state'].includes(msg?.type))return;
      queue=queue.then(()=>receive(msg)).catch(e=>{error=`Capture error: ${e.message}`;if(alive)render();});
    });
  }
  // Discover already-open sockets on their next send, without changing payloads.
  const originalSend=WebSocket.prototype.send;
  function tappedSend(...args){try{observe(this);}catch{}return Reflect.apply(originalSend,this,args);}
  WebSocket.prototype.send=tappedSend;
  function render() {
    if(!alive||panel.hidden)return;
    const rows=visible(), characterRecords=records.filter(forCharacter).sort(byTime);
    const latest=characterRecords.at(-1), previous=characterRecords.at(-2);
    fatigueValue.textContent=pct(latest?.fatigue);warmValue.textContent=pct(latest?.warmup);
    fatigueChange.textContent=previous?`${delta(latest.fatigue,previous.fatigue)} vs previous map`:latest?'First recorded point':'No recorded points';
    warmChange.textContent=previous?`${delta(latest.warmup,previous.warmup)} vs previous map`:latest?'First recorded point':'No recorded points';
    const extra=fatigueReportMetrics(latest);
    const stageNames={cold:'Cold',warming:'Warming up',warm:'Warm',peak:'Peak',pushing:'Pushing past peak',tired:'Tired'};
    const sameProfile=profileState?.profile.id===Number(selected),fresh=sameProfile&&Date.now()-profileState.receivedAt<=45000&&profileState.serial===activitySerial;
    const playing=activity==='active'&&activityCharacter===Number(selected),settling=activity==='settling'&&activityCharacter===Number(selected);
    const idle=activity==='idle'&&activityCharacter===Number(selected),confirmed=fresh&&idle&&!profileError;
    let current;
    if(sameProfile&&!playing&&!settling)current=fatigueApiMetrics(profileState.profile,Date.now()+profileState.skew);
    refreshButton.disabled=profileLoading||!(Number(selected)>0);
    refreshButton.textContent=profileLoading?'Refreshing…':'Refresh state';
    metricTitle.textContent=current?(confirmed?'Training metrics · current API state':'Training metrics · rest-only projection'):'Training metrics · latest map-start report';
    currentFatigue.value.textContent=current?pct(current.fatigue):'Unavailable';
    currentWarmup.value.textContent=current?pct(current.warmup):'Unavailable';
    xpMetric.value.textContent=Number.isFinite(current?.xpRetained??extra.xpRetained)?(current?.xpRetained??extra.xpRetained).toFixed(1)+'%':'Unavailable';
    conditionMetric.value.textContent=stageNames[current?.stage??extra.stage]??'Unavailable';
    conditionMetric.note.textContent=current?'Game stage from API strain and actual Stamina upgrades.':'Game warm-up stage at the latest map-start report.';
    strainMetric.value.textContent=current?current.minutes.toFixed(1)+' min · API':sameProfile?(profileState.profile.fatigue?.minutes??0).toFixed(1)+' min · last finalized':Number.isFinite(extra.strainMinutes)?'≈ '+extra.strainMinutes.toFixed(1)+' min · derived':'Unavailable';
    strainMetric.note.textContent=current?'Stored minutes adjusted for elapsed complete rest.':sameProfile?'An unfinished play may add strain; current total is unavailable.':latest?'Map-start derivation only; refresh the API for persisted state.':'Waiting for a report or API state.';
    recoveryMetric.value.textContent='Unavailable';
    recoveryMetric.note.textContent='Requires fresh API state and observed idle status. Complete rest recovers 0.4 strain min/min.';
    if(confirmed&&current) {
      const peak=current.curve.warm.toFixed(1)+'–'+current.curve.peakEnd.toFixed(1)+' strain min';
      recoveryMetric.value.textContent=current.minutes<current.curve.warm?'Warm-up needed':current.restMinutes.toFixed(1)+' min complete rest';
      recoveryMetric.note.textContent=current.minutes<current.curve.warm?'Rest decreases strain; training is needed to reach the '+peak+' peak region.':current.restMinutes>0?'Recover '+current.recoverStrain.toFixed(1)+' strain min to the '+peak+' peak region. Future maps change this.':'Already in the '+peak+' peak region; further rest can cool the character.';
    }
    apiNotice.textContent=profileError?'API unavailable: '+profileError+(sameProfile?' Showing the last snapshot as a conditional projection.':' Map-start history is unaffected.')
      :!(Number(selected)>0)?'API state is available for online character IDs; guest history stays local.'
      :sameProfile?'API fetched '+time(profileState.receivedAt)+' · '+profileState.clock+' · Stamina upgrades '+profileState.profile.staminaUpgrades
      :profileLoading?'Reading persisted strain from the game API…':'No current API state yet.';
    currentNote.textContent=playing||settling?'Unfinished play: map-start fatigue is fixed; refresh after finalization for current recovery.'
      :current&&!confirmed?'Rest-only projection assumes no unfinished play. '+(!fresh?'Snapshot needs refreshing. ':'')+'Current activity is not confirmed for this character; recovery time is withheld.'
      :confirmed?'Current metrics use persisted API state and elapsed rest. They do not add points to the historical graph.'
      :'API readings are separate from the recorded map-start graph.';
    const active=records.find(r=>r.token===activeToken&&forCharacter(r));
    status.textContent=active&&Date.now()<active.endsAt?`Playing map #${active.beatmapId} · fixed start-of-map fatigue · ${active.identity} character`
      :latest?`Last report: ${time(latest.at)} · ${latest.state} · ${latest.identity} character`
      :'Waiting for a ranked map to start. Existing sockets are observed on their next outgoing message.';
    warning.textContent=error||'Older scores contain no fatigue data. Guest and unranked plays are not measured. Character choice is provisional until a score confirms it.';
    draw(rows,previous);history.replaceChildren();
    const table=el('table',undefined,history), head=el('tr',undefined,el('thead',undefined,table));
    for(const title of ['Time','Map / rate','Fatigue','Warm-up','Status'])el('th',title,head);
    const body=el('tbody',undefined,table);
    const seen=new Set(records.filter(forCharacter).filter(r=>r.onlineScoreId).map(r=>r.onlineScoreId));
    const old=scores.filter(s=>String(s.characterId)===selected&&!seen.has(s.onlineId)&&(!range||s.playedAt>=Date.now()-range))
      .map(s=>({...s,at:s.playedAt,state:'Not recorded'}));
    const all=[...rows,...old].sort((a,b)=>b.at-a.at);
    for(const r of all.slice(0,100)){const tr=el('tr',undefined,body);for(const text of [time(r.at),`#${r.beatmapId} · ${r.rate}×`,pct(r.fatigue),pct(r.warmup),r.state])el('td',text,tr);}
    if(!all.length){const td=el('td','No plays in this window.',el('tr',undefined,body));td.colSpan=5;}
    el('p',`${rows.length} captured observations in this window. Up to 100 history rows shown; score lookup covers the latest 2,000 local scores.`,history,'muted');
  }
  function draw(rows,previous) {
    const w=Math.max(260,canvas.getBoundingClientRect().width||600),h=200,dpr=Math.min(2,window.devicePixelRatio||1);
    canvas.width=w*dpr;canvas.height=h*dpr;const c=canvas.getContext('2d');if(!c)return;c.scale(dpr,dpr);
    const left=38,right=w-12,top=12,bottom=170;c.font='11px system-ui';c.fillStyle='#b5a9c1';c.strokeStyle='#392c43';
    for(let pct=0;pct<=100;pct+=25){const y=bottom-(bottom-top)*pct/100;c.beginPath();c.moveTo(left,y);c.lineTo(right,y);c.stroke();c.fillText(`${pct}%`,0,y+4);}
    if(!rows.length){c.fillText('Start a ranked map to record the first point.',left+8,88);return;}
    const end=Date.now(),start=range?end-range:Math.min(rows[0].at,end-60000),x=at=>left+(right-left)*(at-start)/(end-start);
    for(const [key,color] of [['fatigue','#f4a3b6'],['warmup','#96d8ce']]){
      c.strokeStyle=color;c.fillStyle=color;c.setLineDash([3,4]);c.beginPath();
      rows.forEach((r,i)=>{const px=x(r.at),py=bottom-r[key]*(bottom-top);if(i)c.lineTo(px,py);else c.moveTo(px,py);});c.stroke();c.setLineDash([]);
      for(const r of rows){c.beginPath();c.arc(x(r.at),bottom-r[key]*(bottom-top),3,0,Math.PI*2);c.fill();}
    }
    // Keep the plot unobstructed until the pointer enters the graph.
    if(graphHovered) {
      // Attach one readable callout to the newest observation. Keep the box
      // inside the plot even at 0% or 100%, or on a narrow screen.
      const latest=rows.at(-1), px=Math.max(left,Math.min(right,x(latest.at)));
      const py=bottom-latest.fatigue*(bottom-top), bw=154, bh=42;
      const bx=Math.max(left+4,Math.min(right-bw,px-bw-10));
      const by=Math.max(top+3,Math.min(bottom-bh-3,py-bh/2));
      c.strokeStyle='#a38aac';c.beginPath();c.moveTo(px,py);c.lineTo(bx+bw,by+bh/2);c.stroke();
      c.fillStyle='#211928';c.fillRect(bx,by,bw,bh);c.strokeStyle='#685175';c.strokeRect(bx,by,bw,bh);
      c.font='11px system-ui';c.fillStyle='#f4a3b6';
      c.fillText(previous?'Fatigue Δ '+delta(latest.fatigue,previous.fatigue):'First recorded point',bx+7,by+16);
      c.fillStyle='#96d8ce';
      c.fillText(previous?'Warm-up Δ '+delta(latest.warmup,previous.warmup):'No previous comparison',bx+7,by+32);
      c.strokeStyle='#f4a3b6';c.beginPath();c.arc(px,py,5,0,Math.PI*2);c.stroke();
    }
    const stamp=at=>new Date(at).toLocaleString([],range===0||range>=86400000?{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}:{hour:'2-digit',minute:'2-digit'});c.fillStyle='#b5a9c1';c.fillText(stamp(start),left,192);
    const endText=stamp(end);c.fillText(endText,right-c.measureText(endText).width,192);
  }
  on(exportButton,'click',()=>{
    const columns=['at','characterId','beatmapId','rate','fatigue','warmup','state','identity','playedAt'];
    const escape=v=>`"${String(v??'').replaceAll('"','""')}"`;
    const csv=[columns.join(','),...visible().map(r=>columns.map(k=>escape(k==='at'?new Date(r.at).toISOString():r[k])).join(','))].join('\r\n');
    const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'})),a=el('a',undefined,root);a.href=url;a.download='oss-idle-fatigue.csv';a.click();a.remove();
    const release=setTimeout(()=>URL.revokeObjectURL(url),1000);removers.push(()=>{clearTimeout(release);URL.revokeObjectURL(url);});
  });
  on(window,'resize',render);
  async function tick(){if(!alive||busy)return;busy=true;try{await opened;if(alive&&Date.now()-lastRead>15000)await refreshScores();if(alive){render();void refreshProfile();}}catch(e){error=`Game data unavailable: ${e.message}`;if(alive)render();}finally{busy=false;}}
  cleanup=()=>{alive=false;profileRequest++;profileController?.abort();clearInterval(timer);if(WebSocket.prototype.send===tappedSend)WebSocket.prototype.send=originalSend;for(const remove of removers.reverse())remove();sockets.clear();db?.close();host.remove();};
  timer=setInterval(()=>void tick(),5000);void tick();
}
