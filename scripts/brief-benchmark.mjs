import fs from 'node:fs';
import { summarize, refine } from '../apps/tablet/src/core/summary/engine.js';
import { syntheticResearch } from '../apps/tablet/src/demo.js';
const inputs = [['notes-ko',fs.readFileSync('prompt_token_saver/demo/notes_ko.md','utf8')],['synthetic',syntheticResearch().text]];
const privatePath='spec/fixtures/private/ontology-source.txt';
if(fs.existsSync(privatePath)) inputs.push(['user-source-local-only',fs.readFileSync(privatePath,'utf8')]);
const record=[];
for(const [id,text] of inputs){
 const start=performance.now();const first=await summarize(text);const elapsed=performance.now()-start;const second=await refine(first,{text});
 record.push({id,sourceCodepoints:first.metrics.sourceCodepoints,budget:first.metrics.budget,firstStatus:first.status,firstBodyCodepoints:first.metrics.bodyCodepoints,secondStatus:second.status,secondBodyCodepoints:second.metrics.bodyCodepoints,firstElapsedMs:Math.round(elapsed*100)/100});
}
fs.writeFileSync('docs/brief-validation.json',JSON.stringify({engine:'brief-1.0.0',date:'2026-11-19',jsTests:71,pythonTests:335,modelQuality:'NOT_MEASURED',records:record},null,2)+'\n');
console.log(JSON.stringify(record));
