import {it,expect,vi} from 'vitest';
import {randomBytes,createHash} from 'node:crypto';
import {createTestDb} from '../src/db/index.js';
import {migrateBankMail,unseal,gmailScope} from '../admin-dashboard/src/bank-mail.mjs';
import {registerBankMailRoutes} from '../admin-dashboard/src/bank-mail-routes.mjs';
async function fixture(){
 const db=await createTestDb();await migrateBankMail(db);const routes=new Map<string,any[]>();
 const app={get:(path:string,...handlers:any[])=>routes.set('GET '+path,handlers),post:(path:string,...handlers:any[])=>routes.set('POST '+path,handlers)};
 const admin=()=>{},origin=()=>{},env={BANK_MAIL_EMAIL:'bank-mail@example.com',GOOGLE_BANK_CLIENT_ID:'test-client',GOOGLE_BANK_CLIENT_SECRET:'test-secret',BANK_MAIL_TOKEN_KEY:randomBytes(32).toString('base64')};
 registerBankMailRoutes(app,{db,root:'/test',requireAdmin:admin,sameOrigin:origin,publicUrl:'https://kingcajun.vercel.app',env});
 const res=()=>({code:200,headers:{} as any,body:null as any,status(n:number){this.code=n;return this;},setHeader(k:string,v:string){this.headers[k]=v;return this;},json(v:any){this.body=v;return this;},send(v:any){this.body=v;return this;},redirect(v:string){this.code=302;this.body=v;return this;}});
 const call=async(method:string,path:string,req:any={})=>{const r=res();await routes.get(method+' '+path)!.at(-1)(req,r);return r;};
 return{db,routes,admin,origin,env,call};
}
it('protects setup/status with admin auth and creates a one-time PKCE state with secure cookie',async()=>{const f=await fixture();try{
 expect(f.routes.get('POST /api/admin/bank-mail/connect')!.slice(0,2)).toEqual([f.admin,f.origin]);expect(f.routes.get('GET /api/admin/bank-mail')![0]).toBe(f.admin);
 const r=await f.call('POST','/api/admin/bank-mail/connect');const url=new URL(r.body.url);expect(url.searchParams.get('scope')).toBe(gmailScope);expect(url.searchParams.get('redirect_uri')).toBe('https://kingcajun.vercel.app/api/admin/bank-mail/callback');expect(r.headers['Set-Cookie']).toContain('HttpOnly; Secure; SameSite=Lax');
 const state=url.searchParams.get('state')!;const row=(await f.db.query<any>('SELECT * FROM bank_mail_oauth')).rows[0];expect(row.state_hash).toBe(createHash('sha256').update(state).digest('hex'));expect(url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(row.verifier).digest('base64url'));
}finally{await f.db.close();}});
it('rejects a callback without the matching browser cookie before any Google request',async()=>{const f=await fixture();const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);try{const r=await f.call('GET','/api/admin/bank-mail/callback',{query:{state:'fake',code:'fake'},headers:{}});expect(r.code).toBe(400);expect(fetchMock).not.toHaveBeenCalled();}finally{vi.unstubAllGlobals();await f.db.close();}});
it('saves only encrypted refresh credentials after owner consent and rejects replay',async()=>{const f=await fixture();try{
 const start=await f.call('POST','/api/admin/bank-mail/connect');const state=new URL(start.body.url).searchParams.get('state');const req={query:{state,code:'google-code'},headers:{cookie:start.headers['Set-Cookie'].split(';')[0]}};
 vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce({ok:true,json:async()=>({refresh_token:'private-refresh',access_token:'access',scope:gmailScope})}).mockResolvedValueOnce({ok:true,json:async()=>({emailAddress:'bank-mail@example.com'})}));
 expect((await f.call('GET','/api/admin/bank-mail/callback',req)).code).toBe(302);const row=(await f.db.query<any>('SELECT * FROM bank_mail_connection')).rows[0];expect(row.tokens).not.toContain('private-refresh');expect(unseal(row.tokens,f.env.BANK_MAIL_TOKEN_KEY)).toEqual({refresh_token:'private-refresh'});expect((await f.call('GET','/api/admin/bank-mail/callback',req)).code).toBe(400);
}finally{vi.unstubAllGlobals();await f.db.close();}});
it('does not connect a different Google mailbox',async()=>{const f=await fixture();try{
 const start=await f.call('POST','/api/admin/bank-mail/connect');const state=new URL(start.body.url).searchParams.get('state');
 vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce({ok:true,json:async()=>({refresh_token:'private-refresh',access_token:'access',scope:gmailScope})}).mockResolvedValueOnce({ok:true,json:async()=>({emailAddress:'different@example.com'})}));
 const r=await f.call('GET','/api/admin/bank-mail/callback',{query:{state,code:'code'},headers:{cookie:start.headers['Set-Cookie'].split(';')[0]}});expect(r.code).toBe(400);expect((await f.db.query('SELECT * FROM bank_mail_connection')).rows).toHaveLength(0);
}finally{vi.unstubAllGlobals();await f.db.close();}});

it('returns the unconfigured connection status and empty review queue',async()=>{const f=await fixture();try{const response=await f.call('GET','/api/admin/bank-mail');expect(response.code).toBe(200);expect(response.body.connection).toBe(null);expect(response.body.events).toEqual([]);}finally{await f.db.close();}});
