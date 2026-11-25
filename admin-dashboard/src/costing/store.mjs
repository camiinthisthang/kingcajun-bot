import {randomUUID,createHash} from 'node:crypto';
import {priceModel, PricingError, componentText} from './pricing.mjs';
export {migrateCosting} from './schema.mjs';
const tables={settings:'costing_settings',ingredients:'ingredients',recipes:'recipes',lines:'recipe_lines',drinks:'costing_drinks',equipment:'costing_equipment',heats:'costing_heat',ranges:'costing_ranges'};
const mapping={settings:{key:'key',label:'label',value:'value',unit:'unit',expression:'expression',note:'note',derived:'derived',source:'source'},ingredients:{key:'key',name:'name',displayName:'display_name',category:'category',purchasePrice:'purchase_price',purchaseQty:'purchase_qty',unit:'unit',ivaMode:'iva_mode',freight:'freight',waste:'waste',supplier:'supplier',notes:'notes',source:'source'},recipes:{key:'key',name:'name',yieldQty:'yield_qty',unit:'unit',estimated:'estimated',notes:'notes'},lines:{key:'key',recipeKey:'recipe_key',ingredientKey:'ingredient_key',subrecipeKey:'subrecipe_key',qty:'qty',unit:'unit',expression:'expression',consumable:'consumable',source:'source'}};
const numeric=new Set(['value','purchasePrice','purchaseQty','waste','yieldQty','qty']);
const json=new Set(['expression','source']);
export async function readModel(db,lock=false) {
 const state=(await db.query(`SELECT * FROM costing_state WHERE id=1${lock?' FOR UPDATE':''}`)).rows[0];
 if(!state?.source_hash)return null;
 const model={version:state.version,sourceHash:state.source_hash};
 for(const [name,table] of Object.entries(tables)) {
  const rows=(await db.query(`SELECT * FROM ${table} ORDER BY ${['lines','ingredients','drinks'].includes(name)?'length(key),key':'key'}`)).rows;
  model[name]=mapping[name]?rows.map(row=>Object.fromEntries(Object.entries(mapping[name]).map(([k,col])=>[k,numeric.has(k)&&row[col]!==null?Number(row[col]):row[col]]))):rows.map(row=>row.specification);
 }
 model.menu=(await db.query('SELECT id::text,name,active,sort_order,pricing_spec FROM menu_items WHERE pricing_spec IS NOT NULL ORDER BY sort_order,slug')).rows.map(r=>({...r.pricing_spec,id:r.id,name:r.name,active:r.active,sortOrder:r.sort_order}));
 return model;
}
export async function readCosting(db) {
 const work=async tx=>{const model=await readModel(tx,true);return model?{version:model.version,model,priced:priceModel(model)}:null;};
 return db.transaction?db.transaction(work):work(db);
}
// Generated compatibility view for the existing kitchen. Not an editable second menu.
export function kitchenCatalog(priced,version) {
 const ingredients=new Map();
 const products=priced.menu.filter(i=>i.active).map(item=>{
  const components=item.components.filter(c=>c.quantity>0).map(c=>{
   const raw={name:c.name,unit:['each','piece','pieza'].includes(c.unit)?'piece':c.unit,basis:c.unit==='g'?'Peso de receta; mariscos congelados con hielo':'Cantidad de receta',method:['each','piece','pieza'].includes(c.unit)?'count':'portion',packFactor:1,packLabel:'',packingNote:'',screening:null};
   // Definition-specific key lets old and new unit definitions coexist in one run.
   const id=`${c.ingredientKey??c.subrecipeKey}_${createHash('sha256').update(JSON.stringify(raw)).digest('hex').slice(0,10)}`;
   ingredients.set(id,{id,...raw});
   return {ingredientId:id,quantity:c.quantity,displayText:componentText(c),pieces:c.pieces};
  });
  return {id:item.slug,name:item.name,unit:item.saleUnit,baseQuantity:item.baseQuantity,priceCop:item.price_used,components,requiresHeat:item.sauceOz>0||item.section==='Marisco',includesSauce:item.sauceOz>0,description:item.generatedDescription,menuVersion:version,sauceOz:item.sauceOz};
 });
 return {ingredients:[...ingredients.values()],products};
}
function metadataFor(item,priced,catalog,version) {
 const product=catalog.products.find(p=>p.id===item.slug);
 const ingredients=product?catalog.ingredients.filter(i=>product.components.some(c=>c.ingredientId===i.id)):[];
  const seafood=item.saleUnit==='g'||item.section==='Marisco';
  const aliases=item.slug==='cangrejo_nieve_100g'?['cangrejo de nieve','snow crab','racimo de nieve']:item.slug==='cangrejo_rey_100g'?['cangrejo rey','king crab','pata de rey']:item.slug==='cola_langosta'?['cola de langosta','colita de langosta','lobster tail']:[];
  return {product_type:item.section==='Combo'?'set':seafood?'byo_protein':undefined,aliases:[...new Set([...aliases,...(item.slug==='kit_opcional'?['kit','kits','guantes','babero','mantel']:[]),item.name.toLowerCase(),item.name.toLowerCase().split(',')[0],item.name.toLowerCase().replace(' ranchera','').replace(' cocido','')].map(s=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'')))],menu_version:version,slug:item.slug,costing:{slug:item.slug,menuVersion:version,unitCost:item.total_cost,components:item.components,missing:item.missing,sauceOz:item.sauceOz,heats:priced.heats},kitchen:product?{product,ingredients}:undefined};
}
async function writeModel(tx,model,priced,version) {
 for(const name of ['settings','ingredients','recipes','lines']) for(const row of model[name]) {
  const fields=Object.entries(mapping[name]),cols=fields.map(([,c])=>c);
  const values=fields.map(([k])=>json.has(k)&&row[k]!=null?JSON.stringify(row[k]):row[k]??null);
  await tx.query(`INSERT INTO ${tables[name]} (${cols.join(',')}) VALUES (${fields.map(([k],i)=>'$'+(i+1)+(json.has(k)?'::jsonb':'')).join(',')}) ON CONFLICT(key) DO UPDATE SET ${cols.filter(c=>c!=='key').map(c=>`${c}=EXCLUDED.${c}`).join(',')}`,values);
 }
 await tx.query('DELETE FROM recipe_lines WHERE NOT (key=ANY($1::text[]))',[model.lines.map(l=>l.key)]);
 for(const name of ['heats','drinks','equipment','ranges']) for(const row of model[name])await tx.query(`INSERT INTO ${tables[name]}(key,specification) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET specification=EXCLUDED.specification`,[row.key??row.slug,JSON.stringify(row)]);
 await tx.query('UPDATE costing_state SET derived=$1::jsonb WHERE id=1',[JSON.stringify({deliveryEquipmentCost:priced.deliveryEquipmentCost,deliveryCostMissing:priced.equipment.some(e=>e.missing)})]);
 const catalog=kitchenCatalog(priced,version);
 for(const item of priced.menu) {
  const spec=model.menu.find(i=>i.slug===item.slug), meta=metadataFor(item,priced,catalog,version);
  await tx.query(`INSERT INTO menu_items(id,sku,slug,name,description,category,price_cop,active,sort_order,metadata_json,pricing_spec,menu_version,cost_cop,created_at,updated_at) VALUES($12,$13,$1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,now(),now()) ON CONFLICT(slug) WHERE slug IS NOT NULL DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,category=EXCLUDED.category,price_cop=EXCLUDED.price_cop,active=EXCLUDED.active,sort_order=EXCLUDED.sort_order,metadata_json=EXCLUDED.metadata_json,pricing_spec=EXCLUDED.pricing_spec,menu_version=EXCLUDED.menu_version,cost_cop=EXCLUDED.cost_cop,updated_at=now()`,[item.slug,item.name,item.generatedDescription,item.section==='Combo'||item.section==='Marisco'||item.saleUnit==='g'?'plate':'addon',item.price_used??0,item.active,item.sortOrder,JSON.stringify(meta),JSON.stringify(spec),version,item.total_cost,randomUUID(),'KC-'+item.slug]);
 }
 for(const d of priced.drinks) await tx.query(`INSERT INTO menu_items(id,sku,slug,name,description,category,price_cop,active,sort_order,metadata_json,menu_version,cost_cop,created_at,updated_at) VALUES($1,$2,$3,$4,'','drink',$5,$6,100,$7::jsonb,$8,$9,now(),now()) ON CONFLICT(slug) WHERE slug IS NOT NULL DO UPDATE SET name=EXCLUDED.name,price_cop=EXCLUDED.price_cop,active=EXCLUDED.active,metadata_json=EXCLUDED.metadata_json,menu_version=EXCLUDED.menu_version,cost_cop=EXCLUDED.cost_cop,updated_at=now()`,[randomUUID(),'KC-'+d.key,d.key,d.name,d.price_used??0,d.active,JSON.stringify({slug:d.key,menu_version:version,aliases:[d.name.toLowerCase(),...(d.key==='drink_6'?['coca','cocas','coca cola','coca-cola','cocacola','coke']:[])],costing:{slug:d.key,menuVersion:version,unitCost:d.cost,components:[],missing:d.missing?[d.key]:[]},kitchen:{product:{id:d.key,name:d.name,unit:'piece',baseQuantity:1,priceCop:d.price_used??0,components:[{ingredientId:d.key,quantity:1}],requiresHeat:false,includesSauce:false},ingredients:[{id:d.key,name:d.name,unit:'piece',basis:'Bebida lista',method:'count',packFactor:1}]}}),version,d.cost]);
}
export async function seedCosting(db,source,actor='importación local') {
 priceModel(source);
 return db.transaction(async tx=>{
  const state=(await tx.query('SELECT * FROM costing_state WHERE id=1 FOR UPDATE')).rows[0];
  if(state.source_hash) {
   if(state.source_hash!==source.sourceHash)throw new PricingError('Ya existe una importación distinta. Revisa los cambios desde el back office.',409);
   return {unchanged:true,version:state.version,report:(await tx.query('SELECT report FROM costing_imports WHERE source_hash=$1',[source.sourceHash])).rows[0].report};
  }
  const existing=(await tx.query('SELECT id::text,sku,name,slug FROM menu_items ORDER BY sku')).rows;
  const mapped=[],created=[];
  for(const item of source.menu) {
   const match=existing.find(e=>e.slug===item.slug||e.sku===`KC-KITCHEN-${item.legacyId}`);
   if(match) {await tx.query('UPDATE menu_items SET slug=$2 WHERE id=$1',[match.id,item.slug]);mapped.push({id:match.id,sku:match.sku,slug:item.slug});}
   else {const id=randomUUID();await tx.query(`INSERT INTO menu_items(id,sku,slug,name,description,category,price_cop,active,sort_order,created_at,updated_at) VALUES($1,$2,$3,$4,'','addon',0,false,0,now(),now())`,[id,'KC-'+item.slug,item.slug,item.name]);created.push(item.slug);}
  }
  const unmapped=existing.filter(e=>!mapped.some(m=>m.id===e.id));
  if(unmapped.length) await tx.query('UPDATE menu_items SET active=false WHERE id=ANY($1::uuid[])',[unmapped.map(e=>e.id)]);
  const orderReferences=(await tx.query('SELECT menu_item_id::text, COUNT(*)::int AS lines FROM order_line_items GROUP BY menu_item_id')).rows.map(r=>({...r,slug:mapped.find(m=>m.id===r.menu_item_id)?.slug??null}));
  const legacyKitchen=[];
  if((await tx.query("SELECT to_regclass('public.kitchen_catalog') AS name")).rows[0].name){
    const catalog=(await tx.query('SELECT document FROM kitchen_catalog WHERE id=1')).rows[0]?.document;
    for(const p of catalog?.products??[])legacyKitchen.push({source:'kitchen_catalog',id:p.id,name:p.name,slug:source.menu.find(i=>i.legacyId===p.id)?.slug??null});
  }
  if((await tx.query("SELECT to_regclass('public.kitchen_runs') AS name")).rows[0].name){
    const runs=(await tx.query('SELECT id::text,document FROM kitchen_runs')).rows;
    for(const run of runs)for(const order of run.document.orders??[])for(const line of order.lines??[])legacyKitchen.push({source:'kitchen_run',runId:run.id,orderId:order.id,productId:line.productId,name:line.name,slug:source.menu.find(i=>i.legacyId===line.productId||i.slug===line.productId)?.slug??null,preserved:true});
  }
  const report={ingredients:source.ingredients.length,recipes:source.recipes.length,recipeLines:source.lines.length,menuItems:source.menu.length,drinks:source.drinks.length,equipment:source.equipment.length,mapped,created,unmapped,orderReferences,legacyKitchen,orderSnapshotsChanged:0};
  const model={...source,version:1};delete model.workbook;
  await writeModel(tx,model,priceModel(model),1);
  await tx.query('UPDATE costing_state SET version=1,source_hash=$1,updated_at=now() WHERE id=1',[source.sourceHash]);
  await tx.query('INSERT INTO costing_imports(source_hash,workbook,report) VALUES($1,$2::jsonb,$3::jsonb)',[source.sourceHash,JSON.stringify(source.workbook),JSON.stringify(report)]);
  await tx.query('INSERT INTO price_history(version,actor,changes,model) VALUES(1,$1,$2::jsonb,$3::jsonb)',[actor,JSON.stringify({import:report}),JSON.stringify(model)]);
  return {unchanged:false,version:1,report};
 });
}
const editable={ingredients:['displayName','category','purchasePrice','purchaseQty','unit','ivaMode','freight','waste','supplier','notes'],settings:['value','expression','note'],menu:['name','description','serves','priceOverride','active','sortOrder','sauceExpression'],recipes:['name','yieldQty','estimated','notes'],drinks:['name','type','packPrice','servings','priceOverride','active','example'],equipment:['name','quantity','unitCost','expectedUses','notes'],heats:['cayenneQty'],ranges:['minGrams','maxGrams']};
function applyChanges(model,changes) {
 if(!Array.isArray(changes)||!changes.length||changes.length>100)throw new PricingError('No hay cambios válidos.');
 for(const change of changes) {
  if(change.collection==='lines') {
   if(!model.recipes.some(r=>r.key===change.key)||!Array.isArray(change.lines)||change.lines.length>50)throw new PricingError('Receta inválida.');
   const lines=change.lines.map((l,index)=>({key:`${change.key}_edit_${index}`,recipeKey:change.key,ingredientKey:l.ingredientKey??null,subrecipeKey:l.subrecipeKey??null,qty:l.qty,expression:l.expression??{value:l.qty},unit:l.unit,consumable:l.consumable,source:l.source??null}));
   model.lines=model.lines.filter(l=>l.recipeKey!==change.key).concat(lines);continue;
  }
  const allowed=editable[change.collection];if(!allowed)throw new PricingError('Tipo de cambio desconocido.');
  const row=model[change.collection].find(r=>(r.key??r.slug)===change.key);if(!row)throw new PricingError('Registro desconocido.',404);
  if(change.collection==='settings'&&row.derived)throw new PricingError('Este valor se calcula automáticamente. Edita sus ingredientes o supuestos.');
  if(!change.patch||Object.keys(change.patch).some(k=>!allowed.includes(k)))throw new PricingError('Campo no editable.');
  Object.assign(row,change.patch);
  if(change.collection==='settings'&&Object.hasOwn(change.patch,'value')&&!Object.hasOwn(change.patch,'expression'))row.expression=null;
 }
 return model;
}
export async function changeCosting(db,input,actor,preview=false) {
 return db.transaction(async tx=>{
  const before=await readModel(tx,true);if(!before)throw new PricingError('Importa el libro primero.',409);
  if(input.version!==before.version)throw new PricingError('Los datos cambiaron en otra ventana. Recarga antes de guardar; tus cambios no se han aplicado.',409);
  const model=applyChanges(structuredClone(before),input.changes),priced=priceModel(model),old=priceModel(before);
  const diff=[...priced.menu,...priced.drinks.map(d=>({...d,slug:d.key,total_cost:d.cost}))].flatMap(n=>{const p=[...old.menu,...old.drinks.map(d=>({...d,slug:d.key,total_cost:d.cost}))].find(i=>i.slug===n.slug);return JSON.stringify(p)!==JSON.stringify(n)?[{slug:n.slug,name:n.name,before:{price:p.price_used,cost:p.total_cost,profit:p.profit,target:p.price_at_target,foodCostPct:p.food_cost_pct,description:p.generatedDescription},after:{price:n.price_used,cost:n.total_cost,profit:n.profit,target:n.price_at_target,foodCostPct:n.food_cost_pct,description:n.generatedDescription}}]:[];});
  if(preview)return {version:before.version,model,priced,diff,preview:true};
  const version=before.version+1;model.version=version;
  await writeModel(tx,model,priced,version);
  await tx.query('UPDATE costing_state SET version=$1,updated_at=now() WHERE id=1',[version]);
  await tx.query('INSERT INTO price_history(version,actor,changes,model) VALUES($1,$2,$3::jsonb,$4::jsonb)',[version,actor,JSON.stringify({requested:input.changes,diff,before}),JSON.stringify(model)]);
  return {version,model,priced,diff,saved:true};
 });
}
export async function costingHistory(db,version) {
 if(version!==undefined) {if(!Number.isSafeInteger(version)||version<1)throw new PricingError('Versión inválida.');const row=(await db.query('SELECT version,actor,changed_at,changes,model FROM price_history WHERE version=$1',[version])).rows[0];if(!row)throw new PricingError('Versión no encontrada.',404);return {...row,priced:priceModel(row.model)};}
 return (await db.query('SELECT version,actor,changed_at,changes - \'before\' AS changes FROM price_history ORDER BY version DESC LIMIT 100')).rows;
}

// Operator-only structural publication, not exposed by the dashboard API.
// Recipes, sale units, and new products publish together with an audit snapshot.
export async function publishCatalogModel(db,input,actor) {
 return db.transaction(async tx=>{
  const before=await readModel(tx,true);
  if(!before||before.version!==input.version)throw new PricingError('El catálogo cambió. Revisa la publicación.',409);
  const model=structuredClone(input.model);
  for(const name of ['settings','ingredients','recipes','menu','drinks','equipment']){
   if(before[name].some(row=>!model[name].some(n=>(n.key??n.slug)===(row.key??row.slug))))throw new PricingError('La publicación no puede eliminar registros históricos.');
  }
  const priced=priceModel(model),version=before.version+1;model.version=version;
  await writeModel(tx,model,priced,version);
  await tx.query('UPDATE costing_state SET version=$1,updated_at=now() WHERE id=1',[version]);
  await tx.query('INSERT INTO price_history(version,actor,changes,model) VALUES($1,$2,$3::jsonb,$4::jsonb)',[version,actor,JSON.stringify({publication:input.reason,before}),JSON.stringify(model)]);
  return {version,model,priced,saved:true};
 });
}
