const $=id=>document.getElementById(id);
const DBKEY="snapclean-v01";
let data=JSON.parse(localStorage.getItem(DBKEY)||'{"friends":[],"history":[],"filter":"Priority cleanup"}');
let queue=[], qi=0;

const filters=["Priority cleanup","Likely never became friends","Former friends • not current","Sent request • not current","Pending requests","Current friends","No chat / Snap history","Inactive 6+ months","Inactive 1+ year","Inactive 2+ years","Remove queue","Later queue","Unreviewed"];
filters.forEach(x=>$("filter").add(new Option(x,x)));
$("filter").value=data.filter||filters[0];

function save(){localStorage.setItem(DBKEY,JSON.stringify(data))}
function parseDate(s){if(!s)return null;let d=new Date(s.replace(" UTC","Z").replace(" ","T"));return isNaN(d)?null:d.getTime()}
function ageDays(t){return t?Math.floor((Date.now()-t)/86400000):null}
function flags(f){return new Set(f.flags||[])}
function score(f){let x=0,fs=flags(f),days=ageDays(f.lastInteraction);
 if(fs.has("SENT_REQUEST")&&!fs.has("CURRENT_FRIEND")&&!fs.has("DELETED_FRIEND"))x=100;
 else if(fs.has("DELETED_FRIEND")&&!fs.has("CURRENT_FRIEND"))x=94;
 else if(fs.has("PENDING_REQUEST")&&!fs.has("CURRENT_FRIEND"))x=90;
 else if(fs.has("SENT_REQUEST")&&!fs.has("CURRENT_FRIEND"))x=88;
 else if(fs.has("CURRENT_FRIEND")&&!f.lastInteraction)x=75;
 else if(days!=null&&days>730)x=70; else if(days!=null&&days>365)x=60; else if(days!=null&&days>180)x=50;
 return x}
function state(f){let fs=flags(f);if(fs.has("SENT_REQUEST")&&!fs.has("CURRENT_FRIEND")&&!fs.has("DELETED_FRIEND"))return"NO RECORDED FRIENDSHIP";if(fs.has("DELETED_FRIEND")&&!fs.has("CURRENT_FRIEND"))return"FORMER FRIEND";if(fs.has("PENDING_REQUEST"))return"PENDING REQUEST";if(fs.has("CURRENT_FRIEND"))return"CURRENT FRIEND";return"OTHER"}
function signal(f){let d=ageDays(f.lastInteraction);if(!f.lastInteraction)return"No recorded chat/Snap activity";if(d===0)return"Today";if(d<30)return`${d} days ago`;if(d<365)return`${Math.floor(d/30)} months ago`;return`${(d/365).toFixed(1)} years ago`}
function matches(f,fil){let fs=flags(f),d=ageDays(f.lastInteraction);switch(fil){
 case"Likely never became friends":return fs.has("SENT_REQUEST")&&!fs.has("CURRENT_FRIEND")&&!fs.has("DELETED_FRIEND");
 case"Former friends • not current":return fs.has("DELETED_FRIEND")&&!fs.has("CURRENT_FRIEND");
 case"Sent request • not current":return fs.has("SENT_REQUEST")&&!fs.has("CURRENT_FRIEND");
 case"Pending requests":return fs.has("PENDING_REQUEST");
 case"Current friends":return fs.has("CURRENT_FRIEND");
 case"No chat / Snap history":return fs.has("CURRENT_FRIEND")&&!f.lastInteraction;
 case"Inactive 6+ months":return d!=null&&d>180;
 case"Inactive 1+ year":return d!=null&&d>365;
 case"Inactive 2+ years":return d!=null&&d>730;
 case"Remove queue":return f.decision==="REMOVE";
 case"Later queue":return f.decision==="LATER";
 case"Unreviewed":return !f.decision||f.decision==="PENDING";
 default:return true}}
function rebuild(){data.filter=$("filter").value;save();queue=data.friends.filter(f=>matches(f,data.filter)).sort((a,b)=>score(b)-score(a));qi=0;render()}
function fmt(t){return t?new Date(t).toLocaleDateString(): "None found"}
function render(){if(!data.friends.length){$("setup").classList.remove("hidden");$("review").classList.add("hidden");return}
 $("setup").classList.add("hidden");$("review").classList.remove("hidden");
 let f=queue[qi];$("progress").textContent=queue.length?`${qi+1} / ${queue.length}`:"0 / 0";
 if(!f){$("displayName").textContent="Queue complete";$("username").textContent="";$("state").textContent="";$("score").textContent="";$("facts").innerHTML="";$("openProfile").disabled=true;return}
 $("openProfile").disabled=false;$("displayName").textContent=f.displayName||f.username;$("username").textContent="@"+f.username;$("state").textContent=state(f);$("score").textContent=`Priority ${score(f)}/100`;
 $("facts").innerHTML=`<div><dt>Friend since</dt><dd>${fmt(f.friendshipStart)}</dd></div><div><dt>Last activity</dt><dd>${signal(f)}</dd></div><div><dt>Source</dt><dd>${esc(f.source||"Unknown")}</dd></div><div><dt>Decision</dt><dd>${f.decision||"Unreviewed"}</dd></div>`}
function esc(s){return String(s).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]))}
function decide(d){let f=queue[qi];if(!f)return;data.history.push({u:f.username,prev:f.decision||"PENDING"});f.decision=d;save();qi++;render()}
$("remove").onclick=()=>decide("REMOVE");$("later").onclick=()=>decide("LATER");$("keep").onclick=()=>decide("KEEP");
$("undo").onclick=()=>{let h=data.history.pop();if(!h)return;let f=data.friends.find(x=>x.username===h.u);if(f)f.decision=h.prev;save();rebuild()};
$("filter").onchange=rebuild;
$("openProfile").onclick=()=>{let f=queue[qi];if(f)location.href=`https://www.snapchat.com/add/${encodeURIComponent(f.username)}`};
$("settingsBtn").onclick=()=>{$("drawer").classList.remove("hidden");stats()};
$("closeDrawer").onclick=()=>$("drawer").classList.add("hidden");
$("reimport").onclick=()=>{$("drawer").classList.add("hidden");$("zipInput").click()};
$("resetAll").onclick=()=>{if(confirm("Delete all SnapClean local data?")){localStorage.removeItem(DBKEY);location.reload()}};
$("exportDecisions").onclick=()=>{let rows=[["username","display_name","decision","state","priority"],...data.friends.map(f=>[f.username,f.displayName,f.decision||"PENDING",state(f),score(f)])];let csv=rows.map(r=>r.map(v=>`"${String(v??"").replaceAll('"','""')}"`).join(",")).join("\n");let a=document.createElement("a");a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));a.download="snapclean-decisions.csv";a.click()};
function stats(){let c=x=>data.friends.filter(f=>f.decision===x).length;$("stats").textContent=`${data.friends.length} people loaded\n${c("KEEP")} keep\n${c("REMOVE")} remove\n${c("LATER")} later\n${data.friends.filter(f=>!f.decision||f.decision==="PENDING").length} unreviewed`}

function tableAfterHeading(doc,name){let hs=[...doc.querySelectorAll("h1,h2,h3,h4")];let h=hs.find(x=>x.textContent.trim()===name);if(!h)return null;let n=h.nextElementSibling;while(n&&n.tagName!=="TABLE")n=n.nextElementSibling;return n}
function parseFriends(html,old){let doc=new DOMParser().parseFromString(html,"text/html"), map=new Map();
 let cats=[["Friends","CURRENT_FRIEND"],["Friend Requests Sent","SENT_REQUEST"],["Blocked Users","BLOCKED"],["Deleted Friends","DELETED_FRIEND"],["Hidden Friend Suggestions","HIDDEN_SUGGESTION"],["Ignored Snapchatters","IGNORED"],["Pending Requests","PENDING_REQUEST"]];
 for(let [heading,flag] of cats){let t=tableAfterHeading(doc,heading);if(!t)continue;for(let tr of [...t.querySelectorAll("tr")].slice(1)){let td=[...tr.querySelectorAll("td")].map(x=>x.textContent.trim());if(!td[0])continue;let k=td[0].toLowerCase(),f=map.get(k)||{username:td[0],displayName:td[1]||td[0],flags:[],decision:old[k]||"PENDING"};if(!f.flags.includes(flag))f.flags.push(flag);if(flag==="CURRENT_FRIEND")f.friendshipStart=parseDate(td[2]);if(!f.friendshipStart&&flag==="DELETED_FRIEND")f.friendshipStart=parseDate(td[2]);if(td[4]&&!f.source)f.source=td[4];map.set(k,f)}}
 return map}
function historyMap(html,prefix){let doc=new DOMParser().parseFromString(html,"text/html"),m={};for(let b of doc.querySelectorAll("button.single_chat")){let label=b.textContent.trim();if(!label.startsWith(prefix))continue;let mm=b.getAttribute("onclick")?.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/);if(mm)m["html/"+mm[1]]=label.slice(prefix.length).trim().toLowerCase()}return m}
function latestTimestamp(html){let ms=[...html.matchAll(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/g)].map(x=>parseDate(x[0])).filter(Boolean);return ms.length?Math.max(...ms):null}
async function importZip(file){if(!window.fflate)throw Error("ZIP library did not load. Check internet and reopen SnapClean.");let buf=new Uint8Array(await file.arrayBuffer());let z=fflate.unzipSync(buf);let text=p=>z[p]?fflate.strFromU8(z[p]):null;let fh=text("html/friends.html");if(!fh)throw Error("html/friends.html not found in this Snapchat export.");
 let old=Object.fromEntries(data.friends.map(f=>[f.username.toLowerCase(),f.decision||"PENDING"]));let map=parseFriends(fh,old);
 let cm=historyMap(text("html/chat_history.html")||"","Chat History with ");let sm=historyMap(text("html/snap_history.html")||"","Snap History with ");
 let matched=0;for(let [path,u] of Object.entries({...cm,...sm})){let raw=text(path);let f=map.get(u);if(raw&&f){let t=latestTimestamp(raw);if(t&&(!f.lastInteraction||t>f.lastInteraction))f.lastInteraction=t;matched++}}
 data.friends=[...map.values()];data.history=[];save();return {count:data.friends.length,matched}}
$("zipInput").onchange=async e=>{let f=e.target.files[0];if(!f)return;$("importStatus").textContent="Reading Snapchat export…";try{let r=await importZip(f);$("importStatus").textContent=`Imported ${r.count.toLocaleString()} people.\nMatched ${r.matched.toLocaleString()} chat/Snap history pages.`;rebuild()}catch(err){$("importStatus").textContent="Import failed: "+err.message}};
if("serviceWorker"in navigator)navigator.serviceWorker.register("sw.js").catch(()=>{});
rebuild();
