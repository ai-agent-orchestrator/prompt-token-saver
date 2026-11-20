import {countTokens} from './tokenizer.js';
import {sourceHash,cp} from './summary/normalize.js';
let worker,sequence=0;const pending=new Map();
export function execute(op,payload,{signal}={}){
 if(signal?.aborted)return Promise.reject(new DOMException('중단','AbortError'));
 if(!worker){worker=new Worker(new URL('./ver1-worker.js',import.meta.url),{type:'module'});worker.onmessage=({data})=>{const t=pending.get(data.id);if(!t)return;pending.delete(data.id);t.cleanup();data.ok?t.resolve(data.result):t.reject(Error(data.error))};worker.onerror=()=>{worker.terminate();worker=null;for(const t of pending.values()){t.cleanup();t.reject(Error('ENGINE_WORKER_FAILED'))}pending.clear()}}
 return new Promise((resolve,reject)=>{const id=++sequence;const abort=()=>{worker?.terminate();worker=null;for(const t of pending.values()){t.cleanup();t.reject(new DOMException('중단','AbortError'))}pending.clear()};const cleanup=()=>signal?.removeEventListener('abort',abort);signal?.addEventListener('abort',abort,{once:true});pending.set(id,{resolve,reject,cleanup});worker.postMessage({id,op,payload,base:new URL(import.meta.env.BASE_URL,location.href).href})});
}
export function modelPieces(text,maxTokens=1600){
 const result=[];let buffer='';for(const line of text.split('\n')){const next=buffer?buffer+'\n'+line:line;if(buffer&&countTokens(next)>maxTokens){result.push(buffer);buffer=line}else buffer=next}if(buffer)result.push(buffer);return result;
}
export async function summarize(text,opts={}){
 if(opts.signal?.aborted)throw new DOMException('중단','AbortError');
 const rpc=opts.executor||execute,started=performance.now();opts.onProgress?.('ver1 문장 선택 중…');
 const selection=await rpc('select',{text,ratio:opts.ratio??.5,keepTerms:opts.keepTerms||[]},opts);
 const selectionMs=performance.now()-started,warnings=[...(selection.warnings||[])],pieces=modelPieces(selection.extract),outputs=[];
 let calls=0,generationMs=0,validationMs=0,accepted=0;
 for(let i=0;i<pieces.length;i++){
  if(opts.signal?.aborted)throw new DOMException('중단','AbortError');const piece=pieces[i];let output=piece;
  if(opts.generator&&countTokens(piece)<=1600){
   opts.onProgress?.(`ver1 로컬 축약 · ${i+1}/${pieces.length}`);
   try{
    const {prompt}=await rpc('prepare',{text:piece},opts),generationStart=performance.now();calls++;
    const candidate=await opts.generator.generate({prompt,maxOutputTokens:768,signal:opts.signal});generationMs+=performance.now()-generationStart;
    const validationStart=performance.now(),check=await rpc('finish',{text:piece,candidate,keepTerms:opts.keepTerms||[]},opts);validationMs+=performance.now()-validationStart;
    if(!check.fallback&&countTokens(check.summary)<countTokens(piece)){output=check.summary;accepted++}else warnings.push('일부 모델 제안은 ver1 검사를 통과하지 못하거나 짧지 않아 선택 원문을 유지했습니다.');
   }catch(error){if(error.name==='AbortError')throw error;warnings.push('일부 로컬 모델 실행에 실패하여 ver1 선택 원문을 유지했습니다.');}
  }
  outputs.push(output);
 }
 if(opts.signal?.aborted)throw new DOMException('중단','AbortError');
 const body=outputs.join('\n'),input=countTokens(text),output=countTokens(body);
 return{schema:'pts.summary/v1',stage:opts.stage||1,status:body.trim()?'OK':'SOURCE_TOO_SHORT',body,sourceHash:await sourceHash(text),
  hybrid:{input_tokens:input,output_tokens:output,output_ratio:output/Math.max(1,input),budget:input,selected_ids:selection.selected_ids,units:selection.sentences,model_attempts:calls,modelFallback:calls>0&&accepted===0,elapsed_ms:performance.now()-started},
  metrics:{sourceCodepoints:cp(text),budget:cp(text),bodyCodepoints:cp(body),tokens:output,sourceTokens:input,tokenBudget:input,tokenizer:'o200k_base',enforceBudget:false,selectionMs,generationMs,validationMs},
  report:{engine:{version:'research-ver1',generatorId:calls?'LiteRT-LM':null,methodUsed:['ver1-sentence-selection','ver1-lexical-grounding']},groups:[],omittedGroups:[],omittedAnchors:[],warnings}};
}
export async function refine(first,opts={}){
 if(first?.report?.engine?.version!=='research-ver1')throw Error('ver1 요약하기 1을 먼저 실행해 주세요.');
 if(first.sourceHash!==await sourceHash(opts.text)){return{...first,stage:2,status:'FAILED',body:'',report:{...first.report,warnings:['SOURCE_CHANGED']}}}
 const run=await summarize(opts.text,{...opts,ratio:.3,stage:2});
 if(run.status!=='OK'||run.hybrid.output_tokens>=first.hybrid.output_tokens){run.status='NOT_REDUCIBLE';run.body=''}return run;
}
