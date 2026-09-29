const STORAGE_KEY='dearMessageStateV1';
const defaultState={
  character:{name:'',avatar:''},
  groups:[
    {id:crypto.randomUUID(),name:'아침',start:'07:00',end:'10:00',dailyCount:1,enabled:true,messages:[],sentToday:[]},
    {id:crypto.randomUUID(),name:'점심',start:'11:30',end:'14:00',dailyCount:1,enabled:false,messages:[],sentToday:[]},
    {id:crypto.randomUUID(),name:'저녁',start:'18:00',end:'21:00',dailyCount:1,enabled:false,messages:[],sentToday:[]},
    {id:crypto.randomUUID(),name:'밤',start:'22:00',end:'01:00',dailyCount:1,enabled:false,messages:[],sentToday:[]}
  ],
  history:[],
  recentMessages:[],
  settings:{avoidRecent:true,recentCount:3,checkInterval:5},
  lastResetDate:''
};
let state=loadState();
let deferredPrompt=null;
let timer=null;

const $=s=>document.querySelector(s); const $$=s=>[...document.querySelectorAll(s)];
function loadState(){try{const saved=JSON.parse(localStorage.getItem(STORAGE_KEY));return saved?mergeDefaults(saved):structuredClone(defaultState)}catch{return structuredClone(defaultState)}}
function mergeDefaults(saved){return {...structuredClone(defaultState),...saved,character:{...defaultState.character,...(saved.character||{})},settings:{...defaultState.settings,...(saved.settings||{})},groups:Array.isArray(saved.groups)?saved.groups:structuredClone(defaultState.groups),history:Array.isArray(saved.history)?saved.history:[],recentMessages:Array.isArray(saved.recentMessages)?saved.recentMessages:[]}}
function save(){localStorage.setItem(STORAGE_KEY,JSON.stringify(state));renderAll();}
function todayKey(){const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
function resetDailyIfNeeded(){const t=todayKey();if(state.lastResetDate!==t){state.groups.forEach(g=>g.sentToday=[]);state.lastResetDate=t;localStorage.setItem(STORAGE_KEY,JSON.stringify(state));}}
function mins(t){const [h,m]=t.split(':').map(Number);return h*60+m}
function inWindow(start,end,date=new Date()){const now=date.getHours()*60+date.getMinutes(),s=mins(start),e=mins(end);return s<=e?(now>=s&&now<=e):(now>=s||now<=e)}
function eligibleGroups(){resetDailyIfNeeded();return state.groups.filter(g=>g.enabled&&g.messages?.length&&inWindow(g.start,g.end)&&(g.sentToday?.length||0)<Number(g.dailyCount||1))}
function chooseMessage(group){let pool=[...group.messages];if(state.settings.avoidRecent){const recent=new Set(state.recentMessages.slice(-Number(state.settings.recentCount||0)));const fresh=pool.filter(m=>!recent.has(m));if(fresh.length)pool=fresh}return pool[Math.floor(Math.random()*pool.length)]}
function showToast(msg){const t=$('#toast');t.textContent=msg;t.classList.add('show');clearTimeout(t._x);t._x=setTimeout(()=>t.classList.remove('show'),2200)}
async function notify(group,message){const title=state.character.name||'새 메시지';const options={body:message,icon:state.character.avatar||'./icon-192.png',badge:'./icon-192.png',tag:`${group.id}-${Date.now()}`,data:{groupId:group.id}};if('serviceWorker'in navigator){const reg=await navigator.serviceWorker.ready;await reg.showNotification(title,options)}else if('Notification'in window&&Notification.permission==='granted'){new Notification(title,options)}
  const item={id:crypto.randomUUID(),groupId:group.id,groupName:group.name,message,ts:Date.now()};state.history.unshift(item);group.sentToday=group.sentToday||[];group.sentToday.push(item.id);state.recentMessages.push(message);state.recentMessages=state.recentMessages.slice(-50);localStorage.setItem(STORAGE_KEY,JSON.stringify(state));renderAll();
}
async function requestPermission(){if(!('Notification'in window)){showToast('이 브라우저는 알림을 지원하지 않아.');return}const p=await Notification.requestPermission();renderPermission();showToast(p==='granted'?'알림이 허용됐어.':'알림 권한이 허용되지 않았어.');}
async function sendRandomTest(){const pool=state.groups.filter(g=>g.enabled&&g.messages?.length);if(!pool.length){showToast('먼저 활성 그룹에 대사를 추가해줘.');return}if(!('Notification'in window)||Notification.permission!=='granted'){await requestPermission();if(Notification.permission!=='granted')return}const g=pool[Math.floor(Math.random()*pool.length)];await notify(g,chooseMessage(g));}
async function checkDue({manual=false}={}){resetDailyIfNeeded();const groups=eligibleGroups();if(!groups.length){if(manual)showToast('지금 시간대에 보낼 수 있는 그룹이 없어.');return}if(!('Notification'in window)||Notification.permission!=='granted'){if(manual)await requestPermission();return}const g=groups[Math.floor(Math.random()*groups.length)];await notify(g,chooseMessage(g));if(manual)showToast(`${g.name} 그룹에서 1개를 골랐어.`)}
function startTimer(){clearInterval(timer);timer=setInterval(()=>checkDue(),Math.max(1,Number(state.settings.checkInterval))*60*1000)}
function renderPermission(){const el=$('#permissionState');if(!('Notification'in window)){el.textContent='지원하지 않음';return}const map={granted:'허용됨',denied:'차단됨',default:'아직 허용 전'};el.textContent=map[Notification.permission]||Notification.permission}
function renderAvatar(){const img=$('#homeAvatar'),fb=$('#avatarFallback');if(state.character.avatar){img.src=state.character.avatar;img.hidden=false;fb.hidden=true}else{img.hidden=true;fb.hidden=false}}
function renderHome(){renderAvatar();$('#homeName').textContent=state.character.name||'이름을 설정해줘';const active=state.groups.filter(g=>g.enabled&&g.messages?.length);$('#nextSummary').textContent=active.length?`${active.length}개 그룹이 활성화되어 있어.`:'활성화된 메시지 그룹이 아직 없어.';const box=$('#homeGroupList');box.innerHTML='';if(!active.length){box.innerHTML='<div class="empty">메시지 그룹에 대사를 추가하고 활성화해줘.</div>';return}active.forEach(g=>box.appendChild(groupCard(g,false)))}
function groupCard(g,editable){const el=document.createElement('div');el.className=editable?'editor-card':'group-card';const left=document.createElement('div');left.className='group-main';left.innerHTML=`<div class="group-title"><span class="status-dot ${g.enabled?'':'off'}"></span>${escapeHtml(g.name)}</div><div class="group-meta">${g.start} ~ ${g.end} · 하루 ${g.dailyCount}회 · 대사 ${g.messages?.length||0}개</div>`;el.appendChild(left);if(editable){const act=document.createElement('div');act.className='editor-actions';act.innerHTML=`<button class="mini-btn" data-preview="${g.id}">미리보기</button><button class="mini-btn" data-edit="${g.id}">편집</button><button class="mini-btn danger" data-delete="${g.id}">삭제</button>`;el.appendChild(act)}return el}
function renderGroups(){const box=$('#groupEditorList');box.innerHTML='';if(!state.groups.length){box.innerHTML='<div class="empty">아직 그룹이 없어. 첫 그룹을 만들어봐.</div>';return}state.groups.forEach(g=>box.appendChild(groupCard(g,true)))}
function renderHistory(){const box=$('#historyList');box.innerHTML='';if(!state.history.length){box.innerHTML='<div class="empty">아직 받은 메시지가 없어.</div>';return}state.history.forEach(h=>{const d=new Date(h.ts);const el=document.createElement('div');el.className='history-card';el.innerHTML=`<div class="history-time">${d.toLocaleDateString('ko-KR')}<br>${d.toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'})}</div><div><div class="history-message">${escapeHtml(h.message)}</div><div class="history-group">${escapeHtml(h.groupName)}</div></div>`;box.appendChild(el)})}
function renderSettings(){$('#characterName').value=state.character.name||'';$('#avoidRecent').checked=!!state.settings.avoidRecent;$('#recentCount').value=state.settings.recentCount;$('#checkInterval').value=String(state.settings.checkInterval)}
function renderAll(){renderPermission();renderHome();renderGroups();renderHistory();renderSettings()}
function escapeHtml(s=''){return s.replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function openGroupDialog(group=null){$('#groupId').value=group?.id||'';$('#dialogTitle').textContent=group?'그룹 편집':'그룹 추가';$('#groupName').value=group?.name||'';$('#startTime').value=group?.start||'07:00';$('#endTime').value=group?.end||'10:00';$('#dailyCount').value=String(group?.dailyCount||1);$('#messages').value=(group?.messages||[]).join('\n');$('#groupEnabled').checked=group?!!group.enabled:true;$('#groupDialog').showModal()}
function closeDialog(){$('#groupDialog').close()}
function switchTab(id){$$('.tab').forEach(b=>b.classList.toggle('active',b.dataset.tab===id));$$('.panel').forEach(p=>p.classList.toggle('active',p.id===id));window.scrollTo({top:0,behavior:'smooth'})}

$$('.tab').forEach(b=>b.addEventListener('click',()=>switchTab(b.dataset.tab)));$$('[data-go]').forEach(b=>b.addEventListener('click',()=>switchTab(b.dataset.go)));
$('#permissionBtn').addEventListener('click',requestPermission);$('#testBtn').addEventListener('click',sendRandomTest);$('#runDueBtn').addEventListener('click',()=>checkDue({manual:true}));$('#addGroupBtn').addEventListener('click',()=>openGroupDialog());$('#closeDialogBtn').addEventListener('click',closeDialog);$('#cancelGroupBtn').addEventListener('click',closeDialog);
$('#groupForm').addEventListener('submit',e=>{e.preventDefault();const messages=$('#messages').value.split('\n').map(v=>v.trim()).filter(Boolean);if(!messages.length){showToast('대사를 한 개 이상 입력해줘.');return}const id=$('#groupId').value;const data={id:id||crypto.randomUUID(),name:$('#groupName').value.trim(),start:$('#startTime').value,end:$('#endTime').value,dailyCount:Number($('#dailyCount').value),enabled:$('#groupEnabled').checked,messages,sentToday:[]};if(id){const i=state.groups.findIndex(g=>g.id===id);data.sentToday=state.groups[i]?.sentToday||[];state.groups[i]=data}else state.groups.push(data);save();closeDialog();showToast('저장했어.')});
$('#groupEditorList').addEventListener('click',async e=>{const edit=e.target.dataset.edit,del=e.target.dataset.delete,preview=e.target.dataset.preview;if(edit){openGroupDialog(state.groups.find(g=>g.id===edit))}if(del){const g=state.groups.find(g=>g.id===del);if(confirm(`“${g.name}” 그룹을 삭제할까?`)){state.groups=state.groups.filter(x=>x.id!==del);save()}}if(preview){const g=state.groups.find(x=>x.id===preview);if(!g.messages.length){showToast('대사를 먼저 추가해줘.');return}if(!('Notification'in window)||Notification.permission!=='granted'){await requestPermission();if(Notification.permission!=='granted')return}await notify(g,chooseMessage(g))}});
$('#clearHistoryBtn').addEventListener('click',()=>{if(confirm('받은 메시지 기록을 모두 비울까?')){state.history=[];save()}});
$('#characterName').addEventListener('input',e=>{state.character.name=e.target.value;localStorage.setItem(STORAGE_KEY,JSON.stringify(state));renderHome()});
$('#avatarFile').addEventListener('change',e=>{const f=e.target.files?.[0];if(!f)return;if(f.size>2.5*1024*1024){showToast('이미지는 2.5MB 이하를 권장해.');return}const r=new FileReader();r.onload=()=>{state.character.avatar=r.result;save()};r.readAsDataURL(f)});$('#removeAvatarBtn').addEventListener('click',()=>{state.character.avatar='';save()});
$('#avoidRecent').addEventListener('change',e=>{state.settings.avoidRecent=e.target.checked;save()});$('#recentCount').addEventListener('change',e=>{state.settings.recentCount=Math.max(0,Math.min(20,Number(e.target.value)||0));save()});$('#checkInterval').addEventListener('change',e=>{state.settings.checkInterval=Number(e.target.value);save();startTimer()});
$('#exportBtn').addEventListener('click',()=>{const blob=new Blob([JSON.stringify(state,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`dear-message-backup-${todayKey()}.json`;a.click();URL.revokeObjectURL(a.href)});
$('#importFile').addEventListener('change',e=>{const f=e.target.files?.[0];if(!f)return;const r=new FileReader();r.onload=()=>{try{const obj=JSON.parse(r.result);state=mergeDefaults(obj);save();startTimer();showToast('백업을 가져왔어.')}catch{showToast('올바른 JSON 백업 파일이 아니야.')}};r.readAsText(f)});
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredPrompt=e;$('#installBtn').hidden=false});$('#installBtn').addEventListener('click',async()=>{if(!deferredPrompt)return;deferredPrompt.prompt();await deferredPrompt.userChoice;deferredPrompt=null;$('#installBtn').hidden=true});
if('serviceWorker'in navigator){navigator.serviceWorker.register('./sw.js').catch(console.error)}
resetDailyIfNeeded();renderAll();startTimer();
