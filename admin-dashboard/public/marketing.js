const container=document.querySelector('#tasks'),progress=document.querySelector('#progress');
let tasks=[],dirty=new Set();
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function summary(){progress.textContent=`${tasks.filter(t=>t.done).length} of ${tasks.length} completed`;}
try{
  const response=await fetch('/api/marketing');if(!response.ok)throw Error(response.status===401?'Sign in again to view this checklist.':'Could not load the checklist.');
  tasks=(await response.json()).tasks;
  container.innerHTML=tasks.map(t=>`<form class="task ${t.done?'done':''}" data-id="${esc(t.id)}"><div class="heading"><input type="checkbox" name="done" aria-label="Complete ${esc(t.title)}" ${t.done?'checked':''}><div><h2>${esc(t.title)}</h2><p>${esc(t.description)}</p></div></div><label for="notes-${esc(t.id)}">Notes, decisions, or timing</label><textarea id="notes-${esc(t.id)}" name="notes" maxlength="5000">${esc(t.notes)}</textarea><div class="save-row"><button type="submit" disabled>Save task</button><span class="status" role="status">Saved</span></div></form>`).join('');summary();
  container.querySelectorAll('form').forEach(form=>{
    const status=form.querySelector('.status'),button=form.querySelector('button');
    form.addEventListener('input',()=>{dirty.add(form.dataset.id);button.disabled=false;status.classList.remove('error');status.textContent='Unsaved changes';});
    form.addEventListener('submit',async event=>{
      event.preventDefault();const id=form.dataset.id,task=tasks.find(t=>t.id===id),data=new FormData(form),body={done:data.get('done')==='on',notes:data.get('notes'),version:task.version};button.disabled=true;status.textContent='Saving…';
      form.querySelectorAll('input,textarea').forEach(el=>el.disabled=true);
      try{const response=await fetch('/api/marketing/'+encodeURIComponent(id),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),result=await response.json();if(!response.ok)throw Error(result.error||'Could not save.');Object.assign(task,result.task);dirty.delete(id);status.textContent='Saved';status.classList.remove('error');form.classList.toggle('done',task.done);summary();}
      catch(error){button.disabled=false;status.textContent=error.message;status.classList.add('error');}
      finally{form.querySelectorAll('input,textarea').forEach(el=>el.disabled=false);}
    });
  });
}catch(error){progress.textContent=error.message;}
window.addEventListener('beforeunload',event=>{if(dirty.size){event.preventDefault();event.returnValue='';}});
