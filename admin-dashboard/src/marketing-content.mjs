import {resolve} from 'node:path';
const tasks=[
  ['pr','PR creation and manufacturing','Create and manufacture the PR materials.',0],
  ['brand-story','Brand storytelling post','One post leading up to the opening that tells the King Cajun brand story.',1],
  ['opening-soon','Opening soon post','One post leading up to the opening that announces “Opening soon”.',2],
  ['photoshoot-time','Confirm the food photoshoot date and time','Land on a final date and time for the food photoshoot.',3],
  ['photoshoot-people','Decide who appears in the photoshoot','Decide whether to invite camera-ready people to eat and be photographed during the food shoot.',4]
];
export function registerMarketing(app,{db,root,requireAdmin,sameOrigin}){
  const ready=(async()=>{
    await db.exec(`CREATE TABLE IF NOT EXISTS marketing_content_tasks(id TEXT PRIMARY KEY,title TEXT NOT NULL,description TEXT NOT NULL,sort_order INTEGER NOT NULL,done BOOLEAN NOT NULL DEFAULT FALSE,notes TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 1,updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    for(const row of tasks)await db.query('INSERT INTO marketing_content_tasks(id,title,description,sort_order) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',row);
  })();
  void ready.catch(()=>console.error('Marketing page initialization failed'));
  app.get('/marketing',requireAdmin,(_req,res)=>res.sendFile(resolve(root,'public/marketing.html')));
  app.get('/api/marketing',requireAdmin,async(_req,res)=>{try{await ready;res.json({tasks:(await db.query('SELECT * FROM marketing_content_tasks ORDER BY sort_order')).rows});}catch{res.status(500).json({error:'Could not load the checklist.'});}});
  app.post('/api/marketing/:id',requireAdmin,sameOrigin,async(req,res)=>{
    if(!req.is('application/json')||typeof req.body.done!=='boolean'||typeof req.body.notes!=='string'||req.body.notes.length>5000||!Number.isSafeInteger(req.body.version))return res.status(400).json({error:'Invalid task update.'});
    try{await ready;const result=await db.query('UPDATE marketing_content_tasks SET done=$1,notes=$2,version=version+1,updated_at=now() WHERE id=$3 AND version=$4 RETURNING *',[req.body.done,req.body.notes,req.params.id,req.body.version]);
      if(!result.rows.length)return res.status(409).json({error:'This task changed in another window. Your edits are still here; copy your notes before reloading.'});
      res.json({task:result.rows[0]});
    }catch{res.status(500).json({error:'Could not save. Your edits are still here.'});}
  });
}
