import pg from 'pg';
import type {Db} from './db/index.js';

// Only configuration crosses into the rehearsal DB. Customer/order data never does.
const tables=['menu_items','costing_state','bot_flow','bot_flow_history','delivery_windows','delivery_date_limits','referral_codes','checkout_settings'] as const;
export type CatalogSnapshot=Record<typeof tables[number],Record<string,unknown>[]>;
export function previewCatalogSource(databaseUrl:string){
 const pool=new pg.Pool({connectionString:databaseUrl,max:1,connectionTimeoutMillis:10000,statement_timeout:10000});
 return {
  async read():Promise<CatalogSnapshot>{
   const client=await pool.connect();
   try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot={} as CatalogSnapshot;
    for(const table of tables){
     snapshot[table]=(await client.query(`SELECT * FROM ${table}`)).rows.map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,value instanceof Date?value.toISOString():value])));
    }
    // Whitelisted rehearsals are allowed before the public opening date.
    snapshot.delivery_windows=snapshot.delivery_windows.map(row=>({...row,order_opens_at:null}));
    await client.query('COMMIT');return snapshot;
   }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  },close:()=>pool.end()
 };
}
export async function syncPreviewCatalog(db:Db,snapshot:CatalogSnapshot){
 await db.transaction(async tx=>{
  await tx.query('UPDATE menu_items SET active=false');
  await tx.query("UPDATE delivery_windows SET status='closed'");
  await tx.query('UPDATE referral_codes SET active=false');
  for(const table of tables){
   const types=new Map((await tx.query('SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1',[table])).rows.map(c=>[c.column_name,c.data_type]));
   const pk=table==='delivery_date_limits'?'delivery_date':table==='bot_flow_history'?'version':'id';
   for(const row of snapshot[table]??[]){
    const keys=Object.keys(row);
    if(keys.some(key=>!/^[a-z][a-z0-9_]*$/.test(key)||!types.has(key)))throw new Error(`Invalid preview configuration: ${table}`);
    await tx.query(`INSERT INTO ${table} (${keys.map(k=>`"${k}"`).join(',')}) VALUES (${keys.map((_,i)=>`$${i+1}`).join(',')}) ON CONFLICT (${pk}) DO UPDATE SET ${keys.filter(k=>k!==pk).map(k=>`"${k}"=EXCLUDED."${k}"`).join(',')}`,
     keys.map(k=>types.get(k)==='jsonb'&&row[k]!==null?JSON.stringify(row[k]):row[k]));
   }
  }
 });
}
export function catalogRefresher(db:Db,read:()=>Promise<CatalogSnapshot>){
 let last=0;let pending:Promise<void>|undefined;
 return async()=>{
  if(Date.now()-last<5000)return;
  if(!pending)pending=read().then(snapshot=>syncPreviewCatalog(db,snapshot)).then(()=>{last=Date.now();}).finally(()=>{pending=undefined;});
  await pending;
 };
}
