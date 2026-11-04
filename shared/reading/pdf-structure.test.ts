import {test} from 'node:test';
import assert from 'node:assert/strict';
import {extractPdfStructure} from './pdf-structure.ts';
import {MIN_SECTION_WORDS} from './sections.ts';
import {compileImportPlan, rangeText} from '../imports/import-plan.ts';

test('PDF import keeps nested headings and uses bookmark heights for same-page exclusions',async()=>{
  let destroyed = false;
  const global = globalThis as Record<string,unknown>;
  global.pdfjsLib={getDocument:()=>({destroy:async()=>{destroyed=true;},promise:Promise.resolve({
    numPages:2,
    getOutline:async()=>[
      {title:'Part I',dest:[0,{name:'XYZ'},0,800],items:[
        {title:'Chapter A',dest:[0,{name:'XYZ'},0,700]},
        {title:'Chapter B',dest:[0,{name:'XYZ'},0,600]},
      ]},
      {title:'Part II',dest:'second'},
    ],
    getDestination:async()=>[1,{name:'XYZ'},0,800],
    getPage:async(n:number)=>({getTextContent:async()=>({items:n===1 ? [
      {str:'Part I',transform:[1,0,0,1,20,790]},
      {str:'Chapter A alpha',transform:[1,0,0,1,20,690]},
      {str:'Chapter B beta',transform:[1,0,0,1,20,590]},
    ] : [{str:'Part II gamma delta',transform:[1,0,0,1,20,790]}]})}),
  })})};
  try{
    const result=await extractPdfStructure(new Uint8Array(),1,global.pdfjsLib as Parameters<typeof extractPdfStructure>[2]);
    assert.equal(destroyed,true);
    assert.equal(result.outline.length,4);
    assert.equal(result.outline[1].parent,0);
    assert.deepEqual(result.defaultStarts,[3]);
    const [unit]=compileImportPlan({outline:result.outline,starts:[],excluded:[1]},result.pageText);
    const text=rangeText(unit.ranges,result.pageText);
    assert.doesNotMatch(text,/alpha/);
    assert.match(text,/beta/);
    assert.match(text,/gamma/);
  }finally{delete global.pdfjsLib;}
});

test('PDFs without bookmarks offer each detected chapter as a separate editable study group', async () => {
  const global = globalThis as Record<string,unknown>;
  const pages = [
    ['INTRODUCTION', 'Why this book exists.'],
    ['CHAPTER I Origins', 'ALPHA starts.'],
    ['ALPHA ends.', 'CHAPTER II Change', 'BETA starts.', 'INDEX', 'Origins, 2'],
  ];
  global.pdfjsLib = {getDocument: () => ({destroy:async()=>{},promise:Promise.resolve({
    numPages:pages.length, getOutline:async()=>null,
    getPage:async(n:number)=>({getTextContent:async()=>({items:pages[n-1].map(str=>({str,hasEOL:true}))})}),
  })})};
  try {
    const result = await extractPdfStructure(new Uint8Array(),MIN_SECTION_WORDS,global.pdfjsLib as Parameters<typeof extractPdfStructure>[2]);
    assert.deepEqual(result.defaultStarts,[1,2,3]);
    const groups = compileImportPlan({outline:result.outline,starts:result.defaultStarts,excluded:[0,3]},result.pageText);
    assert.equal(groups.length,2);
    assert.match(rangeText(groups[0].ranges,result.pageText),/ALPHA ends/);
    assert.doesNotMatch(rangeText(groups[0].ranges,result.pageText),/BETA/);
    assert.match(rangeText(groups[1].ranges,result.pageText),/BETA starts/);
    assert.doesNotMatch(rangeText(groups[1].ranges,result.pageText),/ALPHA|INDEX/);
    assert.equal(compileImportPlan({outline:result.outline,starts:[],excluded:[]},result.pageText).length,1,'readers can still join groups');
  } finally {delete global.pdfjsLib;}
});

test('page extraction errors fail the import instead of silently dropping pages',async()=>{
  let destroyed=false;
  const runtime={getDocument:()=>({destroy:async()=>{destroyed=true;},promise:Promise.resolve({
    numPages:1,getOutline:async()=>null,getDestination:async()=>null,getPageIndex:async()=>0,
    getPage:async()=>({getTextContent:async()=>{throw new Error('Unreadable page');}}),
  })})};
  await assert.rejects(extractPdfStructure(new Uint8Array(),1,runtime),/page 1: Unreadable page/);
  assert.equal(destroyed,true);
});
