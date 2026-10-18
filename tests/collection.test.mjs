import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ScanGate, ScanLock, selectHistory, filterEditions, sameIllustration} from '../src/collection.js';

test('held card never counts twice, including printing-ID jitter and uncertain frames',()=>{
 const gate=new ScanGate();
 assert.equal(gate.accept({cardId:'a',secondaryId:'art-a'}),true);
 for(let i=0;i<100;i++) {gate.observe({cardPresent:true,cornersValid:i%2===0},i*700); assert.equal(gate.accept({cardId:'a'+i,secondaryId:'art-a'}),false);}
 gate.observe({cardPresent:false},100000); gate.observe({cardPresent:true},100700);
 assert.equal(gate.accept({cardId:'a',secondaryId:'art-a'}),false);
});
test('stable empty frame rearms same card; confirmed different card works immediately',()=>{
 const gate=new ScanGate(); gate.accept({cardId:'a'});
 assert.equal(gate.observe({cardPresent:false},0),false);
 assert.equal(gate.observe({cardPresent:false},700),false);
 assert.equal(gate.observe({cardPresent:false},1400),true);
 assert.equal(gate.accept({cardId:'a'}),true);
 assert.equal(gate.accept({cardId:'b'}),true);
 assert.equal(gate.accept({cardId:'b'}),false);
});
const now=new Date('2026-10-05T12:00:00Z');
const items=[{name:'Anneau',price:0,scannedAt:'2026-10-05T08:00:00Z'},{name:'Éclair',price:12,scannedAt:'2026-10-04T12:00:00Z'},{name:'Inconnu',price:null},{name:'Ancienne',price:2,scannedAt:'2026-08-01T08:00:00Z'}];
test('price sorting keeps unknown last, zero valid, and min/max compose with period',()=>{
 assert.deepEqual(selectHistory(items,{sort:'price-desc'}).map(i=>i.price),[12,2,0,null]);
 assert.deepEqual(selectHistory(items,{sort:'price-asc'}).map(i=>i.price),[0,2,12,null]);
 assert.deepEqual(selectHistory(items,{min:1,max:15,period:'7d'},now).map(i=>i.name),['Éclair']);
 assert.equal(selectHistory(items,{min:0,max:0})[0].name,'Anneau');
 assert.equal(selectHistory(items,{search:'eclair'})[0].name,'Éclair');
 assert.deepEqual(selectHistory(items,{period:'today'},now).map(i=>i.name),['Anneau']);
 assert.equal(selectHistory(items,{sort:'oldest'})[0].name,'Ancienne');
 assert.equal(items[0].name,'Anneau');
});
test('scan lock blocks while busy and for 2s after finishing',()=>{
 const lock=new ScanLock(2000);
 assert.equal(lock.canScan(0),true);
 lock.start();
 assert.equal(lock.canScan(10000),false);
 lock.finish(10000);
 assert.equal(lock.canScan(11999),false);
 assert.equal(lock.canScan(12000),true);
});

test('editions filter matches set name, code and number, folds accents and caps the list',()=>{
 const list=[{set:'4ed',set_name:'Fourth Edition',collector_number:'145'},{set:'rqs',set_name:'Rivals Quick Start Set',collector_number:'19'},{set:'5ed',set_name:'Fifth Edition',collector_number:'175'},{set:'ren',set_name:'Renaissance',collector_number:'58'}];
 assert.equal(filterEditions(list,'').shown.length,4);
 assert.deepEqual(filterEditions(list,'fourth').shown.map(p=>p.set),['4ed']);
 assert.deepEqual(filterEditions(list,'rqs').shown.map(p=>p.set),['rqs']);
 assert.deepEqual(filterEditions(list,'edition 175').shown.map(p=>p.set),['5ed']);
 assert.deepEqual(filterEditions(list,'RENAISSANCE').shown.map(p=>p.set),['ren']);
 assert.equal(filterEditions(list,'zzz').shown.length,0);
 const many=Array.from({length:100},(_,i)=>({set:'s'+i,set_name:'Set '+i,collector_number:String(i)}));
 const capped=filterEditions(many,'',40); assert.equal(capped.shown.length,40); assert.equal(capped.hidden,60);
});

test('only printings with the same illustration are offered as edition doubts',()=>{
 const list=[{id:'a',set:'fdc',illustration_id:'art1'},{id:'b',set:'sld',illustration_id:'art2'},{id:'c',set:'30a',illustration_id:'art1'},{id:'d',card_faces:[{illustration_id:'art1'}],set:'lea'}];
 assert.deepEqual(sameIllustration(list,list[0]).map(p=>p.id),['a','c','d']);
 assert.deepEqual(sameIllustration(list,list[1]).map(p=>p.id),['b']);
 assert.deepEqual(sameIllustration(list,{id:'x'}),[]);
});
