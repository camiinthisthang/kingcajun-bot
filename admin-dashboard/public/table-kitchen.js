const count=document.querySelector('#table-order-count');
const status=document.querySelector('#table-order-status');
const frame=document.querySelector('#table-kitchen-frame');
let refreshing=false;
async function refreshTableCount(){
  if(refreshing)return;refreshing=true;
  try{
    const response=await fetch('/api/dine-in/state',{signal:AbortSignal.timeout(8000)});
    if(!response.ok)throw Error();
    const state=await response.json(),active=state.tickets.filter(t=>!['served','cancelled'].includes(t.state));
    const waiting=active.filter(t=>['new','cancel_requested'].includes(t.state)).length;
    count.textContent=String(active.length);count.classList.toggle('has-new',waiting>0);
    status.textContent=waiting?`${waiting} por atender · ${active.length} comandas activas`:`${active.length} comandas activas · actualizado`;
  }catch{count.textContent='!';status.textContent='Sin conexión con mesas. No se puede confirmar si hay pedidos nuevos.';}
  finally{refreshing=false;}
}
document.querySelectorAll('[data-tab]').forEach(button=>button.addEventListener('click',()=>{
  document.body.classList.toggle('show-table-orders',button.dataset.tab==='tables');
}));
window.addEventListener('message',event=>{
  if(event.origin!==location.origin||event.source!==frame.contentWindow||event.data?.type!=='kc-table-height')return;
  if(Number.isFinite(event.data.height))frame.style.height=`${Math.min(3000,Math.max(650,event.data.height+20))}px`;
});
if(new URLSearchParams(location.search).get('view')==='mesas')document.querySelector('[data-tab="tables"]').click();
await refreshTableCount();
setInterval(()=>{if(!document.hidden)refreshTableCount();},4000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshTableCount();});
