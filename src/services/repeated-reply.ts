import {normalizeText} from '../lib/format.js';
export function repeatsReply(next:string,previous:string){
 const a=normalizeText(next),b=normalizeText(previous);
 if(!a||!b)return false;
 if(a===b)return true;
 if(a.length<70||b.length<70)return false;
 // A changed amount, time or reference is new information, not a loop.
 if(JSON.stringify(a.match(/\d+/g))!==JSON.stringify(b.match(/\d+/g)))return false;
 const x=new Set(a.split(' ')),y=new Set(b.split(' '));
 return [...x].filter(t=>y.has(t)).length/new Set([...x,...y]).size>=0.9;
}
