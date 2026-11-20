import {modelCapabilities} from './generator.js';

export const DEFAULT_MODEL=Object.freeze({
 name:'Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm',
 revision:'8d42ab5f1db14cad987fac57aeb17d070f9e180d',
 bytes:343490560,
 url:'https://huggingface.co/litert-community/Qwen3-0.6B/resolve/8d42ab5f1db14cad987fac57aeb17d070f9e180d/Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm',
});
const interrupted=signal=>{if(signal?.aborted)throw new DOMException('중단','AbortError')};
export function requireAutomaticSupport(environment=globalThis){const support=modelCapabilities(environment);if(!support.webgpu||!support.worker||!support.locks||!support.secureContext)throw Error('이 브라우저에서는 기기 내 요약을 실행할 수 없습니다. WebGPU를 지원하는 최신 Chrome 또는 Edge에서 열어 주세요.')}

// Stream into origin-private storage: do not buffer a ~2 GB response in memory.
// Completion metadata is written last; cancelled/partial files are never reused.
export async function prepareDefaultModel({signal,onStatus=()=>{},storage=globalThis.navigator?.storage,locks=globalThis.navigator?.locks,fetchFn=globalThis.fetch,spec=DEFAULT_MODEL,checkSupport=requireAutomaticSupport}={}){
 interrupted(signal);checkSupport();
 if(!storage?.getDirectory)throw Error('모델을 저장할 수 없는 브라우저입니다. 최신 Chrome 또는 Edge에서 다시 열어 주세요.');
 const prepare=async()=>{
  interrupted(signal);
  const root=await storage.getDirectory();
  const directory=await root.getDirectoryHandle('token-saver-public-models',{create:true});
  const fileName=spec.revision+'-'+spec.name;
  const metadataName=fileName+'.complete.json';
  try{
   const metadata=JSON.parse(await(await(await directory.getFileHandle(metadataName)).getFile()).text());
   const file=await(await directory.getFileHandle(fileName)).getFile();
   if(metadata.revision===spec.revision&&metadata.bytes===spec.bytes&&file.size===spec.bytes){onStatus('저장된 AI를 준비하고 있습니다…');return file}
  }catch(error){if(signal?.aborted)throw error;/* Missing/incomplete cache is downloaded again. */}
  const capacity=await storage.estimate?.();
  if(capacity?.quota&&capacity.quota-(capacity.usage||0)<spec.bytes+32*1024*1024)throw Error('첫 실행용 AI를 저장할 공간이 부족합니다. 기기에 약 400MB의 여유 공간을 확보해 주세요.');
  onStatus(`첫 실행용 작은 AI를 준비합니다 · 약 ${Math.round(spec.bytes/1e6)}MB 다운로드 · 다음부터 재사용합니다.`);
  let response;
  try{response=await fetchFn(spec.url,{signal,credentials:'omit',referrerPolicy:'no-referrer'})}catch(error){if(signal?.aborted)throw new DOMException('중단','AbortError');throw Error('AI 준비 파일을 내려받지 못했습니다. 인터넷 연결을 확인하고 요약하기를 다시 눌러 주세요.')}
  if(!response.ok||!response.body)throw Error('AI 준비 파일을 내려받지 못했습니다. 잠시 후 요약하기를 다시 눌러 주세요.');
  let writer;
  try{writer=await(await directory.getFileHandle(fileName,{create:true})).createWritable()}
  catch{try{await response.body.cancel()}catch{}throw Error('AI 파일을 저장할 공간이 부족하거나 기기 저장소를 사용할 수 없습니다. 기기의 여유 공간을 확인해 주세요.')}
  const reader=response.body.getReader();let received=0,previous=-1;
  const cancel=()=>{void reader.cancel().catch(()=>{})};signal?.addEventListener('abort',cancel,{once:true});
  try{
   while(true){interrupted(signal);const {done,value}=await reader.read();interrupted(signal);if(done)break;received+=value.byteLength;if(received>spec.bytes)throw Error('AI 파일 크기가 맞지 않습니다. 다시 시도해 주세요.');await writer.write(value);const percent=Math.floor(received/spec.bytes*100);if(percent!==previous){previous=percent;onStatus(`첫 실행용 AI 준비 ${percent}% · ${Math.round(received/1024/1024)} / ${Math.round(spec.bytes/1024/1024)}MB`)}}
   if(received!==spec.bytes)throw Error('AI 다운로드가 완료되지 않았습니다. 요약하기를 다시 누르면 재시도합니다.');
   await writer.close();interrupted(signal);
   const meta=await(await directory.getFileHandle(metadataName,{create:true})).createWritable();
   await meta.write(JSON.stringify({revision:spec.revision,bytes:spec.bytes}));await meta.close();
   const file=await(await directory.getFileHandle(fileName)).getFile();
   onStatus('AI 다운로드 완료 · 이 기기에서 요약을 준비합니다.');return file;
  }catch(error){try{await writer.abort()}catch{}throw error}
  finally{signal?.removeEventListener('abort',cancel);try{await reader.cancel()}catch{}reader.releaseLock()}
 };
 onStatus('AI를 준비하고 있습니다…');
 return locks?.request?locks.request('token-saver-default-model-download',{mode:'exclusive',...(signal?{signal}:{})},prepare):prepare();
}
