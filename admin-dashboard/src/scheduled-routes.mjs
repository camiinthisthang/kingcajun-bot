import {readScheduledGroups,transitionScheduledGroup} from './scheduled-orders.mjs';
export function registerScheduledRoutes(app,{db,root,requireAdmin,sameOrigin,adminUser}){
 app.get('/delivery-groups',requireAdmin,(_req,res)=>res.sendFile(root+'/public/delivery-groups.html'));
 app.get('/api/admin/delivery-groups',requireAdmin,async(req,res)=>{try{
  if(!/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date)))return res.status(400).json({error:'Elige una fecha.'});
  res.json(await readScheduledGroups(db,req.query.date));
 }catch(e){res.status(e.status||500).json({error:e.message});}});
 app.post('/api/admin/delivery-groups/:id',requireAdmin,sameOrigin,async(req,res)=>{try{
  res.json(await transitionScheduledGroup(db,req.params.id,req.body.action,{id:'admin:'+adminUser,name:adminUser,roles:['Dispatcher']},req.body.ready));
 }catch(e){res.status(e.status||500).json({error:e.message});}});
}
