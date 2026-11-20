let py;
async function ready(base){
 if(py)return;
 const {loadPyodide}=await import(/* @vite-ignore */new URL('python/pyodide.mjs',base).href);
 py=await loadPyodide({indexURL:new URL('python/',base).href});
 const response=await fetch(new URL('engine/research_engine.py',base));if(!response.ok)throw Error('ENGINE_SOURCE_UNAVAILABLE');
 py.globals.set('source',await response.text());
 py.runPython('import sys,types,json\nv1=types.ModuleType("research_engine")\nsys.modules["research_engine"]=v1\nexec(source,v1.__dict__)');
}
self.onmessage=async({data})=>{
 try{
  await ready(data.base);py.globals.set('payload',JSON.stringify(data.payload));let code='data=json.loads(payload)\n';
  if(data.op==='select')code+='rules=v1.load_rules("dev")\nrules.positive["keywords"].extend(data.get("keepTerms",[]))\nresult=v1.run(data["text"],rules=rules,cfg=v1.EngineConfig(ratio=data.get("ratio",.5))).to_dict()';
  else if(data.op==='prepare')code+='prompts=[]\nv1.compress(data["text"],llm_fn=lambda p:(prompts.append(p) or data["text"]),retries=0)\nresult={"prompt":prompts[0]}';
  else if(data.op==='finish')code+='result=v1.compress(data["text"],llm_fn=lambda p:data["candidate"],retries=0,protected_terms=data.get("keepTerms",[]))';
  else throw Error('UNKNOWN_ENGINE_OPERATION');
  const result=JSON.parse(py.runPython(code+'\njson.dumps(result,ensure_ascii=False)'));
  self.postMessage({id:data.id,ok:true,result});
 }catch(error){self.postMessage({id:data.id,ok:false,error:String(error.message)})}
};
