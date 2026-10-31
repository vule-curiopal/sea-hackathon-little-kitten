import { build } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { buildApp } from '../backend/pipeline/src/app.ts';
import { loadConfig } from '../backend/pipeline/src/config.ts';
import { createServer } from '../backend/pipeline/src/server-runtime.ts';
import { createRealProviders } from '../backend/pipeline/src/providers/real.ts';
declare global {
  interface Window {
    ready: boolean; failure?: string; result?: import('../packages/voice-contracts/src/index.ts').TurnResponse;
    events: Array<{ type: string; state?: string; capture?: string; capture_state?: string; at_ms: number }>;
    held: boolean; capturedMs: number; holdStartedAtMs?: number; releaseAtMs?: number; captureReadyAtMs?: number;
    releaseAccepted?: boolean; finalTranscript?: string;
    client: { controller: { state: string; dispose(): Promise<void> } };
  }
}

if (!process.argv.includes('--real')) throw new Error('Pass --real to allow billable speech requests.');
const project = process.cwd();
const output = path.resolve('.cache/voice-test-audio/browser-realtime-harness');
if (!output.startsWith(project + path.sep)) throw new Error('Output escapes workspace');
await mkdir(output,{recursive:true});
const entry=path.join(output,'entry.ts');
await writeFile(entry,`import {createVoiceClient} from ${JSON.stringify(`${project.replaceAll('\\','/')}/packages/voice-client/src/index.ts`)};
const client=createVoiceClient(); window.client=client; window.events=[]; window.ready=false; window.held=false; window.capturedMs=0;
client.controller.subscribe(e=>{
 const at=performance.now();
 window.events.push({type:e.type,state:e.state,capture:e.type==='capture'?e.event.type:undefined,capture_state:e.type==='capture'&&e.event.type==='state'?e.event.state:undefined,playback:e.type==='playback'?e.event.type:undefined,at_ms:at});
 if(e.type==='capture'&&e.event.type==='state'&&e.event.state==='recording')window.captureReadyAtMs=at;
 if(e.type==='capture'&&e.event.type==='stream_meter')window.capturedMs=e.event.elapsedMs;
 if(e.type==='capture'&&e.event.type==='transcript_final')window.finalTranscript=e.event.text;
 if(e.type==='turn')window.result=e.response;
});
const button=document.querySelector('button'); let owner=null;
button.onpointerdown=e=>{
 if(!e.isPrimary||e.button!==0||owner!==null||!window.ready)return;
 e.preventDefault(); owner=e.pointerId; button.setPointerCapture(owner); window.held=true; window.holdStartedAtMs=performance.now();
 window.events.push({type:'gesture',state:'held',at_ms:window.holdStartedAtMs});
 client.controller.talk().catch(e=>{window.failure=e.code||e.name;});
};
button.onpointerup=e=>{
 if(e.pointerId!==owner)return; owner=null; window.held=false; window.releaseAtMs=performance.now();
 window.events.push({type:'gesture',state:'released',at_ms:window.releaseAtMs});
 window.releaseAccepted=client.controller.send(); if(!window.releaseAccepted)window.failure='RELEASE_NOT_ACCEPTED';
 if(button.hasPointerCapture(e.pointerId))button.releasePointerCapture(e.pointerId);
};
const cancel=()=>{if(owner===null)return;owner=null;window.held=false;window.failure='GESTURE_CANCELED';void client.controller.stop();};
button.onpointercancel=cancel;button.onlostpointercapture=cancel;window.addEventListener('blur',cancel);
await client.controller.openProfile('an','vi').then(()=>window.ready=true).catch(e=>window.failure=e.code||e.message);`);
await build({configFile:false,root:project,logLevel:'error',build:{target:'esnext',emptyOutDir:false,outDir:output,
lib:{entry,formats:['es'],fileName:()=> 'client.js'}}});
const wav=path.join(output,'input.wav');
const manifest=JSON.parse(await readFile('test-assets/voice-pipeline/manifest.json','utf8'));
const asset=manifest.assets.find((item:{id:string})=>item.id==='09_vi_pause_2200ms');
if(!asset)throw new Error('Missing browser corpus asset');
const syntheticLeadMs=2000, syntheticTailMs=3000;
// Hold across the complete original two-clause clip, its 2.2s pause and the added leading delay.
// Extra trailing silence keeps the looping synthetic device away from the next spoken repetition.
const holdCaptureMs=Math.ceil(asset.duration_ms+syntheticLeadMs);
const made=spawnSync('ffmpeg',['-y','-v','error','-i','test-assets/voice-pipeline/audio/09_vi_pause_2200ms.wav','-af','adelay=2000,apad=pad_dur=3','-ar','48000','-ac','1',wav]);
if(made.status!==0)throw new Error('WAV preparation failed');
const config=loadConfig({...process.env,MIU_PROVIDER:'real',VOICE_INPUT_MODE:'elevenlabs_realtime'});
const providers=createRealProviders(config,fetch);const calls:Array<{turn_id:string;text:string}>=[];const original=providers.response.generate;
providers.response.generate=async(input,signal)=>{calls.push({turn_id:input.turnId,text:input.text});return original(input,signal);};
const app=await buildApp({config,providers,registerRoutes:app=>{
app.get('/client.js',(_req,res)=>res.sendFile(path.join(output,'client.js'),{dotfiles:'allow'}));
app.get('/',(_req,res)=>res.type('html').send('<button>Talk</button><script type="module" src="/client.js"></script>'));
}});
const server=createServer(app);const baseUrl=await server.listen({host:'127.0.0.1',port:0});config.allowedOrigins.push(baseUrl);
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
const errors:string[]=[];
const report:Record<string,unknown>={tested_at:new Date().toISOString(),status:'verification_started',
 scope:'Real browser voice-client pointer hold/release with a synthetic microphone WAV -> real ElevenLabs realtime STT/manual commit -> real stateless GPT -> real TTS/playback. No character/memory quality, physical microphone, iPad, full frontend gesture integration or production latency evaluation.',
 browser:'headless Edge, synthetic mic with padded 2.2s-pause corpus audio',physical_ipad:false,physical_microphone:false,
 corpus_id:asset.id,original_duration_ms:asset.duration_ms,added_lead_ms:syntheticLeadMs,added_tail_ms:syntheticTailMs,hold_capture_target_ms:holdCaptureMs,
 timing:'Browser event times use performance.now() from page navigation; hold duration includes preparation and paced synthetic audio. Capture meters measure ready-state elapsed time, not sample-accurate file alignment.',
 config:{commit_strategy:'manual',reply_model:config.replyModel,tts_model:config.ttsModel},errors,playback_completed:false};
try{
 browser=await chromium.launch({channel:'msedge',headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream',`--use-file-for-fake-audio-capture=${wav}`,'--autoplay-policy=no-user-gesture-required']});
 const page=await browser.newPage({viewport:{width:768,height:1024}});
 page.on('pageerror',e=>{errors.push(e.message);console.log('browser_error:'+e.message);}); page.on('response',r=>{if(r.status()>=400)console.log('http_error:'+r.status()+':'+new URL(r.url()).pathname);});
 await page.goto(baseUrl);await page.waitForFunction(()=>window.ready===true||Boolean(window.failure),null,{timeout:15000}); if(await page.evaluate(()=>window.failure))throw new Error(await page.evaluate(()=>window.failure));
 const bounds=await page.locator('button').boundingBox();if(!bounds)throw new Error('Missing hold button');
 await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);await page.mouse.down();
 await page.waitForFunction(()=>window.captureReadyAtMs!==undefined||Boolean(window.failure),null,{timeout:15000});
 if(await page.evaluate(()=>window.failure))throw new Error(await page.evaluate(()=>window.failure));
 await page.waitForFunction(target=>window.capturedMs>=target||Boolean(window.failure||window.result),holdCaptureMs,{timeout:20000});
 const held=await page.evaluate(()=>({held:window.held,failure:window.failure,result:Boolean(window.result),state:window.client.controller.state,capturedMs:window.capturedMs,
   finalBeforeRelease:window.events.some(e=>e.type==='capture'&&e.capture==='transcript_final'),
   processingBeforeRelease:window.events.some(e=>e.type==='state'&&e.state==='processing')}));
 if(held.failure)throw new Error(held.failure);
 if(!held.held||held.result||held.state!=='recording'||held.capturedMs<holdCaptureMs||held.finalBeforeRelease||held.processingBeforeRelease)throw new Error('Turn completed before pointer release');
 await page.mouse.up();
 await page.waitForFunction(()=>Boolean(window.result||window.failure),null,{timeout:120000});
 const result=await page.evaluate(()=>({failure:window.failure,turn_id:window.result?.turn_id,provider_mode:window.result?.provider_mode,input_mode:window.result?.input_mode,
   transcript:window.result?.transcript?.text,final_transcript:window.finalTranscript,reply_nonempty:Boolean(window.result?.reply?.text),audio_mime:window.result?.audio?.mime_type,
   release_accepted:window.releaseAccepted,hold_started_at_ms:window.holdStartedAtMs,capture_ready_at_ms:window.captureReadyAtMs,release_at_ms:window.releaseAtMs,captured_ms:window.capturedMs,events:window.events}));
 Object.assign(report,result);
 if(result.failure)throw new Error(result.failure);
 const fullTranscript=typeof result.transcript==='string'&&result.transcript.length>0&&result.transcript===result.final_transcript;
 report.engine_received_full_transcript=calls.length===1&&calls[0]?.turn_id===result.turn_id&&calls[0]?.text===result.final_transcript;
 if(!result.release_accepted||result.provider_mode!=='real'||result.input_mode!=='realtime_stt'||!fullTranscript||!report.engine_received_full_transcript||!result.reply_nonempty||!result.audio_mime)throw new Error('Invalid completed hold-to-talk turn');
 await page.waitForFunction(()=>window.events.some(e=>e.type==='state'&&e.state==='speaking'),null,{timeout:10000});
 await page.waitForFunction(()=>window.client.controller.state==='idle',null,{timeout:30000});
 if(errors.length)throw new Error('Browser page errors');
 report.status='real_pipeline_completed';report.playback_completed=true;
 await page.evaluate(()=>window.client.controller.dispose());
}catch(error){report.status='verification_failed';report.error_code=error instanceof Error?error.message:'unknown';throw error;
}finally{
 report.engine_dispatches=calls.length;report.engine_inputs=calls;
 await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({...report,events:undefined}));
 await browser?.close();await server.close();
}
