import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseEur, cardmarketPrices, cardmarketUrl, sourceOf, totalsBySource} from '../src/cardmarket.js';
import {groupEntries, selectHistory} from '../src/collection.js';
import {toCsv, parseBackup, makeBackup} from '../src/backup.js';

// Real Scryfall data for Aphetto Exterminator (LGN #59): Manabox shows TREND 0,08 € / foil 1,01 €.
const LGN59={name:'Aphetto Exterminator',set_name:'Legions',prices:{usd:'0.15',usd_foil:'0.75',usd_etched:null,eur:'0.08',eur_foil:'1.01',tix:'0.05'},purchase_uris:{cardmarket:'https://www.cardmarket.com/en/Magic/Products?idProduct=2040&referrer=scryfall'}};
const e=(o={})=>({entryId:'e'+Math.random(),id:'a',name:'X',set:'lgn',number:'59',price:1,quantity:1,prices:{normal:1,foil:2},finish:'normal',language:'Fr',...o});

test('Cardmarket prices come from Scryfall eur / eur_foil and match the Manabox trend on the checked card',()=>{
  const p=cardmarketPrices(LGN59);
  assert.equal(p.normal,0.08); assert.equal(p.foil,1.01); assert.equal(p.edition,'Legions'); assert.equal(p.source,'cardmarket'); assert.equal(p.matched,true);
});
test('missing or invalid prices become null, never 0 or NaN',()=>{
  assert.equal(parseEur(null),null); assert.equal(parseEur(undefined),null); assert.equal(parseEur(''),null); assert.equal(parseEur('abc'),null); assert.equal(parseEur('-1'),null);
  assert.equal(parseEur('0'),0); assert.equal(parseEur('12.5'),12.5);
  const p=cardmarketPrices({set_name:'X',prices:{eur:null,eur_foil:'3.2'}});
  assert.equal(p.normal,null); assert.equal(p.foil,3.2);
  assert.deepEqual([cardmarketPrices({}).normal,cardmarketPrices(null).foil],[null,null]);
});
test('only Cardmarket product pages are ever opened',()=>{
  assert.match(cardmarketUrl(LGN59),/^https:\/\/www\.cardmarket\.com\//);
  assert.equal(cardmarketUrl({purchase_uris:{cardmarket:'https://evil.example/x'}}),null);
  assert.equal(cardmarketUrl({purchase_uris:{cardmarket:'javascript:alert(1)'}}),null);
  assert.equal(cardmarketUrl({}),null);
});
test('totals are kept apart per source; entries without a source count as Playin',()=>{
  const t=totalsBySource([e({price:2}),e({price:3,quantity:2,source:'cardmarket'}),e({price:null,source:'cardmarket'}),e({price:1})]);
  assert.deepEqual(t.playin,{cards:2,sum:3}); assert.deepEqual(t.cardmarket,{cards:3,sum:6});
  assert.equal(sourceOf({}),'playin'); assert.equal(sourceOf({source:'cardmarket'}),'cardmarket'); assert.equal(sourceOf({source:'weird'}),'playin');
});
test('the same printing scanned in both sources is never merged into one line',()=>{
  const groups=groupEntries([e({entryId:'1'}),e({entryId:'2',source:'cardmarket'}),e({entryId:'3',source:'cardmarket'})]);
  assert.equal(groups.length,2); assert.deepEqual(groups.map(g=>g.quantity).sort(),[1,2]);
});
test('the collection can be filtered by price source',()=>{
  const items=[e({entryId:'1'}),e({entryId:'2',source:'cardmarket'})];
  assert.deepEqual(selectHistory(items,{source:'cardmarket'}).map(x=>x.entryId),['2']);
  assert.deepEqual(selectHistory(items,{source:'playin'}).map(x=>x.entryId),['1']);
  assert.equal(selectHistory(items,{source:'all'}).length,2); assert.equal(selectHistory(items,{}).length,2);
});
test('CSV and backups keep the source',()=>{
  const csv=toCsv([e({source:'cardmarket'}),e()]).trim().split('\r\n');
  assert.ok(csv[0].endsWith(';Source des prix'));
  assert.ok(csv[1].endsWith(';Cardmarket (tendance)')); assert.ok(csv[2].endsWith(';Playin (rachat)'));
  const back=parseBackup(makeBackup([e({id:'a',name:'N',source:'cardmarket'}),e({id:'b',name:'M'})]));
  assert.equal(back.entries[0].source,'cardmarket'); assert.equal(back.entries[1].source,undefined);
});
