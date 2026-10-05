import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ScanGate, selectHistory} from '../src/collection.js';

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
