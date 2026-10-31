import { build } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { buildApp } from '../backend/pipeline/src/app.ts';
import { loadConfig } from '../backend/pipeline/src/config.ts';
import { createServer } from '../backend/pipeline/src/server-runtime.ts';
import { createRealProviders } from '../backend/pipeline/src/providers/real.ts';
declare global {
  interface Window {
    ready: boolean; failure?: string; result?: import('../packages/voice-contracts/src/index.ts').TurnResponse;
    events: Array<{ type: string; state?: string }>;
    client: { controller: { state: string; dispose(): Promise<void> } };
  }
}

if (!process.argv.includes('--real')) throw new Error('Pass --real to allow billable speech requests.');
const project = process.cwd();
const output = path.resolve('.cache/voice-test-audio/browser-realtime-harness');
if (!output.startsWith(project + path.sep)) throw new Error('Output escapes workspace');
await mkdir(output,{recursive:true});
const entry=path.join(output,'entry.ts');
await writeFile(entry,`import {createVoiceClient} from '${project.replaceAll('\\','/')}/packages/voice-client/src/index.ts';
const client=createVoiceClient(); window.client=client; window.events=[]; window.ready=false;
client.controller.subscribe(e=>{window.events.push({type:e.type,state:e.state,capture:e.type==='capture'?e.event.type:undefined,playback:e.type==='playback'?e.event.type:undefined});if(e.type==='turn')window.result=e.response;});
document.querySelector('button').onclick=()=>{client.controller.talk().catch(e=>{window.failure=e.code||e.name;});};
await client.controller.openProfile('an','vi').then(()=>window.ready=true).catch(e=>window.failure=e.code||e.message);`);
await build({configFile:false,root:project,logLevel:'error',build:{target:'esnext',emptyOutDir:false,outDir:output,
lib:{entry,formats:['es'],fileName:()=> 'client.js'}}});
const wav=path.join(output,'input.wav');
const made=spawnSync('ffmpeg',['-y','-v','error','-i','test-assets/voice-pipeline/audio/09_vi_pause_2200ms.wav','-af','adelay=2000,apad=pad_dur=3','-ar','48000','-ac','1',wav]);
if(made.status!==0)throw new Error('WAV preparation failed');
const config=loadConfig({...process.env,MIU_PROVIDER:'real',VOICE_INPUT_MODE:'elevenlabs_realtime'});
const providers=createRealProviders(config,fetch);let calls=0;const original=providers.response.generate;
providers.response.generate=async(...args)=>{calls++;return original(...args);};
const app=await buildApp({config,providers,registerRoutes:app=>{
app.get('/client.js',(_req,res)=>res.sendFile(path.join(output,'client.js'),{dotfiles:'allow'}));
app.get('/',(_req,res)=>res.type('html').send('<button>Talk</button><script type="module" src="/client.js"></script>'));
}});
const server=createServer(app);const baseUrl=await server.listen({host:'127.0.0.1',port:0});config.allowedOrigins.push(baseUrl);
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream',`--use-file-for-fake-audio-capture=${wav}`,'--autoplay-policy=no-user-gesture-required']});
try{
 const page=await browser.newPage({viewport:{width:768,height:1024}});const errors:string[]=[];
 page.on('pageerror',e=>{errors.push(e.message);console.log('browser_error:'+e.message);}); page.on('response',r=>{if(r.status()>=400)console.log('http_error:'+r.status()+':'+new URL(r.url()).pathname);});
 await page.goto(baseUrl);await page.waitForFunction(()=>window.ready===true||Boolean(window.failure),null,{timeout:15000}); if(await page.evaluate(()=>window.failure))throw new Error(await page.evaluate(()=>window.failure));
 await page.click('button');await page.waitForFunction(()=>Boolean(window.result||window.failure),null,{timeout:120000});
 const result=await page.evaluate(()=>({failure:window.failure,input_mode:window.result?.input_mode,transcript:window.result?.transcript?.text,reply_nonempty:Boolean(window.result?.reply?.text),audio_mime:window.result?.audio?.mime_type,events:window.events}));
 if(result.failure)throw new Error(result.failure);
 await page.waitForFunction(()=>window.events.some(e=>e.type==='state'&&e.state==='speaking'),{timeout:10000});
 await page.waitForFunction(()=>window.client.controller.state==='idle',{timeout:30000});
 const report={browser:'headless Edge, synthetic mic with padded 2.2s-pause corpus audio',physical_ipad:false,engine_dispatches:calls,errors,playback_completed:true,...result};
 await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({...report,events:undefined}));
 await page.evaluate(()=>window.client.controller.dispose());
}finally{await browser.close();await server.close();}
