import {test} from 'node:test';
import assert from 'node:assert/strict';
import {toCsv, makeBackup, parseBackup, mergeEntries, saveSafetyCopy, loadSafetyCopy} from '../src/backup.js';
import {groupEntries, selectHistory} from '../src/collection.js';

const e=(o={})=>({entryId:'e'+Math.random(),id:'sf1',name:'Lightning Bolt',set:'m10',number:'146',setName:'Magic 2010',price:1.5,quantity:1,prices:{normal:1.5,foil:3},finish:'normal',language:'Fr',scannedAt:'2026-10-18T10:00:00Z',...o});
const mem=()=>({d:{},getItem(k){return k in this.d?this.d[k]:null},setItem(k,v){this.d[k]=v}});

test('CSV: BOM, semicolons, decimal commas, quoting and totals',()=>{
  const csv=toCsv([e({name:'Jace, "the Mind Sculptor"',quantity:2,price:12.5,finish:'foil'}),e({price:null})]);
  assert.ok(csv.startsWith('﻿Nom;Édition;'));
  const lines=csv.trim().split('\r\n');
  assert.equal(lines.length,3);
  assert.ok(lines[1].startsWith('"Jace, ""the Mind Sculptor""";Magic 2010;M10;146;FR;Foil;12,50;2;25,00;'));
  assert.ok(lines[2].includes(';Normal;;1;;'));
});
test('backup round trip keeps entries, drops junk and foreign files',()=>{
  const list=[e(),e({name:'X'})];
  const parsed=parseBackup(makeBackup(list));
  assert.equal(parsed.ok,true); assert.equal(parsed.entries.length,2); assert.equal(parsed.entries[0].name,'Lightning Bolt');
  assert.equal(parseBackup('{oops').ok,false);
  assert.equal(parseBackup('{"app":"other","session":[]}').ok,false);
  const dirty=parseBackup(JSON.stringify({app:'mtg-playin-scanner',session:[{name:'ok',id:'1',image:'http://evil/x.png',price:'12'},{nope:1},null]}));
  assert.equal(dirty.entries.length,1); assert.equal(dirty.skipped,2); assert.equal(dirty.entries[0].image,''); assert.equal(dirty.entries[0].price,null);
});
test('merge adds only what is missing and never removes',()=>{
  const have=[e({entryId:'a'}),e({entryId:'b'})];
  const added=mergeEntries(have,[{...e({entryId:'b'})},{...e({entryId:'c'})},{...e({entryId:null})}],()=>'new-id');
  assert.equal(added,2); assert.deepEqual(have.map(x=>x.entryId),['a','b','c','new-id']);
});
test('safety copy: at most hourly unless forced; empty collection never overwrites',()=>{
  const s=mem(); const list=[e()];
  assert.equal(saveSafetyCopy(list,s,1000),true);
  assert.equal(saveSafetyCopy(list,s,1000+1000),false);
  assert.equal(saveSafetyCopy(list,s,1000+1000,true),true);
  assert.equal(saveSafetyCopy(list,s,2000+3600001),true);
  assert.equal(saveSafetyCopy([],s,9e9,true),false);
  assert.equal(loadSafetyCopy(s).entries.length,1);
  assert.equal(loadSafetyCopy(mem()),null);
});
test('duplicates are grouped by printing, finish and language with quantity and total',()=>{
  const items=[e({entryId:'1'}),e({entryId:'2'}),e({entryId:'3',finish:'foil',price:3}),e({entryId:'4',id:'sf2'}),e({entryId:'5',price:null})];
  const groups=groupEntries(items);
  assert.equal(groups.length,3);
  const g=groups[0]; assert.equal(g.quantity,3); assert.equal(g.items.length,3); assert.equal(g.unpriced,1); assert.equal(Math.round(g.total*100),300);
  assert.equal(groups[1].quantity,1);
});
test('batch filter keeps only the current pile',()=>{
  const items=[e({entryId:'1',batch:'p1'}),e({entryId:'2',batch:'p2'}),e({entryId:'3'})];
  assert.deepEqual(selectHistory(items,{period:'batch',batchId:'p1'}).map(x=>x.entryId),['1']);
  assert.equal(selectHistory(items,{period:'all'}).length,3);
});
