import {deliveryDay,normalize} from './operations-view.js';

export const paymentGroups = [
  {id:'paid',label:'Pagados por completo'},
  {id:'deposit_50000',label:'Abono de $50.000'},
  {id:'unpaid',label:'Sin pago'},
  {id:'other_deposit',label:'Otros abonos'}
];

export function paymentGroup(order) {
  const paid=Number(order.collected_cop)||0;
  if(paid<=0)return 'unpaid';
  if(paid>=Number(order.total_cop))return 'paid';
  return paid===50000?'deposit_50000':'other_deposit';
}

export function paymentView(orders,{day='',scope='confirmed',search='',group='',sort='balance'}={}) {
  const q=normalize(search).trim();
  const active=orders.filter(o=>!['cancelled','expired'].includes(o.status)&&(!day||deliveryDay(o)===day)&&(!q||normalize([o.public_id,o.display_name,o.phone_e164,o.contact_phone].join(' ')).includes(q)));
  const confirmed=active.filter(o=>o.is_confirmed).length;
  const base=active.filter(o=>scope==='all'||(scope==='pending'?!o.is_confirmed:o.is_confirmed));
  const groups=paymentGroups.map(g=>({...g,count:0,collectedCop:0,balanceCop:0}));
  for(const o of base){
    const g=groups.find(g=>g.id===paymentGroup(o));
    g.count++;g.collectedCop+=Number(o.collected_cop)||0;g.balanceCop+=Math.max(0,Number(o.total_cop)-(Number(o.collected_cop)||0));
  }
  const rows=base.filter(o=>!group||paymentGroup(o)===group).sort((a,b)=>{
    if(sort==='customer')return String(a.display_name||'').localeCompare(String(b.display_name||''),'es',{sensitivity:'base'})||a.public_id.localeCompare(b.public_id);
    if(sort==='balance')return b.balance_due_cop-a.balance_due_cop||new Date(a.starts_at)-new Date(b.starts_at)||a.public_id.localeCompare(b.public_id);
    return new Date(a.starts_at)-new Date(b.starts_at)||a.public_id.localeCompare(b.public_id);
  });
  return {rows,groups,total:base.length,confirmed,pending:active.length-confirmed,
    collectedCop:groups.reduce((n,g)=>n+g.collectedCop,0),balanceCop:groups.reduce((n,g)=>n+g.balanceCop,0)};
}
