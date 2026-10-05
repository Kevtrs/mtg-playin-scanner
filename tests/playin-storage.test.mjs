import {test} from 'node:test';
import assert from 'node:assert/strict';
import {printingScore, priceData} from '../src/playin.js';
import {loadSession, saveSession} from '../src/storage.js';

const mem=(init={})=>({d:{...init},getItem(k){return k in this.d?this.d[k]:null},setItem(k,v){this.d[k]=v}});
test('corrupt storage yields empty session and keeps a backup',()=>{
  const s=mem({'mtg-session':'{oops'});
  assert.deepEqual(loadSession(s),[]);
  assert.equal(s.d['mtg-session-corrupt-backup'],'{oops');
  assert.deepEqual(loadSession(mem({'mtg-session':'{"a":1}'})),[]);
  assert.deepEqual(loadSession(mem({'mtg-session':'[{"name":"x"},null,3]'})),[{name:'x'}]);
});
test('unavailable or full storage does not throw',()=>{
  const broken={getItem(){throw new Error('denied')},setItem(){throw new Error('quota')}};
  assert.deepEqual(loadSession(broken),[]);
  assert.equal(saveSession([],broken),false);
  assert.equal(saveSession([],mem()),true);
});
const variants=(n,f)=>[{label:'Fr Mint/Nmint',price:n,foil:false},{label:'Fr Mint/Nmint foil',price:f,foil:true}];
test('plain card without frame_effects prefers the plain printing over showcase',()=>{
  const card={name:'Éclair',set_name:'Murders at Karlov Manor',promo:false,full_art:false};
  const plain={edition:'Murders at Karlov Manor',nameEn:'Éclair',variants:variants(1,2)};
  const showcase={edition:'Murders at Karlov Manor Showcase',nameEn:'Éclair',variants:variants(9,19)};
  assert.ok(printingScore(plain,card)>printingScore(showcase,card));
  assert.equal(priceData(card,[showcase,plain],'Fr').normal,1);
});
