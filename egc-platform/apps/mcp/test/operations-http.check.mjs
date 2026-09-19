/** Real MCP HTTP boundary tests using isolated child processes and no provider credentials. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {request as httpRequest} from 'node:http';
import {fileURLToPath} from 'node:url';
const token='isolated-http-test-credential-never-production-0123456789';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function start(enabled) {
  const probe=createServer();
  await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(0,'127.0.0.1',resolve);});
  const port=probe.address().port;
  await new Promise(resolve=>probe.close(resolve));
  const origin=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,[fileURLToPath(new URL('../dist/server.js',import.meta.url))],{
    env:{PATH:process.env.PATH??'',NODE_ENV:'test',PORT:String(port),MCP_PUBLIC_ORIGIN:origin,
      MCP_ALLOWED_HOSTS:'127.0.0.1',MCP_BEARER_TOKEN:token,EGC_OPERATIONS_ENABLED:String(enabled),GHL_WRITEBACK_ENABLED:'false'},
    stdio:['ignore','pipe','pipe']
  });
  let output='';
  child.stdout.on('data',b=>{output=(output+b.toString()).slice(-16000);});
  child.stderr.on('data',b=>{output=(output+b.toString()).slice(-16000);});
  async function rpc(method,params={},authenticated=false,extraHeaders={}) {
    const response=await fetch(`${origin}/mcp`,{method:'POST',signal:AbortSignal.timeout(5000),headers:{
      'Content-Type':'application/json','Accept':'application/json,text/event-stream',
      ...(authenticated?{Authorization:`Bearer ${token}`} : {}),...extraHeaders},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
    const text=await response.text();
    const data=response.headers.get('content-type')?.includes('text/event-stream')?
      JSON.parse(text.split('\n').find(line=>line.startsWith('data: '))?.slice(6)||'null'):JSON.parse(text);
    return {status:response.status,data};
  }
  async function stop() {
    if(child.exitCode!==null)return;
    child.kill('SIGTERM');
    for(let i=0;i<40&&child.exitCode===null&&child.signalCode===null;i++)await sleep(25);
    if(child.exitCode===null)child.kill('SIGKILL');
  }
  try {
    for(let i=0;i<100;i++){
      if(child.exitCode!==null)throw new Error(`MCP exited before ready: ${output}`);
      if(output.includes('EGC MCP listening'))return {rpc,stop,origin};
      await sleep(30);
    }
    throw new Error(`MCP startup timed out: ${output}`);
  }catch(error){await stop();throw error;}
}
for(const enabled of [false,true]) {
  test(`real MCP initialize/discovery/authentication in operations=${enabled}`,{timeout:15000},async()=>{
    const server=await start(enabled);
    try {
      const initialized=await server.rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'isolated-egc-ci',version:'1'}});
      assert.equal(initialized.status,200);assert.ok(initialized.data.result.serverInfo);
      const listed=await server.rpc('tools/list');assert.equal(listed.status,200);
      const tools=listed.data.result.tools,names=tools.map(tool=>tool.name);
      assert.ok(tools.length>50);assert.equal(new Set(names).size,names.length,'Each tool must be registered exactly once');
      for(const name of ['egc.job_brief','egc.customer_history'])assert.equal(names.filter(n=>n===name).length,1);
      const job=tools.find(t=>t.name==='egc.job_brief');
      assert.match(job.description,enabled?/Employee Hub/:/PostgreSQL/);
      for(const t of tools){assert.equal(t.inputSchema.type,'object');assert.doesNotThrow(()=>JSON.stringify(t.inputSchema));}
      for(const name of ['actions.propose','actions.edit','actions.complete','actions.cancel','egc.generate_brief']){
        const tool=tools.find(t=>t.name===name);assert.equal(tool.annotations.readOnlyHint,false);
        assert.ok(tool._meta.securitySchemes.some(s=>s.scopes.includes('egc:write')));
      }
      const unauthorized=await server.rpc('tools/call',{name:'actions.queue',arguments:{}});
      assert.equal(unauthorized.status,200);assert.equal(unauthorized.data.result.isError,true);
      assert.ok(unauthorized.data.result._meta['mcp/www_authenticate']);
      const status=await server.rpc('tools/call',{name:'egc.operations_status',arguments:{}},true);
      assert.equal(status.status,200);
      const payload=JSON.parse(status.data.result.content[0].text);
      assert.equal(payload.error,enabled?'operations_bridge_not_configured':'operations_not_enabled');
      if(enabled){
        for(const name of ['send_sms','conversations.send_message','egc.ensure_booking','appointments.delete','tasks.update','walkthroughs.approve']){
          const denied=await server.rpc('tools/call',{name,arguments:{}},true);
          assert.equal(denied.status,200);assert.equal(denied.data.result.isError,true);
          assert.equal(JSON.parse(denied.data.result.content[0].text).error,'legacy_mutation_disabled_in_operations_mode');
        }
      }
      // Node fetch may normalize Host. A raw HTTP request tests the actual host guard.
      const invalidHost=await new Promise((resolve,reject)=>{
        const request=httpRequest(`${server.origin}/mcp`,{method:'POST',headers:{Host:'not-allowed.test','Content-Type':'application/json'}},response=>{
          let body='';response.on('data',chunk=>body+=chunk);response.on('end',()=>resolve({status:response.statusCode,data:JSON.parse(body)}));
        });request.once('error',reject);request.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'}));
      });
      assert.equal(invalidHost.status,403);assert.equal(invalidHost.data.error,'invalid_host');
      const batch=await fetch(`${server.origin}/mcp`,{method:'POST',headers:{'Content-Type':'application/json'},body:'[]'});
      assert.equal(batch.status,400);
    }finally{await server.stop();}
  });
}
