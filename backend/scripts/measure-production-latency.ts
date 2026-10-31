import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { runRemoteCommand, type SshEnvironment } from '../integration/ssh.js';

const marker = 'MIU_PRODUCTION_LATENCY_REPORT=';
export interface ProductionLatencyOptions {
  source?: 'current' | 'overlay';
  overlay?: string;
  remoteEnv?: string;
  classifyModel?: string;
  checkModel?: string;
}

/** No shared production profile is opened: each run owns an isolated PG schema. */
export async function measureProductionLatency(environment: SshEnvironment, options: ProductionLatencyOptions = {}): Promise<Record<string, any>> {
  const source = options.source ?? 'current';
  if (!['current', 'overlay'].includes(source) || (source === 'overlay') !== !!options.overlay) throw new Error('invalid_probe_source');
  const remoteEnv = options.remoteEnv ?? '/etc/miu/api.env';
  if (!/^\/[A-Za-z0-9_./-]+$/u.test(remoteEnv) || remoteEnv.split('/').includes('..')) throw new Error('invalid_remote_env_path');
  for (const model of [options.classifyModel, options.checkModel]) if (model !== undefined && !/^[A-Za-z0-9_.:/-]{1,100}$/u.test(model)) throw new Error('invalid_probe_model');
  const archive = options.overlay ? await readFile(resolve(options.overlay)) : undefined;
  if (archive && archive.length > 20 * 1024 * 1024) throw new Error('probe_archive_too_large');
  const payload = {
    source, schema: 'miu_latency_' + randomUUID().replaceAll('-', ''),
    archive: archive?.toString('base64') ?? null,
    archive_sha256: archive ? createHash('sha256').update(archive).digest('hex') : null,
    classifyModel: options.classifyModel ?? null, checkModel: options.checkModel ?? null,
  };
  const program = 'const payload = ' + JSON.stringify(payload) + ';\n' + String.raw`
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { realpath, mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const runFile = promisify(execFile);
const release = await realpath('/opt/miu/current');
const pg = (await import('pg')).default;
const report = {
  schema_version: 'miu-production-latency-v1', run_kind: 'isolated_production_host_latency_probe',
  status: 'running', started_at: new Date().toISOString(), source: { kind: payload.source, deployed_release: release, archive_sha256: payload.archive_sha256 },
  transport: 'production_host_loopback_http', database: null, configured_models: {}, http_requests: [], turns: [],
  quality_evaluated: false,
  limitations: [
    'This is an isolated app on the actual production host with native PostgreSQL and real providers, not a public HTTPS turn request or an active deployment change.',
    'The five authored SC-104 inputs use two fresh sessions on the same actual date; no historical clock or next-day rollover is simulated.',
    'SQL measurements are pg client query round trips, including driver scheduling/network and server execution; they do not isolate PostgreSQL CPU execution.',
    'SQL work sums may overlap. SQL interval unions avoid double counting concurrent snapshot queries. HTTP minus SQL union still includes providers, local orchestration and loopback transport.',
    'Text-only turns send started/completed delivery receipts with played_ms zero. No microphone, audible playback, STT, or TTS latency is measured.',
    'Only the unique per-run schema, temporary source directory, HTTP server and process are owned by the probe. Shared profiles and active service configuration are untouched.',
    'Timing results do not establish character or memory quality; actual errors and partial coverage remain in the report.',
  ],
};
const check = (condition, code) => { if (!condition) { const error = new Error(code); error.code = code; throw error; } };
const safe = error => typeof error?.code === 'string' && /^[A-Za-z0-9_]{1,100}$/.test(error.code) ? error.code : typeof error?.message === 'string' && /^[A-Za-z0-9_]{1,100}$/.test(error.message) ? error.message : 'production_latency_probe_failed';
const average = values => values.length ? values.reduce((a,b) => a+b,0)/values.length : null;
function union(rows) {
  const intervals = rows.map(row => [row.start_ms,row.start_ms+row.elapsed_ms]).sort((a,b)=>a[0]-b[0]);
  let result=0, start=null, end=null;
  for (const [a,b] of intervals) { if(start===null){start=a;end=b;}else if(a<=end){end=Math.max(end,b);}else{result+=end-start;start=a;end=b;} }
  return result + (start===null ? 0 : end-start);
}
function sqlSummary(rows) {
  return { query_count: rows.length, query_work_ms: rows.reduce((total,row)=>total+row.elapsed_ms,0), query_union_ms: union(rows),
    by_statement: Object.fromEntries([...new Set(rows.map(row=>row.statement_type))].map(key=>[key,{count:rows.filter(row=>row.statement_type===key).length,total_ms:rows.filter(row=>row.statement_type===key).reduce((n,row)=>n+row.elapsed_ms,0)}])),
    query_errors: rows.filter(row=>row.status!=='ok').length };
}
let active = null;
const originalQuery = pg.Client.prototype.query;
pg.Client.prototype.query = function(...args) {
  const owner=active, started=performance.now();
  const sql=typeof args[0]==='string' ? args[0] : args[0]?.text;
  const word=(typeof sql==='string' ? /^\s*([A-Za-z]+)/.exec(sql)?.[1]?.toUpperCase() : null) || 'OTHER';
  const statement_type=['SELECT','INSERT','UPDATE','DELETE','BEGIN','COMMIT','ROLLBACK','CREATE','ALTER','LOCK','SET'].includes(word)?word:'OTHER';
  let recorded=false;
  const done=error=>{if(error){report.last_database_query_error={code:safe(error),statement_type,sql_sha256:typeof sql==='string'?createHash('sha256').update(sql).digest('hex'):null,values_count:Array.isArray(args[1])?args[1].length:null,call_stack:new Error().stack?.split('\n').filter(line=>line.includes('/backend/')).slice(0,5)};}if(owner&&!recorded){recorded=true;owner.sql.push({statement_type,start_ms:started,elapsed_ms:performance.now()-started,status:error?'error':'ok'});}};
  const callbackIndex=args.findLastIndex(value=>typeof value==='function');
  if(callbackIndex>=0){const callback=args[callbackIndex];args[callbackIndex]=function(...values){done(values[0]);return callback.apply(this,values);};}
  try {
    const result=originalQuery.apply(this,args);
    if(callbackIndex<0&&result&&typeof result.then==='function')return result.then(value=>{done(null);return value;},error=>{done(error);throw error;});
    return result;
  }catch(error){done(error);throw error;}
};
let admin, integrated, server, temp, schemaCreated=false, session=null, activeTurn=null, authCookie=null;
const http = async (label, method, path, body, authorized=true) => {
  const owner={label,sql:[]}; active=owner; const start=performance.now();
  const row={label,method,http_status:null,http_elapsed_ms:null,sql:null,error_code:null}; report.http_requests.push(row);
  try {
    const response=await fetch(base+path,{method,headers:{...(authCookie?{Cookie:authCookie}:{}),...(authorized&&session?{Authorization:'Bearer '+session.token}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(180000)});
    const accountCookie=response.headers.get('set-cookie')?.split(';')[0];if(accountCookie?.startsWith('miu_auth='))authCookie=accountCookie;
    row.http_status=response.status;
    const data=await response.json();
    if(!response.ok){const error=new Error('probe_http_failed');error.code=/^[a-z0-9_]{1,100}$/.test(data?.error?.code||'')?data.error.code:'probe_http_failed';throw error;}
    return {data,row};
  }catch(error){row.error_code=safe(error);throw error;}
  finally{row.http_elapsed_ms=performance.now()-start;row.sql=sqlSummary(owner.sql);if(active===owner)active=null;}
};
let base;
try {
  check(process.env.MIU_PROVIDER==='real' && !!process.env.DATABASE_URL, 'real_native_postgres_required');
  check(/^miu_latency_[a-z0-9]{32}$/.test(payload.schema),'invalid_probe_schema');
  try {report.public_release=JSON.parse(await readFile(resolve(release,'deploy-info.json'),'utf8'));}catch{report.public_release=null;}
  let source=release;
  if(payload.source==='overlay'){
    temp=await mkdtemp('/opt/miu/tmp/latency-');
    const archive=join(temp,'source.tar.gz'); const bytes=Buffer.from(payload.archive,'base64');
    check(createHash('sha256').update(bytes).digest('hex')===payload.archive_sha256,'probe_archive_hash_mismatch');
    await writeFile(archive,bytes,{mode:0o600});
    const listing=await runFile('tar',['-tzf',archive],{maxBuffer:4*1024*1024});
    check(listing.stdout.split('\n').filter(Boolean).every(name=>!name.startsWith('/')&&!name.split('/').some(part=>part==='..'||part.startsWith('._'))&&!/(?:^|\/)(?:\.env(?:\.[^/]+)?|\.aws)(?:\/|$)/.test(name)),'unsafe_probe_archive');
    await runFile('tar',['-xzf',archive,'-C',temp]);
    await symlink(resolve(release,'node_modules'),join(temp,'node_modules'),'dir');
    source=temp; report.source.dependencies='reused_deployed_node_modules';
  }
  const dbUrl=new URL(process.env.DATABASE_URL);
  admin=new pg.Pool({connectionString:dbUrl.href,max:1,connectionTimeoutMillis:10000});
  await admin.query('CREATE SCHEMA "'+payload.schema+'"'); schemaCreated=true;
  dbUrl.searchParams.set('options','-c search_path='+payload.schema);
  const scoped=new pg.Pool({connectionString:dbUrl.href,max:1,connectionTimeoutMillis:10000});
  try {
    report.database=(await scoped.query("SELECT current_database() AS database,current_schema() AS schema,current_setting('search_path') AS search_path,current_setting('server_version') AS version,inet_server_addr()::text AS server_address,inet_server_port() AS server_port")).rows[0];
    check(report.database.schema===payload.schema&&report.database.search_path===payload.schema,'schema_isolation_failed');
  }finally{await scoped.end();}
  const probeEnv={...process.env,MIU_PROVIDER:'real',DATABASE_URL:dbUrl.href,DATABASE_SSH_TUNNEL:'false',HOST:'127.0.0.1',MIU_FRONTEND_DIR:'/nonexistent-miu-latency-frontend'};
  if(payload.classifyModel)probeEnv.OPENAI_CLASSIFY_MODEL=payload.classifyModel;
  if(payload.checkModel)probeEnv.OPENAI_CHECK_MODEL=payload.checkModel;
  report.configured_models=Object.fromEntries(['OPENAI_CLASSIFY_MODEL','OPENAI_REPLY_MODEL','OPENAI_CHECK_MODEL'].map(key=>[key,probeEnv[key]??null]));
  const {createIntegratedApp}=await import(pathToFileURL(resolve(source,'backend/integration/server.ts')).href);
  integrated=await createIntegratedApp(probeEnv);
  const provider=integrated.bridge.application.provider;
  const providerEvents=[];
  for(const stage of ['classify','reply','check']){const original=provider[stage].bind(provider);provider[stage]=async(...args)=>{const started=performance.now();try{const result=await original(...args);providerEvents.push({stage,elapsed_ms:performance.now()-started,outcome:'ok',...(stage==='check'?{verdict:result}:{}),...(stage==='reply'?{draft:result}:{})});return result;}catch(error){providerEvents.push({stage,elapsed_ms:performance.now()-started,outcome:'error',error_code:safe(error)});throw error;}};}
  server=createServer(integrated.app);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  base='http://127.0.0.1:'+server.address().port;
  report.bound_address=server.address().address;
  const health=(await http('isolated_health','GET','/api/health',null,false)).data;
  check(health.provider_mode==='real'&&health.engine_mode==='character_memory','isolated_service_not_real'); report.health=health;
  const authCapability=await fetch(base+'/api/auth/me',{signal:AbortSignal.timeout(10000)});
  check([401,404].includes(authCapability.status),'unexpected_probe_auth_capability');
  report.account_mode=authCapability.status===401?'isolated_registered_account':'legacy_demo_profile';
  if(authCapability.status===401){await http('register_isolated_probe_account','POST','/api/auth/register',{username:'lat_'+randomUUID().replaceAll('-','').slice(0,20),password:randomUUID()},false);check(!!authCookie,'missing_probe_auth_cookie');}
  const open=async label=>{const {data}=await http(label,'POST','/api/sessions',{request_id:randomUUID(),demo_profile_key:authCookie?'account':'an'},false);check(typeof data.session_id==='string'&&typeof data.demo_token==='string','invalid_probe_session');session={id:data.session_id,token:data.demo_token};};
  await open('open_isolated_an_first');
  await http('configure_isolated_english','PATCH','/api/profiles/current/config',{request_id:randomUUID(),language_mode:'en'});
  const inputs=[
    ['SC-104/different-pets/dog','My dog is Mochi.'],
    ['SC-104/different-pets/cat','My cat is Nori.'],
    ['SC-104/different-pets/dog-event','Mochi fell in a puddle today.'],
    ['SC-104/check-pet-subjects/cat-question','Did I say that Nori fell in a puddle?'],
    ['SC-104/check-pet-subjects/which-dog','Which one is my dog?'],
  ];
  for(let index=0;index<inputs.length;index++){
    if(index===3){await http('close_isolated_an_first','DELETE','/api/sessions/'+session.id);session=null;await open('open_isolated_an_second');}
    const [id,text]=inputs[index]; const row={id,input:text,status:'running',http_elapsed_ms:null,server_total_ms:null,sql:null,provider_calls:[],api_calls:[],reply:null,error_code:null,receipts:[]};report.turns.push(row);
    const apiOffset=provider.telemetry?.length??0,eventOffset=providerEvents.length;
    try{
      const {data,row:request}=await http(id,'POST','/api/sessions/'+session.id+'/turns',{request_id:randomUUID(),kind:'utterance',text,text_only:true,language_hint:'en'});
      activeTurn=data.turn_id;
      row.http_elapsed_ms=request.http_elapsed_ms;row.sql=request.sql;row.server_total_ms=data.timings_ms?.server_total??null;row.timings_ms=data.timings_ms;
      row.reply={text:data.reply?.text,language:data.reply?.language};row.provider_mode=data.provider_mode;row.engine_mode=data.engine_mode;
      check(data.provider_mode==='real'&&data.engine_mode==='character_memory'&&data.audio===null,'probe_turn_not_real_text');
      for(const status of ['started','completed']){const {row:receipt}=await http(id+'/receipt-'+status,'POST','/api/sessions/'+session.id+'/turns/'+data.turn_id+'/playback',{request_id:randomUUID(),status,played_ms:0,state_version:data.state_version});row.receipts.push({status,http_elapsed_ms:receipt.http_elapsed_ms,sql:receipt.sql});}
      activeTurn=null;row.status='completed';
    }catch(error){row.status='failed';row.error_code=safe(error);throw error;}
    finally{if(row.http_elapsed_ms===null){const request=report.http_requests.find(request=>request.label===id);if(request){row.http_elapsed_ms=request.http_elapsed_ms;row.sql=request.sql;}}row.provider_calls=providerEvents.slice(eventOffset);row.api_calls=(provider.telemetry??[]).slice(apiOffset).map(call=>({stage:call.stage,api:call.api,requestedModel:call.requestedModel,returnedModel:call.returnedModel,responseId:call.responseId,requestId:call.requestId,startedAt:call.startedAt,elapsedMs:call.elapsedMs,outcome:call.outcome,errorCode:call.errorCode}));}
  }
  report.status='complete';
}catch(error){report.status='incomplete';report.error_code=safe(error);if(/^[0-9A-Z]{5}$/.test(error?.code??'')){report.database_error={code:error.code,routine:error.routine??null,message:String(error.message).replace(/postgres(?:ql)?:\/\/\S+/g,'[DATABASE_URL_REDACTED]').replace(/sk-[A-Za-z0-9_-]+/g,'[REDACTED]').slice(0,400)};}}
finally{
  report.cleanup={own_server_closed:false,own_schema_dropped:false,own_source_removed:temp===undefined};
  if(session&&activeTurn){try{await http('cancel_own_pending_turn','DELETE','/api/sessions/'+session.id+'/turns/'+activeTurn);}catch{report.cleanup.pending_cancel_error='own_pending_cancel_failed';}}
  if(session){try{await http('close_own_session','DELETE','/api/sessions/'+session.id);}catch{report.cleanup.session_close_error='own_session_close_failed';}}
  active=null;
  if(server){try{server.closeAllConnections();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));report.cleanup.own_server_closed=true;}catch{report.cleanup.server_close_error='own_server_close_failed';}}
  if(integrated){try{await integrated.close();}catch{report.cleanup.app_close_error='own_app_close_failed';}}
  if(schemaCreated&&admin){try{check(/^miu_latency_[a-z0-9]{32}$/.test(payload.schema),'invalid_cleanup_schema');await admin.query('DROP SCHEMA "'+payload.schema+'" CASCADE');report.cleanup.own_schema_dropped=true;}catch{report.cleanup.schema_drop_error='own_schema_drop_failed';}}
  if(admin)await admin.end().catch(()=>{});
  if(temp){try{check(temp.startsWith('/opt/miu/tmp/latency-'),'invalid_cleanup_directory');await rm(temp,{recursive:true,force:true});report.cleanup.own_source_removed=true;}catch{report.cleanup.source_cleanup_error='own_source_cleanup_failed';}}
  pg.Client.prototype.query=originalQuery;
  const completed=report.turns.filter(turn=>turn.status==='completed');
  report.summary={attempted:report.turns.length,completed:completed.length,failed:report.turns.filter(turn=>turn.status==='failed').length,
    mean_http_ms:average(completed.map(turn=>turn.http_elapsed_ms)),mean_server_total_ms:average(completed.map(turn=>turn.server_total_ms).filter(Number.isFinite)),
    mean_sql_query_count:average(completed.map(turn=>turn.sql.query_count)),mean_sql_work_ms:average(completed.map(turn=>turn.sql.query_work_ms)),mean_sql_union_ms:average(completed.map(turn=>turn.sql.query_union_ms)),
    mean_http_minus_sql_union_ms:average(completed.map(turn=>turn.http_elapsed_ms-turn.sql.query_union_ms)),
    mean_completed_receipt_sql_union_ms:average(completed.flatMap(turn=>turn.receipts.filter(row=>row.status==='completed').map(row=>row.sql.query_union_ms))),
    provider_stage_ms:Object.fromEntries(['classify','reply','check'].map(stage=>[stage,average(completed.map(turn=>turn.provider_calls.filter(call=>call.stage===stage).reduce((n,call)=>n+call.elapsed_ms,0)))])),
    api_call_count:report.turns.reduce((n,turn)=>n+turn.api_calls.length,0),api_failed_count:report.turns.reduce((n,turn)=>n+turn.api_calls.filter(call=>call.outcome==='failed').length,0),
  };
  if(!report.cleanup.own_schema_dropped||!report.cleanup.own_server_closed||!report.cleanup.own_source_removed||Object.keys(report.cleanup).some(key=>key.endsWith('_error')))report.status='incomplete';
  report.completed_at=new Date().toISOString();
  process.stdout.write('MIU_PRODUCTION_LATENCY_REPORT='+JSON.stringify(report)+'\n');
}
`;
  const script = 'set -eu\ncd /opt/miu/current\n/opt/node24/bin/node --env-file=' + remoteEnv
    + " --import tsx --input-type=module <<'MIU_LATENCY_PROBE_NODE'\n" + program + '\nMIU_LATENCY_PROBE_NODE\n';
  const result = await runRemoteCommand(environment, script, 1_200_000);
  const line = result.stdout.split('\n').find(value => value.startsWith(marker));
  if (!line) throw new Error('missing_production_latency_report');
  return JSON.parse(line.slice(marker.length));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: {
    'env-file': { type: 'string', default: '.env' }, output: { type: 'string' }, source: { type: 'string', default: 'current' }, overlay: { type: 'string' },
    'remote-env': { type: 'string', default: '/etc/miu/api.env' }, 'classify-model': { type: 'string' }, 'check-model': { type: 'string' }, help: { type: 'boolean', default: false },
  } });
  if (values.help) console.log('Usage: tsx backend/scripts/measure-production-latency.ts --output NEW_DIRECTORY [--source current | --source overlay --overlay SOURCE.tar.gz] [--classify-model MODEL] [--check-model MODEL]');
  else {
    const output = resolve(values.output ?? 'reports/production-latency-' + new Date().toISOString().replace(/[:.]/gu, '-'));
    await mkdir(resolve(output, '..'), { recursive: true }); await mkdir(output, { recursive: false });
    try {
      if (existsSync(values['env-file'])) loadEnvFile(values['env-file']);
      const report = await measureProductionLatency({ ...process.env, MIU_ENV_FILE: resolve(values['env-file']) }, {
        source: values.source as 'current' | 'overlay', overlay: values.overlay, remoteEnv: values['remote-env'], classifyModel: values['classify-model'], checkModel: values['check-model'],
      });
      await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
      console.log(JSON.stringify({ status: report.status, output, source: report.source, summary: report.summary, cleanup: report.cleanup }));
      if (report.status !== 'complete') process.exitCode = 1;
    } catch (error) {
      const candidate = error && typeof error === 'object' ? (error as { code?: unknown; message?: unknown }).code ?? (error as Error).message : undefined;
      const code = typeof candidate === 'string' && /^[A-Za-z0-9_]{1,100}$/u.test(candidate) ? candidate : 'production_latency_probe_failed';
      await writeFile(resolve(output, 'report.json'), JSON.stringify({ status: 'incomplete', error_code: code }, null, 2) + '\n');
      console.log(JSON.stringify({ status: 'incomplete', error_code: code, output })); process.exitCode = 1;
    }
  }
}
