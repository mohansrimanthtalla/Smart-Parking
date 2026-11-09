"use strict";
/* Smart Parking System - data and authentication are served by the Flask API. */
const $=(s,r=document)=>r.querySelector(s);
const tid=p=>p+Math.random().toString(36).slice(2,8).toUpperCase(),stamp=()=>new Date().toLocaleString(),rs=n=>"Rs "+Math.round(n);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const today=()=>new Date().toISOString().slice(0,10),TYPES=["Bike","Car","SUV"];
let db,post,charts=[],revision=0,saveQueue=Promise.resolve(),saveGeneration=0,ui={sel:null,bk:{},q:"",vt:"Car",av:"",hq:"",hs:"",bq:"",bs:"",bd:"",ls:0,rl:null};
async function api(path,options={}){
 const response=await fetch(path,{credentials:"same-origin",...options,headers:{"Content-Type":"application/json",...(options.headers||{})}});
 if(response.status===204)return null;
 const body=await response.json().catch(()=>({}));
 if(!response.ok)throw new Error(body.error||`Request failed (${response.status}).`);
 return body;
}
async function load(){
 const result=await api("/api/state");
 db=result.state;revision=result.revision;
}
function save(){
 if(!me())return;
 const generation=saveGeneration,snapshot=JSON.stringify(db);
 saveQueue=saveQueue.then(async()=>{
  if(generation!==saveGeneration)return;
  try{
   const result=await api("/api/state",{method:"PUT",body:JSON.stringify({revision,state:JSON.parse(snapshot)})});
   revision=result.revision;
  }catch(error){
   saveGeneration++;console.error(error);
   try{await load();render()}catch(reloadError){console.error(reloadError)}
   toast(error.message,1);
  }
 });
}
const log=(who,msg)=>{db.audit.unshift({t:stamp(),who,uid:me()?.id??null,msg});save()};
const me=()=>db?.users?.[0]||null;
const lotOf=id=>db.lots.find(l=>l.id==id),slotOf=id=>db.slots.find(s=>s.id==id),bkOf=id=>db.bookings.find(b=>b.id===id);
const inLot=id=>db.slots.filter(s=>s.lot==id),free=id=>inLot(id).filter(s=>s.st==="A").length;
const occ=id=>{const a=inLot(id);return a.length?a.filter(s=>s.st==="O"||s.st==="R").length/a.length:0};
const surge=id=>occ(id)>.8,rate=(id,t)=>Math.round(db.prices[t]*(surge(id)?1.2:1));  /* dynamic pricing: +20% above 80% occupancy */

/* ---------- ui helpers ---------- */
function toast(m,e){const t=$("#toast");t.textContent=m;t.className="show"+(e?" e":"");clearTimeout(t._t);t._t=setTimeout(()=>t.className="",2800)}
const btn=(a,id,t,c="")=>`<button class="btn sm ${c}" data-a="${a}" data-id="${esc(id)}">${t}</button>`;
const badge=s=>`<span class="bd ${s.replace(/\s/g,"")}">${s}</span>`;
const tbl=(h,rows)=>`<div class="tw"><table><thead><tr>${h.map(x=>`<th>${x}</th>`).join("")}</tr></thead><tbody>${rows.length?rows.map(r=>`<tr>${r.map(c=>`<td>${c}</td>`).join("")}</tr>`).join(""):`<tr><td colspan="${h.length}" class="mut">No records found.</td></tr>`}</tbody></table></div>`;
const opts=(l,s)=>l.map(x=>{const[v,t]=Array.isArray(x)?x:[x,x];return `<option value="${esc(v)}" ${v==s?"selected":""}>${esc(t)}</option>`}).join("");
const stat=(l,v)=>`<div class="stat"><span>${l}</span><b>${v}</b></div>`;
const legend=`<div class="legend"><span><i style="--c:var(--green)"></i>Available</span><span><i style="--c:var(--red)"></i>Occupied</span><span><i style="--c:var(--blue)"></i>Reserved</span><span><i style="--c:var(--grey)"></i>Maintenance</span></div>`;
function modal(title,body,ok,label="Save"){const d=$("#dlg");d.innerHTML=`<form method="dialog" id="mf"><h3>${title}</h3>${body}<div class="err" id="me"></div><div class="grow" style="margin:14px 0 0"><button class="btn" value="ok">${ok?label:"Close"}</button>${ok?'<button type="button" class="btn out" data-a="closem">Cancel</button>':""}</div></form>`;
 d.showModal();$("#mf").onsubmit=async e=>{if(!ok){return}e.preventDefault();const v=Object.fromEntries(new FormData($("#mf")));try{const er=await ok(v);if(er){$("#me").textContent=er}else d.close()}catch(error){$("#me").textContent=error.message}}}
const fl=(k,l,t,v="",x="")=>`<label>${l}<input name="${k}" type="${t}" value="${esc(v)}" ${x}></label>`;
const fs=(k,l,o,v)=>`<label>${l}<select name="${k}">${opts(o,v)}</select></label>`;
function info(title,rows){modal(title,`<div class="sum">${rows.map(([a,b])=>`<p><span class="mut">${a}</span><b>${b}</b></p>`).join("")}</div>`)}
const go=h=>{location.hash=h};

/* ---------- layout ---------- */
const NAV={d:[["dash","Dashboard"],["find","Find Parking"],["vehicles","My Vehicles"],["history","Booking History"],["profile","Profile"]],a:[["dash","Overview"],["lots","Parking Lots"],["slots","Slots"],["bookings","Bookings"],["pricing","Pricing"],["payments","Payments"],["audit","Audit Log"]]};
const shell=(r,act,title,h)=>{const u=me();return `<div class="app"><aside class="side"><a class="logo" href="#/"><b>P</b>Smart Parking</a><nav>${NAV[r].map(([k,t])=>`<a href="#/${r}/${k}" class="${act===k?"on":""}">${t}</a>`).join("")}</nav><div class="who">${esc(u.name)}<small>${r==="a"?"Administrator":"Driver"}</small><button class="btn ghost sm" data-a="logout">Log out</button></div></aside><main class="main"><h1>${title}</h1>${h}</main></div>`};
const nf=()=>`<div class="auth"><div class="card"><h2>Page not found</h2><a class="btn" href="#/">Go home</a></div></div>`;

/* ---------- landing + auth ---------- */
function landing(){const sl=db.slots.length,u=me();
 return `<div class="nav"><a class="logo" href="#/"><b>P</b>Smart Parking</a><span class="sp"></span><button class="lk" data-go="how">How it works</button><button class="lk" data-go="feat">Features</button><button class="lk" data-go="ben">Benefits</button>
 ${u?`<a class="btn sm" href="#/${u.role==="admin"?"a":"d"}/dash">Open dashboard</a>`:`<a href="#/login">Driver login</a><a href="#/admin-login">Admin</a><a class="btn sm" href="#/register">Register</a>`}</div>
 <div class="hero"><div><h1>Find it. Book it. Park it.</h1><p>Check live slot availability, reserve a space in advance and pay without queues. Parking owners manage slots, prices and revenue from one dashboard.</p><a class="btn" href="#/d/find">Find Parking</a> <a class="btn ghost" href="#/register">Create account</a></div>
 <div class="demo">${Array.from({length:30},(_,i)=>`<i class="${i%5===0||i%7===3?"o":i%11===4?"r":""}"></i>`).join("")}</div></div>
 <div class="sec" id="how"><h2>How it works</h2><div class="cards">${[["1. Search","Find a lot near you and see free slots live."],["2. Reserve","Pick a green slot, choose time and duration."],["3. Park","Check in on arrival, check out when leaving."],["4. Pay","Pay online and get a digital receipt."]].map(x=>`<div class="card"><h3>${x[0]}</h3><p class="mut">${x[1]}</p></div>`).join("")}</div></div>
 <div class="sec alt" id="feat"><h2>Key features</h2><div class="cards">${[["Live slot map","Colour-coded grid of available, occupied, reserved and maintenance slots."],["Instant fee estimate","Charges are calculated before you confirm."],["Dynamic pricing","Prices rise 20% when a lot is over 80% full."],["Admin dashboard","Revenue charts, bookings, pricing and audit log."]].map(x=>`<div class="card"><h3>${x[0]}</h3><p class="mut">${x[1]}</p></div>`).join("")}</div></div>
 <div class="sec" id="ben"><h2>Benefits</h2><div class="cards" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr))"><div class="card"><h3>For drivers</h3><p class="mut">No circling, no queues, clear prices and receipts, full booking history.</p></div><div class="card"><h3>For parking owners</h3><p class="mut">Track occupancy, set prices, reduce manual errors and see every change in the audit log.</p></div></div></div>
 <div class="sec alt"><h2>Live statistics</h2><div class="stats">${stat("Parking lots",db.lots.length)}${stat("Total slots",sl)}${stat("Free now",db.slots.filter(s=>s.st==="A").length)}${stat("Bookings made",db.bookingCount??db.bookings.length)}</div></div>
 <footer>Smart Parking System, DBMS project demo. Application data is stored in the connected database.</footer>`}
const fld=(n,l,t="text")=>`<label>${l}<input name="${n}" type="${t}" autocomplete="off"></label>`;
function authView(kind){const reg=kind==="register",adm=kind==="admin-login";
 return `<div class="auth"><form class="card" id="af" data-kind="${kind}" novalidate><a href="#/" class="logo dark"><b>P</b>Smart Parking</a><h2>${reg?"Create driver account":adm?"Admin login":"Driver login"}</h2>
 ${reg?fld("name","Full name")+fld("phone","Phone number","tel"):""}${fld("email","Email","email")}
 <label>Password<span class="pw"><input name="pw" type="password" autocomplete="off"><button type="button" class="ghostb" data-a="eye">Show</button></span></label>${reg?fld("pw2","Confirm password","password"):""}
 <div class="err" id="ae"></div><button class="btn full">${reg?"Register":"Log in"}</button>
 <p class="mut sm">${reg?'Have an account? <a href="#/login">Log in</a>':adm?'Demo: admin@parking.com / admin123<br><a href="#/login">Driver login</a>':'Demo: driver@parking.com / driver123<br><a href="#/register">Register</a> · <a href="#/admin-login">Admin login</a>'}</p></form></div>`}
async function submitAuth(f){const v=Object.fromEntries(new FormData(f)),k=f.dataset.kind,er=m=>($("#ae").textContent=m,1);v.email=(v.email||"").trim().toLowerCase();
 if(!/^\S+@\S+\.\S+$/.test(v.email))return er("Enter a valid email address.");if((v.pw||"").length<6)return er("Password must have at least 6 characters.");
 try{
  if(k==="register"){
   if((v.name||"").trim().length<2)return er("Enter your full name.");if(!/^\d{10}$/.test(v.phone||""))return er("Phone must be 10 digits.");if(v.pw!==v.pw2)return er("Passwords do not match.");
   await api("/api/auth/register",{method:"POST",body:JSON.stringify({name:v.name.trim(),phone:v.phone,email:v.email,password:v.pw})});
   await load();toast("Account created");return go("/d/dash");
  }
  await api("/api/auth/login",{method:"POST",body:JSON.stringify({email:v.email,password:v.pw,role:k})});
  await load();go(me().role==="admin"?"/a/dash":"/d/dash");
 }catch(error){return er(error.message)}
}

/* ---------- shared booking pieces ---------- */
const acts=(b,admin)=>btn("det",b.id,"Details","out")+(b.status==="Reserved"&&!admin?btn("cin",b.id,"Check in"):"")+(b.status==="Parked"&&!admin?btn("cout",b.id,"Check out"):"")+(b.status==="Payment Due"&&!admin?btn("payp",b.id,"Pay"):"")+(b.status==="Completed"?btn("rcpt",b.id,"Receipt","navy"):"")+((b.status==="Reserved"||b.status==="Parked")?btn("cancel",b.id,"Cancel","red"):"");
const brow=(b,admin)=>[b.id,esc(lotOf(b.lot)?.name||"Deleted lot"),esc(slotOf(b.slot)?.no||"-"),esc(b.plate),b.date,rs(b.final??b.amt),badge(b.status),acts(b,admin)];
const bhead=["Booking ID","Parking lot","Slot","Vehicle","Date","Amount","Status","Actions"];
function bfilter(list,q,s,d){q=q.toLowerCase();return list.filter(b=>(!s||b.status===s)&&(!d||b.date===d)&&(b.id+(lotOf(b.lot)?.name||"")+b.plate).toLowerCase().includes(q))}
const STAT=["","Reserved","Parked","Payment Due","Completed","Cancelled"];

/* ---------- driver views ---------- */
function dDash(){const u=me(),mine=db.bookings.filter(b=>b.uid===u.id),act=mine.filter(b=>b.status==="Reserved"||b.status==="Parked");
 return shell("d","dash","Welcome, "+esc(u.name.split(" ")[0]),`<div class="stats">${stat("Available slots",db.slots.filter(s=>s.st==="A").length)}${stat("Active bookings",act.length)}${stat("Upcoming reservations",mine.filter(b=>b.status==="Reserved").length)}${stat("Total bookings",mine.length)}</div>
 <div class="grow"><a class="btn" href="#/d/find">Find parking</a><a class="btn navy" href="#/d/vehicles">Add vehicle</a><a class="btn out" href="#/d/history">My bookings</a></div>
 <h3>Active bookings</h3>${tbl(bhead,act.map(b=>brow(b)))}<h3>Recent activity</h3>${tbl(bhead,mine.slice(-5).reverse().map(b=>brow(b)))}`)}
function dVeh(){const v=db.vehicles.filter(x=>x.uid===me().id);
 return shell("d","vehicles","My Vehicles",`<div class="grow"><button class="btn" data-a="addv">Add vehicle</button></div>${tbl(["Registration number","Type","Actions"],v.map(x=>[esc(x.plate),x.type,btn("editv",x.id,"Edit","out")+btn("delv",x.id,"Delete","red")]))}`)}
function dFind(){ui.rl=()=>{const q=ui.q.toLowerCase(),a=db.lots.filter(l=>(l.name+l.addr).toLowerCase().includes(q)&&(!ui.av||free(l.id)>0));
  $("#list").innerHTML=a.length?a.map(l=>`<div class="card"><h3>${esc(l.name)}</h3><p class="mut">${esc(l.addr)}</p><div class="kv"><span>Total slots<b>${inLot(l.id).length}</b></span><span>Available<b class="${free(l.id)?"g":"r"}">${free(l.id)}</b></span><span>${ui.vt} per hour<b>${rs(rate(l.id,ui.vt))}${surge(l.id)?` <s class="mut sm">${rs(db.prices[ui.vt])}</s>`:""}</b></span></div>${btn("openlot",l.id,"View slots")}</div>`).join(""):'<p class="mut">No parking lots match your search.</p>'};post=ui.rl;
 return shell("d","find","Find Parking",`<div class="bar"><input placeholder="Search by location or name" data-f="q" value="${esc(ui.q)}"><select data-f="vt">${opts(TYPES,ui.vt)}</select><select data-f="av">${opts([["","All lots"],["1","Only with free slots"]],ui.av)}</select></div><div class="cards" id="list"></div>`)}
function bookPanel(l){const s=ui.sel&&slotOf(ui.sel),vs=db.vehicles.filter(v=>v.uid===me().id);if(!s||s.st!=="A")return `<h3>Book a slot</h3><p class="mut">Tap a green slot to start your booking.</p>`;
 if(!vs.length)return `<h3>Slot ${s.no}</h3><p class="mut">Add a vehicle first.</p><a class="btn" href="#/d/vehicles">Add vehicle</a>`;
 const k=ui.bk,v=vs.find(x=>x.id==k.v)||vs[0],hrs=+k.hrs||1,r=rate(l.id,v.type),tot=r*hrs;
 return `<h3>Book slot ${s.no}</h3><label>Vehicle<select data-b="v">${opts(vs.map(x=>[x.id,x.plate+" ("+x.type+")"]),v.id)}</select></label><label>Date<input type="date" data-b="date" min="${today()}" value="${k.date||today()}"></label><label>Start time<input type="time" data-b="start" value="${k.start||"10:00"}"></label>
 <label>Duration<select data-b="hrs">${opts([1,2,3,4,6,8,12,24].map(h=>[h,h+" hour"+(h>1?"s":"")]),hrs)}</select></label>
 <div class="sum"><p><span>Rate per hour</span><b>${rs(r)}${surge(l.id)?` <s class="mut sm">${rs(db.prices[v.type])}</s>`:""}</b></p><p><span>Duration</span><b>${hrs} h</b></p><p class="tot"><span>Estimated total</span><span>${rs(tot)}</span></p></div><button class="btn full" data-a="book" data-id="${l.id}">Confirm booking</button>`}
function dLot(id){const l=lotOf(id);if(!l)return nf();
 return shell("d","find",esc(l.name),`<p class="mut">${esc(l.addr)} · ${inLot(l.id).length} slots · ${free(l.id)} available · ${Math.round(occ(l.id)*100)}% full</p>${surge(l.id)?'<div class="note">High demand: prices are 20% higher while this lot is over 80% full.</div>':""}
 <div class="two"><div class="card"><div class="grid">${inLot(l.id).map(s=>`<button class="slot ${s.st}${ui.sel===s.id?" sel":""}" data-a="pick" data-id="${s.id}" title="Slot ${s.no}">${s.no}</button>`).join("")}</div>${legend}</div><div class="card" id="bp">${bookPanel(l)}</div></div>`)}
function dConfirm(id){const b=bkOf(id);if(!b)return nf();return shell("d","history","Booking confirmed",`<div class="card rc"><h2 class="g">Booking ID ${b.id}</h2><div class="sum">${[["Parking lot",esc(lotOf(b.lot).name)],["Slot",slotOf(b.slot).no],["Vehicle",esc(b.plate)],["Date and time",b.date+" "+b.start],["Duration",b.hrs+" h"],["Estimated charge",rs(b.amt)]].map(x=>`<p><span class="mut">${x[0]}</span><b>${x[1]}</b></p>`).join("")}</div><p class="mut sm">Check in when you arrive. Your final amount is set at check-out.</p><a class="btn full" href="#/d/history">View my bookings</a></div>`)}
function dPay(id){const b=bkOf(id);if(!b)return nf();if(b.status!=="Payment Due")return shell("d","history","Payment",`<div class="card rc"><p>Nothing to pay for booking ${b.id} (status: ${b.status}).</p><a class="btn" href="#/d/history">Back to bookings</a></div>`);const amt=b.final??b.amt;
 return shell("d","history","Payment",`<div class="card rc"><h2>Pay ${rs(amt)}</h2><p class="mut" style="text-align:center">Booking ${b.id} · ${b.ahrs??b.hrs} hour(s) at ${rs(b.rate)}</p><form id="pf"><label>Payment method<select name="m">${opts(["UPI","Card","Cash"])}</select></label><p class="mut sm">Demo only. Never enter real card details here.</p><button class="btn full" data-ok="1">Pay now</button><button type="button" class="btn red full" data-a="payfail" data-id="${b.id}">Simulate failed payment</button></form></div>`)}
function dRcpt(id){const b=bkOf(id),p=db.pay.find(x=>x.bid===id&&x.status==="Success");if(!b||!p)return nf();
 return shell("d","history","Digital receipt",`<div class="card rc"><h2>Smart Parking Receipt</h2><p class="mut" style="text-align:center">${p.t}</p><div class="sum">${[["Payment reference",p.ref],["Booking ID",b.id],["Parking lot",esc(lotOf(b.lot)?.name||"")],["Slot",slotOf(b.slot)?.no||"-"],["Vehicle",esc(b.plate)],["Duration",(b.ahrs??b.hrs)+" h"],["Rate per hour",rs(b.rate)],["Method",p.method],["Status",p.status]].map(x=>`<p><span class="mut">${x[0]}</span><b>${x[1]}</b></p>`).join("")}<p class="tot"><span>Total paid</span><span>${rs(p.amt)}</span></p></div><div class="grow" style="margin-top:14px"><button class="btn" data-a="print">Print receipt</button><a class="btn out" href="#/d/history">Back</a></div></div>`)}
function dHist(){const u=me();ui.rl=()=>{$("#list").innerHTML=tbl(bhead,bfilter(db.bookings.filter(b=>b.uid===u.id),ui.hq,ui.hs,"").slice().reverse().map(b=>brow(b)))};post=ui.rl;
 return shell("d","history","Booking History",`<div class="bar"><input placeholder="Search by ID, lot or vehicle" data-f="hq" value="${esc(ui.hq)}"><select data-f="hs">${opts(STAT.map(s=>[s,s||"All statuses"]),ui.hs)}</select></div><div id="list"></div>`)}
function dProf(){const u=me();return shell("d","profile","Profile",`<div class="two"><div class="card"><h3>Your details</h3><p class="mut">${esc(u.email)}</p><div class="sum"><p><span>Name</span><b>${esc(u.name)}</b></p><p><span>Phone</span><b>${esc(u.phone)}</b></p></div><button class="btn" data-a="editp">Edit profile</button> <button class="btn out" data-a="pwd">Change password</button></div>
 <div class="card"><h3>Vehicles</h3>${db.vehicles.filter(v=>v.uid===u.id).map(v=>`<p>${esc(v.plate)} <span class="mut">(${v.type})</span></p>`).join("")||'<p class="mut">None added.</p>'}<a class="btn navy" href="#/d/vehicles">Manage vehicles</a></div></div>`)}

/* ---------- admin views ---------- */
function aDash(){const S=db.slots,c=t=>S.filter(s=>s.st===t).length,rev=db.pay.filter(p=>p.status==="Success").reduce((a,p)=>a+p.amt,0),usable=S.filter(s=>s.st!=="M").length,act=db.bookings.filter(b=>b.status==="Reserved"||b.status==="Parked").length;
 post=()=>{if(!window.Chart){$("#ch").innerHTML='<p class="mut">Charts need an internet connection to load Chart.js.</p>';return}
  const names=db.lots.map(l=>l.name),rv=db.lots.map(l=>db.pay.filter(p=>p.status==="Success"&&bkOf(p.bid)?.lot===l.id).reduce((a,p)=>a+p.amt,0));
  charts.push(new Chart($("#c1"),{type:"bar",data:{labels:names,datasets:[{label:"Revenue (Rs)",data:rv,backgroundColor:"#1fa971"}]},options:{plugins:{legend:{display:false}}}}));
  charts.push(new Chart($("#c2"),{type:"doughnut",data:{labels:["Available","Occupied","Reserved","Maintenance"],datasets:[{data:["A","O","R","M"].map(c),backgroundColor:["#1fa971","#d9484a","#2f6fd6","#8b97a4"]}]}}))};
 return shell("a","dash","Overview",`<div class="stats">${stat("Parking lots",db.lots.length)}${stat("Total slots",S.length)}${stat("Available",c("A"))}${stat("Occupied",c("O"))}${stat("Reserved",c("R"))}${stat("Active bookings",act)}${stat("Total revenue",rs(rev))}${stat("Occupancy",usable?Math.round((c("O")+c("R"))/usable*100)+"%":"0%")}</div>
 <div class="two" id="ch"><div class="card"><h3>Revenue by lot</h3><canvas id="c1"></canvas></div><div class="card"><h3>Slot status</h3><canvas id="c2"></canvas></div></div><h3>Recent transactions</h3>${tbl(["Reference","Booking","Amount","Method","Status","Time"],db.pay.slice().reverse().slice(0,6).map(p=>[p.ref,p.bid,rs(p.amt),p.method,badge(p.status),p.t]))}`)}
function aLots(){return shell("a","lots","Parking Lots",`<div class="grow"><button class="btn" data-a="addlot">Add parking lot</button></div>${tbl(["Name","Address","Slots","Available","Occupancy","Actions"],db.lots.map(l=>[esc(l.name),esc(l.addr),inLot(l.id).length,free(l.id),Math.round(occ(l.id)*100)+"%",btn("lotinfo",l.id,"View","out")+btn("editlot",l.id,"Edit","out")+btn("dellot",l.id,"Delete","red")]))}`)}
function aSlots(){const id=ui.ls||db.lots[0]?.id,sl=inLot(id);
 return shell("a","slots","Slot Management",`<div class="bar"><select data-f="ls">${opts(db.lots.map(l=>[l.id,l.name]),id)}</select><button class="btn" data-a="addslot" data-id="${id}">Add slot</button></div>${tbl(["Slot","Status","Actions"],sl.map(s=>[s.no,badge({A:"Available",O:"Occupied",R:"Reserved",M:"Maintenance"}[s.st]),btn("editslot",s.id,"Edit","out")+btn("maint",s.id,s.st==="M"?"Restore":"Maintenance","navy")]))}`)}
function aBook(){ui.rl=()=>{$("#list").innerHTML=tbl(bhead.map(h=>h),bfilter(db.bookings,ui.bq,ui.bs,ui.bd).slice().reverse().map(b=>brow(b,1)))};post=ui.rl;
 return shell("a","bookings","All Bookings",`<div class="bar"><input placeholder="Search by ID, lot or vehicle" data-f="bq" value="${esc(ui.bq)}"><select data-f="bs">${opts(STAT.map(s=>[s,s||"All statuses"]),ui.bs)}</select><input type="date" data-f="bd" value="${ui.bd}"></div><div id="list"></div>`)}
function aPrice(){return shell("a","pricing","Pricing",`<div class="card"><h3>Base hourly price</h3><form id="prf"><div class="stats">${TYPES.map(t=>`<label>${t} (Rs per hour)<input type="number" min="1" name="${t}" value="${db.prices[t]}"></label>`).join("")}</div><button class="btn">Save prices</button></form></div>
 <h3>Current pricing by lot</h3><p class="mut sm">Dynamic pricing adds 20% when occupancy is above 80%.</p>${tbl(["Lot","Occupancy",...TYPES.map(t=>t+" (original → now)")],db.lots.map(l=>[esc(l.name),Math.round(occ(l.id)*100)+"%"+(surge(l.id)?' <span class="bd Parked">Surge</span>':""),...TYPES.map(t=>surge(l.id)?`${rs(db.prices[t])} → <b>${rs(rate(l.id,t))}</b>`:rs(db.prices[t]))]))}`)}
const aPay=()=>shell("a","payments","Payments",tbl(["Reference","Booking","Amount","Method","Status","Date and time"],db.pay.slice().reverse().map(p=>[p.ref,p.bid,rs(p.amt),p.method,badge(p.status),p.t])));
const aAud=()=>shell("a","audit","Audit Log",tbl(["Time","By","Action"],db.audit.map(a=>[a.t,esc(a.who),esc(a.msg)])));

/* ---------- router ---------- */
function render(){charts.forEach(c=>c.destroy());charts=[];post=null;ui.rl=null;
 const p=(location.hash.replace(/^#\/?/,"")||"").split("/"),u=me();let h;
 if(p[0]==="d"||p[0]==="a"){if(!u||u.role!==(p[0]==="a"?"admin":"driver")){go(p[0]==="a"?"/admin-login":"/login");return}}
 const V={"":landing,login:()=>authView("login"),register:()=>authView("register"),"admin-login":()=>authView("admin-login"),
  "d/dash":dDash,"d/vehicles":dVeh,"d/find":dFind,"d/lot":()=>dLot(p[2]),"d/confirm":()=>dConfirm(p[2]),"d/pay":()=>dPay(p[2]),"d/receipt":()=>dRcpt(p[2]),"d/history":dHist,"d/profile":dProf,
  "a/dash":aDash,"a/lots":aLots,"a/slots":aSlots,"a/bookings":aBook,"a/pricing":aPrice,"a/payments":aPay,"a/audit":aAud};
 const k=p[0]==="d"||p[0]==="a"?p[0]+"/"+(p[1]||"dash"):p[0];
 try{h=(V[k]||nf)()}catch(e){console.error(e);h=nf()}
 $("#app").innerHTML=h;window.scrollTo(0,0);post&&post()}
const rerender=()=>{const y=scrollY;render();scrollTo(0,y)};

/* ---------- actions ---------- */
const A={
 async logout(){try{await api("/api/auth/logout",{method:"POST"});await load();go("/")}catch(error){toast(error.message,1)}},
 eye(i,t){const f=t.previousElementSibling;f.type=f.type==="password"?"text":"password";t.textContent=f.type==="password"?"Show":"Hide"},
 closem(){$("#dlg").close()},print(){window.print()},
 openlot(id){ui.sel=null;ui.bk={};go("/d/lot/"+id)},
 pick(id){const s=slotOf(id);if(s.st!=="A")return toast("Slot "+s.no+" is not available",1);ui.sel=s.id;rerender()},
 book(id){const l=lotOf(id),s=slotOf(ui.sel),vs=db.vehicles.filter(v=>v.uid===me().id),k=ui.bk,v=vs.find(x=>x.id==k.v)||vs[0],hrs=+k.hrs||1,date=k.date||today();
  if(!s||s.st!=="A"){ui.sel=null;rerender();return toast("That slot was just taken. Please pick another.",1)}if(date<today())return toast("Choose today or a future date",1);
  const r=rate(l.id,v.type),b={id:tid("BK"),uid:me().id,lot:l.id,slot:s.id,plate:v.plate,type:v.type,date,start:k.start||"10:00",hrs,rate:r,amt:r*hrs,status:"Reserved"};
  db.bookings.push(b);s.st="R";log(me().name,`Booking ${b.id} created for slot ${s.no}`);ui.sel=null;ui.bk={};toast("Booking confirmed");go("/d/confirm/"+b.id)},
 det(id){const b=bkOf(id);info("Booking "+b.id,[["Parking lot",esc(lotOf(b.lot)?.name||"-")],["Slot",slotOf(b.slot)?.no||"-"],["Vehicle",esc(b.plate)+" ("+b.type+")"],["Date and time",b.date+" "+b.start],["Booked duration",b.hrs+" h"],["Rate per hour",rs(b.rate)],["Amount",rs(b.final??b.amt)],["Check-in",b.cin||"-"],["Status",b.status]])},
 cin(id){const b=bkOf(id);b.status="Parked";b.cin=stamp();slotOf(b.slot).st="O";log(me().name,`Check-in ${b.id}`);toast("Checked in");rerender()},
 cout(id){const b=bkOf(id);modal("Check out "+b.id,`<p class="mut">Checked in at ${b.cin}. For this demo, enter the hours you parked.</p>${fl("h","Hours parked","number",b.hrs,'min="1" max="72" step="1"')}`,v=>{const h=Math.floor(+v.h);if(!(h>=1&&h<=72))return "Enter hours between 1 and 72.";
  b.ahrs=h;b.final=b.rate*h;b.status="Payment Due";slotOf(b.slot).st="A";log(me().name,`Check-out ${b.id}, ${rs(b.final)}`);go("/d/pay/"+id)},"Calculate amount")},
 payp(id){go("/d/pay/"+id)},rcpt(id){go("/d/receipt/"+id)},
 payfail(id){const b=bkOf(id);db.pay.push({ref:tid("PAY"),bid:id,amt:b.final??b.amt,method:$("#pf").m.value,status:"Failed",t:stamp()});log(me().name,`Payment failed for ${id}`);toast("Payment failed. Please try again.",1)},
 cancel(id){const b=bkOf(id);if(!confirm("Cancel booking "+b.id+"?"))return;b.status="Cancelled";const s=slotOf(b.slot);if(s)s.st="A";log(me().name,`Booking ${b.id} cancelled`);toast("Booking cancelled");rerender()},
 addv(){modal("Add vehicle",fl("plate","Registration number","text")+fs("type","Type",TYPES),v=>{const p=v.plate.trim().toUpperCase();if(p.length<4)return "Enter a valid registration number.";if(db.vehicles.some(x=>x.plate===p))return "Vehicle already added.";db.vehicles.push({id:Date.now(),uid:me().id,plate:p,type:v.type});log(me().name,"Vehicle added "+p);rerender()},"Add")},
 editv(id){const x=db.vehicles.find(v=>v.id==id);modal("Edit vehicle",fl("plate","Registration number","text",x.plate)+fs("type","Type",TYPES,x.type),v=>{const p=v.plate.trim().toUpperCase();if(p.length<4)return "Enter a valid registration number.";x.plate=p;x.type=v.type;save();rerender()})},
 delv(id){if(!confirm("Delete this vehicle?"))return;db.vehicles=db.vehicles.filter(v=>v.id!=id);save();toast("Vehicle deleted");rerender()},
 editp(){const u=me();modal("Edit profile",fl("name","Name","text",u.name)+fl("phone","Phone","tel",u.phone),async v=>{if(v.name.trim().length<2)return "Enter your name.";if(!/^\d{10}$/.test(v.phone))return "Phone must be 10 digits.";const result=await api("/api/profile",{method:"PUT",body:JSON.stringify({name:v.name.trim(),phone:v.phone})});db.users=[result.user];log(result.user.name,"Profile updated");rerender()})},
 pwd(){modal("Change password",fl("o","Current password","password")+fl("n","New password","password"),async v=>{if(v.n.length<6)return "Use at least 6 characters.";await api("/api/profile/password",{method:"POST",body:JSON.stringify({current:v.o,new:v.n})});log(me().name,"Password changed");toast("Password changed")})},
 addlot(){modal("Add parking lot",fl("name","Name","text")+fl("addr","Address","text")+fl("n","Number of slots","number",12,'min="1" max="60"'),v=>{const n=+v.n;if(!v.name.trim()||!v.addr.trim())return "Name and address are required.";if(!(n>=1&&n<=60))return "Slots must be 1 to 60.";
  const id=Math.max(0,...db.lots.map(l=>l.id))+1;db.lots.push({id,name:v.name.trim(),addr:v.addr.trim()});for(let i=0;i<n;i++)db.slots.push({id:id*100+i,lot:id,no:"ABCDEFG"[i>>3]+(i%8+1),st:"A"});log(me().name,`Lot added: ${v.name}`);rerender()},"Add lot")},
 editlot(id){const l=lotOf(id);modal("Edit parking lot",fl("name","Name","text",l.name)+fl("addr","Address","text",l.addr),v=>{if(!v.name.trim()||!v.addr.trim())return "Name and address are required.";l.name=v.name.trim();l.addr=v.addr.trim();log(me().name,`Lot edited: ${l.name}`);rerender()})},
 lotinfo(id){const l=lotOf(id);info(esc(l.name),[["Address",esc(l.addr)],["Total slots",inLot(id).length],["Available",free(id)],["Occupancy",Math.round(occ(id)*100)+"%"],["Pricing",surge(id)?"Surge (+20%)":"Normal"]])},
 dellot(id){const l=lotOf(id);if(db.bookings.some(b=>b.lot==id&&(b.status==="Reserved"||b.status==="Parked")))return toast("Cannot delete: this lot has active bookings",1);if(!confirm("Delete "+l.name+" and all its slots?"))return;
  db.lots=db.lots.filter(x=>x.id!=id);db.slots=db.slots.filter(s=>s.lot!=id);ui.ls=0;log(me().name,`Lot deleted: ${l.name}`);rerender()},
 addslot(id){const sl=inLot(id),n=sl.length+1,no="ABCDEFGH"[(n-1)>>3]+((n-1)%8+1);let nid=id*100+n-1;while(slotOf(nid))nid++;db.slots.push({id:nid,lot:+id,no,st:"A"});log(me().name,`Slot ${no} added to ${lotOf(id).name}`);rerender()},
 editslot(id){const s=slotOf(id);modal("Edit slot",fl("no","Slot number","text",s.no)+fs("st","Status",[["A","Available"],["O","Occupied"],["R","Reserved"],["M","Maintenance"]],s.st),v=>{if(!v.no.trim())return "Slot number is required.";s.no=v.no.trim().toUpperCase();s.st=v.st;log(me().name,`Slot ${s.no} updated, status ${v.st}`);rerender()})},
 maint(id){const s=slotOf(id);if(s.st==="O"||s.st==="R")return toast("Slot is in use and cannot go to maintenance",1);s.st=s.st==="M"?"A":"M";log(me().name,`Slot ${s.no} ${s.st==="M"?"set to maintenance":"restored"}`);rerender()}};

document.addEventListener("click",e=>{const t=e.target.closest("[data-a]");if(t){const f=A[t.dataset.a];if(f){e.preventDefault();f(t.dataset.id,t)}}const g=e.target.closest("[data-go]");if(g)document.getElementById(g.dataset.go)?.scrollIntoView({behavior:"smooth"})});
document.addEventListener("input",e=>{const k=e.target.dataset.f;if(k&&["q","hq","bq"].includes(k)){ui[k]=e.target.value;ui.rl&&ui.rl()}});
document.addEventListener("change",e=>{const t=e.target,k=t.dataset.f,b=t.dataset.b;
 if(k){ui[k]=t.value;if(k==="ls")ui.ls=+t.value;ui.rl?ui.rl():rerender()}
 if(b){ui.bk[b]=t.value;const l=lotOf(location.hash.split("/")[3]);if(l)$("#bp").innerHTML=bookPanel(l)}});
document.addEventListener("submit",e=>{const f=e.target;if(f.id==="af"){e.preventDefault();submitAuth(f)}
 if(f.id==="pf"){e.preventDefault();const id=location.hash.split("/")[3],b=bkOf(id),amt=b.final??b.amt,ref=tid("PAY");db.pay.push({ref,bid:id,amt,method:f.m.value,status:"Success",t:stamp()});b.status="Completed";b.final=amt;log(me().name,`Payment ${ref} of ${rs(amt)} for ${id}`);toast("Payment successful");go("/d/receipt/"+id)}
 if(f.id==="prf"){e.preventDefault();const v=Object.fromEntries(new FormData(f));if(TYPES.some(t=>!(+v[t]>0)))return toast("Enter valid prices",1);TYPES.forEach(t=>db.prices[t]=+v[t]);log(me().name,"Base prices updated");toast("Prices saved");rerender()}});
window.addEventListener("hashchange",render);
async function init(){
 try{await load();render()}
 catch(error){console.error(error);$("#app").innerHTML=`<div class="auth"><div class="card"><h2>Backend unavailable</h2><p class="mut">${esc(error.message)}</p><p class="mut">Start the Flask server and check its PostgreSQL connection, then refresh.</p></div></div>`}
}
init();
