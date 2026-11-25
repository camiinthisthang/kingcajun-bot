import {randomUUID} from 'node:crypto';
import {validateCatalog} from './kitchen-domain.mjs';
const parts={shrimp:['Langostino','piece'],shrimp_g:['Langostinos','g'],mussels:['Mejillón negro','piece'],snow:['Racimo de cangrejo de nieve','piece'],king:['Pata grande entera de cangrejo rey','piece'],kanikama:['Pieza de kanikama','piece'],corn:['Pedazo de mazorca','piece'],potato:['Papa','piece'],sausage:['Salchicha ranchera','piece'],egg:['Huevo cocido','piece'],bread:['Pan de maíz dulce','piece'],kit:['Kit: babero, mantel y guantes','piece'],sauce:['Porción de salsa extra de 3 oz','piece'],fries:['Porción terminada de papas fritas cajún','piece'],crabfries:['Porción terminada de crab fries','piece'],coke:['Coca-Cola 250 ml','piece'],water:['Agua, unidad','piece']};
const sides={kanikama:10,corn:2,potato:1,sausage:1,egg:2,bread:2,kit:1};
const entries=[
 ['personal-shrimp','Combo personal — 15 langostinos',87000,'plate',{...sides,shrimp:15},true],
 ['personal-mussels','Combo personal — langostinos y mejillones',87000,'plate',{...sides,shrimp:7,mussels:8},true],
 ['personal-snow','Combo personal — cangrejo de nieve',119000,'plate',{...sides,shrimp:7,snow:1},true],
 ['medium','Combo mediano (2–3 personas)',250000,'plate',{snow:2,shrimp:26,kanikama:18,corn:4,potato:2,sausage:2,egg:2,bread:2},true],
 ['family','Combo familiar (4–5 personas)',405000,'plate',{snow:3,shrimp:48,kanikama:25,corn:6,potato:4,sausage:4,egg:4,bread:4},true],
 ['king-addon','Pata de cangrejo rey — adicional a un combo',250000,'addon',{king:1},false],
 ['shrimp','Langostinos — porción de 100 g',23500,'plate',{shrimp_g:100},false],
 ['kanikama','Pata kanikama — 10 piezas',27500,'plate',{kanikama:10},false],
 ['snow','Cangrejo de nieve — 1 racimo',53500,'plate',{snow:1},false],
 ['king','Cangrejo rey — 1 pata grande entera',252000,'plate',{king:1},false],
 ['corn','Mazorca',5000,'addon',{corn:1},false],
 ['potato','Papa',2500,'addon',{potato:1},false],
 ['sausage','Salchicha ranchera',6000,'addon',{sausage:1},false],
 ['egg','Huevo cocido',2500,'addon',{egg:1},false],
 ['bread','Pan de maíz dulce',3000,'addon',{bread:1},false],
 ['sauce','Salsa extra — 3 oz',8000,'addon',{sauce:1},false],
 ['fries','Papas fritas cajún',22000,'plate',{fries:1},false],
 ['crabfries','Crab fries',48000,'plate',{crabfries:1},false],
 ['coke','Coca-Cola — 250 ml',9000,'drink',{coke:1},false],
 ['water','Agua',9000,'drink',{water:1},false]
];
// Exact menu counts, not invented recipe weights, sauce quantities, or costs.
export const openingCatalog=validateCatalog({ingredients:Object.entries(parts).map(([id,[name,unit]])=>({id:'opening_'+id,name,unit,method:unit==='g'?'portion':'count',basis:'Carta aprobada 22 noviembre 2026; conteos/porciones de venta. No es una receta de costos.'})),products:entries.map(([id,name,price,category,components,set])=>({id:'opening_'+id,name,priceCop:price,unit:'portion',baseQuantity:1,requiresHeat:!['drink'].includes(category)&&!['bread','sauce'].includes(id),includesSauce:category!=='drink'&&!['bread','sauce','fries','crabfries'].includes(id),sauceOz:null,description:Object.entries(components).map(([key,q])=>`${q} ${parts[key][0]}`).join(' · ')+(set?' · Kit incluido; cantidad según comensales.':''),components:Object.entries(components).map(([key,quantity])=>({ingredientId:'opening_'+key,quantity}))}))});
export async function publishOpeningMenu(tx){
 await tx.query('UPDATE menu_items SET active=FALSE,updated_at=now() WHERE active=TRUE');
 for(const [i,entry] of entries.entries()){
  const [id,,price,category,,set]=entry,p=openingCatalog.products[i];
  const meta={scheduledMenu:'2026-11-22',product_type:set?'set':category==='plate'?'byo_protein':undefined,kitchen:{product:p,ingredients:openingCatalog.ingredients.filter(x=>p.components.some(c=>c.ingredientId===x.id))}};
  await tx.query(`INSERT INTO menu_items(id,sku,slug,name,description,category,price_cop,active,sort_order,metadata_json,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,TRUE,$8,$9::jsonb,now(),now()) ON CONFLICT(sku) DO UPDATE SET name=excluded.name,description=excluded.description,category=excluded.category,price_cop=excluded.price_cop,active=TRUE,sort_order=excluded.sort_order,metadata_json=excluded.metadata_json,updated_at=now()`,[randomUUID(),'KC-20261122-'+id,p.id,p.name,p.description,category,price,i,JSON.stringify(meta)]);
 }
 return {count:entries.length,version:'2026-11-22'};
}
