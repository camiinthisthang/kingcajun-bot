import {deliveryDay,normalize} from './operations-view.js';

const combos=[
  {id:'combo_personal',label:'Combo personal'},
  {id:'combo_mediano',label:'Combo mediano'},
  {id:'combo_familiar',label:'Combo familiar'},
  {id:'combo_premium',label:'Combo premium'}
];

// Classify the whole order, not each portion: additions never turn a combo
// into a custom order, and orders with different combos get one shared bucket.
export function orderType(order) {
  const lines=(order.line_items||[]).filter(line=>Number(line.quantity)>0);
  if(!lines.length)return {id:'missing',label:'Sin detalle'};
  const found=new Map();
  for(const line of lines){
    const slug=normalize(line.slug||'').replace(/-/g,'_');
    const name=normalize(line.name||'').trim();
    const known=combos.find(c=>slug===c.id||new RegExp('^'+c.id.replace('_',' ')+'\\b').test(name));
    if(known)found.set(known.id,known);
    else if(normalize(line.section||'')==='combo'||/^combo(?:_|\b)/.test(slug)||/^combo\b/.test(name)){
      const id='combo:'+ (slug||name);
      found.set(id,{id,label:line.name||'Otro combo'});
    }
  }
  if(found.size>1)return {id:'mixed',label:'Combos variados'};
  return found.values().next().value||{id:'custom',label:'Pedido personalizado'};
}

export function orderMix(orders,{day=''}={}) {
  const active=orders.filter(o=>!['cancelled','expired'].includes(o.status)&&(!day||deliveryDay(o)===day));
  const confirmed=active.filter(o=>o.is_confirmed===true&&['confirmed','fulfilled'].includes(o.status));
  const counts=new Map(combos.map(c=>[c.id,{...c,count:0}]));
  counts.set('custom',{id:'custom',label:'Pedido personalizado',count:0});
  for(const order of confirmed){
    const type=orderType(order);
    if(!counts.has(type.id))counts.set(type.id,{...type,count:0});
    counts.get(type.id).count++;
  }
  const groups=[...counts.values()].map(group=>({...group,percent:confirmed.length?group.count/confirmed.length*100:0}));
  return {total:confirmed.length,pending:active.length-confirmed.length,groups};
}
