import {test} from 'node:test';
import assert from 'node:assert/strict';
import {printingScore, priceData} from '../src/playin.js';
import {loadSession, saveSession, loadPriceCache, savePriceCache, PRICE_TTL_MS} from '../src/storage.js';

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
import {searchName, compactRows, normalizedWords, editionOverlap} from '../src/playin.js';
test('double-faced cards are searched by their front face',()=>{
  assert.equal(searchName({name:'Delver of Secrets // Insectile Aberration'}),'Delver of Secrets');
  assert.equal(searchName({name:'Éclair'}),'Éclair');
});

test('price cache keeps fresh entries, drops expired ones and survives bad data',()=>{
  const s=mem(); const now=1_000_000_000_000;
  const c=new Map([['fresh',{t:now-1000,rows:[{a:1}]}],['old',{t:now-PRICE_TTL_MS-1,rows:[{a:2}]}]]);
  assert.equal(savePriceCache(c,s),true);
  const back=loadPriceCache(s,now);
  assert.deepEqual([...back.keys()],['fresh']);
  assert.equal(loadPriceCache(mem({'mtg-price-cache':'{oops'}),now).size,0);
  assert.equal(loadPriceCache({getItem(){throw new Error('x')}},now).size,0);
});
test('price cache keeps the newest entries when the quota is hit',()=>{
  let calls=0;
  const small={d:{},getItem(){return null},setItem(k,v){calls++; if(JSON.parse(v)&&Object.keys(JSON.parse(v)).length>10) throw new Error('quota'); this.d[k]=v;}};
  const c=new Map(); for(let i=0;i<40;i++) c.set('k'+i,{t:i,rows:[{}]});
  assert.equal(savePriceCache(c,small),true);
  const kept=Object.keys(JSON.parse(small.d['mtg-price-cache']));
  assert.ok(kept.length<=10 && kept.includes('k39'));
});

test('compacted rows give the same prices as the full rows and are smaller',()=>{
  const card={name:'Éclair',set_name:'Murders at Karlov Manor',promo:false,full_art:false};
  const rows=[{nameFr:'Éclair',nameEn:'Éclair',edition:'Murders at Karlov Manor',variants:[
    {label:'Fr Mint/Nmint',price:1,foil:false},{label:'Fr Mint/Nmint foil',price:2,foil:true},
    {label:'Fr Played',price:0.5,foil:false},{label:'En Heavily Played',price:0.1,foil:false},{label:'En Mint/Nmint',price:1.2,foil:false}]}];
  const compact=compactRows(rows);
  for(const lang of ['Fr','En']) assert.deepEqual(priceData(card,compact,lang),priceData(card,rows,lang));
  assert.ok(JSON.stringify(compact).length<JSON.stringify(rows).length);
  assert.deepEqual(compactRows([{nameFr:'a',nameEn:'a',edition:'x',variants:[{label:'Fr Played',price:1,foil:false}]}]),[]);
});

const mk=(edition,n=1)=>({nameFr:'x',nameEn:'Lightning Bolt',edition,variants:[{label:'Fr Mint/Nmint',price:n,foil:false},{label:'Fr Mint/Nmint foil',price:n*2,foil:true}]});
test('ordinals and French editions line up (Fourth Edition = 4eme Edition)',()=>{
  assert.deepEqual(normalizedWords('Fourth Edition'),['4']);
  assert.deepEqual(normalizedWords('4ème Edition'),['4']);
  assert.deepEqual(normalizedWords('Classic Sixth Edition'),['classic','6']);
  assert.deepEqual(normalizedWords('Magic: The Gathering | Le Hobbit'),['hobbit']);
  const card={name:'Lightning Bolt',set_name:'Fourth Edition'};
  const rows=[mk('Alpha',300),mk('4ème Edition',1),mk('Beatdown',2.5)];
  assert.equal(priceData(card,rows,'Fr').normal,1);
});
test("no equivalent Playin edition means no price, never another edition's price",()=>{
  const card={name:'Lightning Bolt',set_name:'The List'};
  const out=priceData(card,[mk('4ème Edition',1),mk('Alpha',300)],'Fr');
  assert.equal(out.normal,null); assert.equal(out.foil,null); assert.equal(out.matched,false); assert.equal(out.ambiguous,false);
});
test('ambiguous siblings give no price instead of a coin flip',()=>{
  const card={name:'Lightning Bolt',set_name:'Zendikar Rising',promo:false,full_art:false};
  const out=priceData(card,[mk('Zendikar',1),mk("Zendikar l'Eveil",2)],'Fr');
  assert.equal(out.matched,false); assert.equal(out.ambiguous,true); assert.equal(out.normal,null);
});
test('close English/French cognates still match',()=>{
  assert.ok(editionOverlap({edition:'Légendes'},{set_name:'Legends'})>=2);
  assert.ok(editionOverlap({edition:'Spirale Temporelle'},{set_name:'Time Spiral'})>=2);
  assert.equal(editionOverlap({edition:'Alpha'},{set_name:'The List'}),0);
});
