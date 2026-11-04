import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compileImportPlan, rangeText, type ImportPlan} from './import-plan.ts';

const pages = ['Abstract. Intro. Method. OMIT THIS. Results.', 'Conclusion.'];
const outline = [
  {id:0,label:'Introduction',page:1,offset:10,depth:0,parent:null},
  {id:1,label:'Method',page:1,offset:17,depth:1,parent:0},
  {id:2,label:'Appendix detail',page:1,offset:25,depth:1,parent:0},
  {id:3,label:'Results',page:1,offset:36,depth:0,parent:null},
  {id:4,label:'Conclusion',page:2,offset:0,depth:0,parent:null},
];
const plan: ImportPlan = {outline,starts:[],excluded:[2]};

test('one joined unit excludes text inside a page while retaining the abstract and later sections', () => {
  const [unit] = compileImportPlan(plan,pages);
  const text = rangeText(unit.ranges,pages);
  assert.match(text,/Abstract\. Intro\. Method\./);
  assert.doesNotMatch(text,/OMIT THIS/);
  assert.match(text,/Results\./);
  assert.match(text,/\[page 2\]\nConclusion/);
});

test('splitting on the same page never repeats or loses selected text', () => {
  const groups = compileImportPlan({...plan,starts:[3]},pages);
  assert.equal(groups.length,2);
  assert.doesNotMatch(rangeText(groups[0].ranges,pages),/Results/);
  assert.match(rangeText(groups[1].ranges,pages),/Results/);
  assert.equal(groups[0].ranges.at(-1)!.end,25);
  assert.equal(groups[1].ranges[0].start,36);
});

test('an unchanged plan covers every character exactly once', () => {
  const groups = compileImportPlan({...plan,excluded:[],starts:[3]},pages);
  const kept = groups.flatMap(g=>g.ranges).map(r=>pages[r.page-1].slice(r.start,r.end)).join('');
  assert.equal(kept,pages.join(''));
});

test('invalid plans are rejected before persistence', () => {
  for (const invalid of [null,{}, {...plan,excluded:[0,1,2,3,4]}, {...plan,starts:[0]}, {...plan,starts:[1,1]}, {...plan,excluded:[99]}, {...plan,outline:[{...outline[0],offset:999}]}, {...plan,outline:[outline[0],{...outline[1],parent:2}]}, {...plan,outline:[outline[0],{...outline[1],offset:0}]}, {...plan,outline:[{...outline[0],depth:2}]}]) {
    assert.throws(()=>compileImportPlan(invalid,pages));
  }
});
