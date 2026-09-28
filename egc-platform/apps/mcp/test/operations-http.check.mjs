/** Real MCP HTTP boundary tests using isolated child processes and no provider credentials. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {request as httpRequest} from 'node:http';
import {fileURLToPath} from 'node:url';
const token='isolated-http-test-credential-never-production-0123456789';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function start(enabled,extraEnv={}) {
  const probe=createServer();
  await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(0,'127.0.0.1',resolve);});
  const port=probe.address().port;
  await new Promise(resolve=>probe.close(resolve));
  const origin=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,[fileURLToPath(new URL('../dist/server.js',import.meta.url))],{
    env:{PATH:process.env.PATH??'',NODE_ENV:'test',PORT:String(port),MCP_PUBLIC_ORIGIN:origin,
      MCP_ALLOWED_HOSTS:'127.0.0.1',MCP_BEARER_TOKEN:token,EGC_OPERATIONS_ENABLED:String(enabled),GHL_WRITEBACK_ENABLED:'false',...extraEnv},
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
    for(let i=0;i<300;i++){
      if(child.exitCode!==null)throw new Error(`MCP exited before ready: ${output}`);
      if(output.includes('EGC MCP listening'))return {rpc,stop,origin};
      await sleep(30);
    }
    throw new Error(`MCP startup timed out: ${output}`);
  }catch(error){await stop();throw error;}
}
for(const enabled of [false,true]) {
  test(`real MCP initialize/discovery/authentication in operations=${enabled}`,{timeout:15000},async()=>{
    const server=await start(enabled,{MCP_BEARER_WRITE_ENABLED:'true'});
    try {
      const initialized=await server.rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'isolated-egc-ci',version:'1'}});
      assert.equal(initialized.status,200);assert.ok(initialized.data.result.serverInfo);
      const listed=await server.rpc('tools/list');assert.equal(listed.status,200);
      const tools=listed.data.result.tools,names=tools.map(tool=>tool.name);
      assert.ok(tools.length>50);assert.equal(new Set(names).size,names.length,'Each tool must be registered exactly once');
      for(const name of ['egc.job_brief','egc.customer_history'])assert.equal(names.filter(n=>n===name).length,1);
      for(const name of ['actions.complete_from_message','egc.visit_get','egc.schedule_visit','appointments.operation_status','appointments.reconcile'])assert.equal(names.filter(n=>n===name).length,1);
      const job=tools.find(t=>t.name==='egc.job_brief');
      assert.match(job.description,enabled?/Employee Hub/:/PostgreSQL/);
      for(const t of tools){assert.equal(t.inputSchema.type,'object');assert.doesNotThrow(()=>JSON.stringify(t.inputSchema));}
      for(const name of ['actions.propose','actions.edit','actions.complete','actions.complete_from_message','actions.cancel','egc.generate_brief','egc.schedule_visit','appointments.reconcile']){
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
        for(const name of ['appointments.delete','tasks.update','jobs.add_note','walkthroughs.create_draft','walkthroughs.update_draft','walkthroughs.approve']){
          const denied=await server.rpc('tools/call',{name,arguments:{}},true);
          assert.equal(denied.status,200);assert.equal(denied.data.result.isError,true);
          assert.equal(JSON.parse(denied.data.result.content[0].text).error,'legacy_mutation_disabled_in_operations_mode');
        }
        // One-step customer sends stay blocked in operations mode until EGC_MCP_DIRECT_SENDS_ENABLED=true.
        for(const name of ['conversations.send_message','send_sms','egc.send_followup']){
          const denied=await server.rpc('tools/call',{name,arguments:{requestId:'3f6c1c2e-8a4b-4d7e-9f10-2b3c4d5e6f70',contactId:'ac178de9-8156-42b8-818c-83e21c12c099',channel:'SMS',body:'Synthetic',contextReviewed:true}},true);
          assert.equal(denied.status,200);assert.equal(denied.data.result.isError,true);
          const payload=JSON.parse(denied.data.result.content[0].text);
          assert.equal(payload.error,'direct_send_disabled_in_operations_mode');assert.equal(payload.sent,false);
          assert.match(payload.instruction,/approval does not send/);assert.doesNotMatch(payload.instruction,/sends? (?:it|them) from the Employee Hub/);
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

for(const enabled of [false,true]) {
  test(`static bearer is read-only by default and every write tool demands egc:write in operations=${enabled}`,{timeout:20000},async()=>{
    const server=await start(enabled);
    try {
      const tools=(await server.rpc('tools/list')).data.result.tools;
      const writes=tools.filter(t=>t.annotations?.readOnlyHint===false);
      assert.ok(writes.length>20);
      for(const t of tools)assert.equal(typeof t.annotations?.readOnlyHint,'boolean',`${t.name} must be classified`);
      for(const t of writes){
        assert.ok(t._meta.securitySchemes.some(s=>s.scopes.includes('egc:write')),t.name);
        const denied=await server.rpc('tools/call',{name:t.name,arguments:{}},true);
        assert.equal(denied.data.result.isError,true,t.name);
        assert.match(denied.data.result._meta['mcp/www_authenticate'][0],/scope="egc:write"/,t.name);
      }
      const policy=await server.rpc('tools/call',{name:'egc.safety_policy',arguments:{}},true);
      assert.equal(policy.data.result.isError,undefined);
      const value=policy.data.result.structuredContent.result;
      assert.equal(value.mode,enabled?'action_center':'legacy');
      assert.equal(value.customerSends.oneStepMcpSends,enabled?'blocked':'enabled');
      const strict=await server.rpc('tools/call',{name:'egc.safety_policy',arguments:{role:'owner'}},true);
      assert.equal(strict.data.result.isError,true);assert.match(strict.data.result.content[0].text,/Input validation error/);
      const info=await fetch(`${server.origin}/mcp-info`,{signal:AbortSignal.timeout(5000)});
      const text=await info.text();
      assert.match(text,/egc:write/);assert.doesNotMatch(text,/read-only MCP/);
      assert.match(text,enabled?/One-step MCP customer sends are paused/:/can send SMS and email/);
    }finally{await server.stop();}
  });
}

test('/mcp/oauth answers with HTTP 401/403 challenges per the MCP authorization spec while /mcp keeps open discovery',{timeout:20000},async()=>{
  const server=await start(true,{MCP_OAUTH_DCR_ENABLED:'true'});
  try {
    const post=(body,headers={})=>fetch(`${server.origin}/mcp/oauth`,{method:'POST',signal:AbortSignal.timeout(5000),headers:{'Content-Type':'application/json','Accept':'application/json,text/event-stream',...headers},body:JSON.stringify(body)});
    const params={protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'isolated-egc-ci',version:'1'}};
    const anonymous=await post({jsonrpc:'2.0',id:1,method:'initialize',params});
    assert.equal(anonymous.status,401);
    assert.equal(anonymous.headers.get('www-authenticate'),`Bearer resource_metadata="${server.origin}/.well-known/oauth-protected-resource/mcp/oauth", scope="egc:read egc:write"`);
    // No database in this check: an OAuth token cannot be verified, which is a retryable 503, never a pass or a crash.
    const unverifiable=await post({jsonrpc:'2.0',id:1,method:'initialize',params},{Authorization:'Bearer egc_at_isolated-unverifiable-token'});
    assert.equal(unverifiable.status,503);assert.equal((await unverifiable.json()).error.code,-32603);
    const metadata=await (await fetch(`${server.origin}/.well-known/oauth-protected-resource/mcp/oauth`,{signal:AbortSignal.timeout(5000)})).json();
    assert.equal(metadata.resource,`${server.origin}/mcp/oauth`);assert.deepEqual(metadata.authorization_servers,[server.origin]);
    const authed=await post({jsonrpc:'2.0',id:1,method:'initialize',params},{Authorization:`Bearer ${token}`});
    assert.equal(authed.status,200);
    // The static bearer is read-only: a write tool is refused with 403 insufficient_scope before any handler runs.
    const write=await post({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'actions.propose',arguments:{}}},{Authorization:`Bearer ${token}`});
    assert.equal(write.status,403);assert.match(write.headers.get('www-authenticate'),/error="insufficient_scope"/);
    assert.equal((await server.rpc('initialize',params)).status,200);
    const discovery=await (await fetch(`${server.origin}/.well-known/oauth-authorization-server`,{signal:AbortSignal.timeout(5000)})).json();
    assert.equal(discovery.revocation_endpoint,`${server.origin}/oauth/revoke`);assert.equal(discovery.registration_endpoint,`${server.origin}/oauth/register`);
  }finally{await server.stop();}
});
