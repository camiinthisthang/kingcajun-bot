const date=document.querySelector('#date'),notice=document.querySelector('#notice'),groups=document.querySelector('#groups');
date.value=new Date().toLocaleDateString('en-CA',{timeZone:'America/Bogota'});
const element=(tag,text)=>{const e=document.createElement(tag);e.textContent=text;return e;};
const time=s=>new Date(s).toLocaleTimeString('es-CO',{timeZone:'America/Bogota',hour:'numeric',minute:'2-digit'});
async function request(url,options){const r=await fetch(url,options);if(r.status===401){location.href='/login';throw Error('Inicia sesión.');}const body=await r.json();if(!r.ok)throw Error(body.error||'No se pudo guardar.');return body;}
async function refresh(){notice.className='';notice.textContent='Consultando…';try{
 const data=await request('/api/admin/delivery-groups?date='+date.value);groups.replaceChildren();notice.textContent=`${data.nightly} de ${data.limit} domicilios reservados o confirmados`;
 for(const g of data.groups){const card=element('article','');card.append(element('h2',`Conductor ${g.driver} · ${g.area}`),element('p',`${time(g.starts_at)}–${time(g.ends_at)} · ${g.orders.length}/3 pedidos · ${{planned:'Programado',out:'En ruta',returned:'Regresó'}[g.state]}`));
 for(const o of g.orders)card.append(element('p',`${o.public_id} · ${o.display_name||o.phone_e164}\n${o.delivery_address} · ${{confirmed:'Pagado / confirmado',awaiting_payment:'Pendiente de pago',payment_review:'Pago en revisión',fulfilled:'Entregado'}[o.status]||o.status}`));
 for(const o of g.orders)card.append(element('p',`${o.public_id}: ${(o.items||[]).map(l=>l.quantity+' × '+l.name).join(' · ')}`));
 if(g.state!=='returned'){const b=element('button',g.state==='out'?'Conductor regresó':'Pedidos listos: despachar');b.onclick=async()=>{b.disabled=true;try{await request('/api/admin/delivery-groups/'+g.id,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:g.state==='out'?'return':'dispatch',ready:g.state==='planned'})});await refresh();}catch(e){notice.className='error';notice.textContent=e.message;b.disabled=false;}};card.append(b);}groups.append(card);}
 if(data.pickups?.length){groups.append(element('h2','Recogidas en el local'));for(const o of data.pickups)groups.append(element('article',`${o.public_id} · ${time(o.starts_at)} · ${o.display_name||o.phone_e164} · ${o.status==='confirmed'?'Pagado / confirmado':'Pendiente de verificar pago'} — ${(o.items||[]).map(l=>l.quantity+' × '+l.name).join(' · ')}`));}
 if(!data.groups.length)groups.append(element('p','No hay grupos activos para esta fecha.'));
 }catch(e){notice.className='error';notice.textContent=e.message;}}
document.querySelector('#refresh').onclick=refresh;date.onchange=refresh;refresh();
