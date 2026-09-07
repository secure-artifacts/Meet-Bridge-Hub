(() => {
  "use strict";
  const CHANNEL="meet-bridge-n-minus-one", PC=window.RTCPeerConnection, LegacyPC=window.webkitRTCPeerConnection, MS=window.MediaStream, md=navigator.mediaDevices;
  if (!md?.getUserMedia||!PC) return;
  const nativeGum=md.getUserMedia.bind(md), nativeGdm=typeof md.getDisplayMedia==="function"?md.getDisplayMedia.bind(md):null, internalPCs=new WeakSet(), internalSenders=new WeakSet(), nativeTracks=new WeakMap(), nativeDebug=new Map(), bindingsBySender=new WeakMap(), bindings=new Set(), sharedBindingsBySender=new WeakMap(), sharedBindings=new Set(), displayAudioTracks=new WeakSet(), bridgeAudioTracks=new WeakSet();
  const inheritTrackRole=(source,clone)=>{if(source?.kind!=="audio"||clone?.kind!=="audio")return clone;if(displayAudioTracks.has(source))displayAudioTracks.add(clone);if(bridgeAudioTracks.has(source))bridgeAudioTracks.add(clone);return clone;};
  const trackPrototype=window.MediaStreamTrack?.prototype,nativeTrackClone=trackPrototype?.clone,nativeStreamClone=MS.prototype.clone;
  if(typeof nativeTrackClone==="function"){try{Object.defineProperty(trackPrototype,"clone",{configurable:true,writable:true,value:function(){return inheritTrackRole(this,nativeTrackClone.call(this));}});}catch{}}
  if(typeof nativeStreamClone==="function"){try{Object.defineProperty(MS.prototype,"clone",{configurable:true,writable:true,value:function(){const sourceTracks=this.getTracks(),clone=nativeStreamClone.call(this),cloneTracks=clone.getTracks();for(let index=0;index<Math.min(sourceTracks.length,cloneTracks.length);index++)inheritTrackRole(sourceTracks[index],cloneTracks[index]);return clone;}});}catch{}}
  let nativeReplace=null, active=false, micMode="shared", bridgeRole="meeting", pageWorkletUrl="", diagnosticsEnabled=false, configKnown=false, resolveConfig;
  const initialConfig=new Promise(resolve=>{resolveConfig=resolve;});
  let outputPC=null, outputTrack=null, outputCandidates=[], outputPcm=null, pagePC=null, pageSender=null, pageTrack=null, pageCandidates=[], generation=0, requestSeq=0, latestRequest=0, updateQueue=Promise.resolve();
  let jitsiEffectTrack=null, jitsiEffectRunning=false, jitsiEffectMixTrack=null, jitsiEffectInstance=null, jitsiProbeState="", jitsiSenderFallbackActive=false;
  const audioProbes=new Map();
  const waiters=new Set();
  let pcSequence=0, lastStatsAt=0;
  const pagePcs=new Map();
  const post=(type,payload={})=>window.postMessage({channel:CHANNEL,direction:"to-extension",type,...payload},"*");
  function diagnostic(event, detail={}){if(diagnosticsEnabled)post("DIAGNOSTIC",{entry:{at:new Date().toISOString(),event,detail}});}
  function debug(message, detail){if(diagnosticsEnabled)console.debug(message,detail);}
  function recordPc(pc, config){
    const id=++pcSequence;
    pagePcs.set(id,{pc,id,createdAt:Date.now()});
    diagnostic("pc-created",{pcId:id,iceServerCount:Array.isArray(config?.iceServers)?config.iceServers.length:0});
    pc.addEventListener("connectionstatechange",()=>diagnostic("pc-state",{pcId:id,state:pc.connectionState}));
    pc.addEventListener("signalingstatechange",()=>{if(pc.signalingState==="closed")pagePcs.delete(id);});
    pc.addEventListener("negotiationneeded",()=>diagnostic("pc-negotiationneeded",{pcId:id}));
    return id;
  }
  function pcId(pc){for(const item of pagePcs.values())if(item.pc===pc)return item.id;return null;}
  function probeAudioTrack(track,label){
    if(!diagnosticsEnabled||!track||audioProbes.has(track))return;
    try{
      const context=new AudioContext(),source=context.createMediaStreamSource(new MS([track])),analyser=context.createAnalyser(),silent=context.createGain();
      analyser.fftSize=512;silent.gain.value=0;source.connect(analyser);analyser.connect(silent);silent.connect(context.destination);context.resume().then(()=>diagnostic("page-track-probe-resumed",{label,state:context.state})).catch(error=>diagnostic("page-track-probe-resume-failed",{label,state:context.state,message:error?.message||String(error)}));
      const timer=setInterval(()=>{if(track.readyState!=="live"){clearInterval(timer);try{source.disconnect();analyser.disconnect();silent.disconnect();context.close();}catch{}audioProbes.delete(track);return;}const data=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(data);let sum=0;for(const sample of data)sum+=sample*sample;diagnostic("page-track-level",{label,trackId:track.id,rms:Number(Math.sqrt(sum/data.length).toFixed(5)),contextState:context.state,enabled:track.enabled,muted:track.muted,readyState:track.readyState});},1000);
      audioProbes.set(track,{context,timer});diagnostic("page-track-probe-started",{label,trackId:track.id,state:context.state});
    }catch(error){diagnostic("page-track-probe-failed",{label,message:error?.message||String(error)});}
  }
  async function sampleStats(){
    if(!diagnosticsEnabled)return;
    if(Date.now()-lastStatsAt<2000)return;lastStatsAt=Date.now();
    for(const item of pagePcs.values()){
      const {pc,id}=item;if(internalPCs.has(pc)||pc.connectionState!=="connected")continue;
      try{for(const sender of pc.getSenders()){const track=sender.track;if(track?.kind==="audio")diagnostic("sender-track-state",{pcId:id,trackId:track.id,enabled:track.enabled,muted:track.muted,readyState:track.readyState});}const report=await pc.getStats();report.forEach(stat=>{if(stat.type==="outbound-rtp"&&(stat.kind==="audio"||stat.mediaType==="audio"))diagnostic("outbound-audio-stats",{pcId:id,bytesSent:stat.bytesSent||0,audioLevel:stat.audioLevel??null,totalAudioEnergy:stat.totalAudioEnergy??null,trackId:stat.trackIdentifier||null});});}catch{}
    }
  }
  setInterval(sampleStats,2000);
  async function sampleOutputReceiverStats(){
    if(!diagnosticsEnabled||!outputPC||outputPC.connectionState!=="connected")return;
    try{const report=await outputPC.getStats();report.forEach(stat=>{if(stat.type==="inbound-rtp"&&(stat.kind==="audio"||stat.mediaType==="audio"))diagnostic("bridge-output-receiver-stats",{bytesReceived:stat.bytesReceived||0,audioLevel:stat.audioLevel??null,totalAudioEnergy:stat.totalAudioEnergy??null,jitter:stat.jitter??null,packetsReceived:stat.packetsReceived||0});});}catch(error){diagnostic("bridge-output-receiver-stats-failed",{message:error?.message||String(error)});}
  }
  setInterval(sampleOutputReceiverStats,2000);
  function instrumentConstructor(Constructor){return new Proxy(Constructor,{construct(Target,args){const pc=Reflect.construct(Target,args,Target);recordPc(pc,args[0]);return pc;}});}
  try{window.RTCPeerConnection=instrumentConstructor(PC);}catch{}
  try{if(LegacyPC&&LegacyPC!==PC)window.webkitRTCPeerConnection=instrumentConstructor(LegacyPC);}catch{}
  const candidate=c=>({candidate:c.candidate,sdpMid:c.sdpMid,sdpMLineIndex:c.sdpMLineIndex,usernameFragment:c.usernameFragment});
  const description=d=>d?{type:d.type,sdp:d.sdp}:null;
  function settle(error=null){for(const w of waiters){clearTimeout(w.timer);error?w.reject(error):w.resolve(outputTrack);}waiters.clear();}
  function waitOutput(){if(outputTrack?.readyState==="live")return Promise.resolve(outputTrack);return new Promise((resolve,reject)=>{const w={resolve,reject,timer:setTimeout(()=>{waiters.delete(w);reject(new DOMException("Meet Bridge 音频轨道连接超时，请重新加载会议页。","NotReadableError"));},20000)};waiters.add(w);});}
  function installSpeechRecognitionBridge(){
    const constructors=[window.SpeechRecognition,window.webkitSpeechRecognition].filter(Boolean),patched=new Set();
    for(const Constructor of constructors){
      const prototype=Constructor?.prototype;
      if(!prototype||patched.has(prototype)||prototype.__meetBridgeSpeechStartInstalled)continue;
      patched.add(prototype);
      const nativeStart=prototype.start;
      if(typeof nativeStart!=="function")continue;
      const recognitionTracks=new WeakMap();
      const release=recognition=>{const track=recognitionTracks.get(recognition);if(track?.readyState==="live")track.stop();recognitionTracks.delete(recognition);};
      try{
        Object.defineProperty(prototype,"__meetBridgeSpeechStartInstalled",{configurable:true,value:true});
        Object.defineProperty(prototype,"start",{configurable:true,writable:true,value:function(...args){
          if(!active||bridgeRole!=="receiver"||args.length>0)return nativeStart.apply(this,args);
          const source=outputTrack;
          if(!source||source.readyState!=="live"){
            diagnostic("speech-recognition-bridge-unavailable",{active,bridgeRole,hasOutput:Boolean(source),outputState:source?.readyState||"none"});
            throw new DOMException("Meet Bridge 识别音轨尚未连接，请等待显示混音中后重试。","NotReadableError");
          }
          release(this);
          const track=source.clone();
          recognitionTracks.set(this,track);
          const cleanup=()=>release(this);
          this.addEventListener("end",cleanup,{once:true});
          this.addEventListener("error",cleanup,{once:true});
          diagnostic("speech-recognition-bridge-start",{sourceTrackId:source.id,inputTrackId:track.id,sourceState:source.readyState});
          try{return nativeStart.call(this,track);}catch(error){release(this);diagnostic("speech-recognition-bridge-failed",{name:error?.name||"Error",message:error?.message||String(error)});throw error;}
        }});
        diagnostic("speech-recognition-bridge-installed",{constructor:Constructor.name||"SpeechRecognition"});
      }catch(error){diagnostic("speech-recognition-bridge-install-failed",{message:error?.message||String(error)});}
    }
  }
  function selectOutputTrack(track,source){
    if(!track||track.readyState!=="live")return;
    const previous=outputTrack;outputTrack=track;
    diagnostic("bridge-output-selected",{source,trackId:track.id,previousTrackId:previous?.id||null});
    settle();refreshBindings();refreshSharedBindings();
    if(source==="pcm-datachannel"&&jitsiEffectTrack){const oldEffectTrack=jitsiEffectTrack,oldEffectMixTrack=jitsiEffectMixTrack;jitsiEffectTrack=null;jitsiEffectInstance=null;jitsiEffectMixTrack=null;if(oldEffectMixTrack?.readyState==="live")oldEffectMixTrack.stop();oldEffectTrack.setEffect(undefined).catch(()=>{});}
  }
  function createPcmPageOutput(channel){
    if(outputPcm)outputPcm.close();
    const pending=[];
    const state={track:null,channel,closed:false,closeImpl:null,close(){if(this.closed)return;this.closed=true;channel.onmessage=null;channel.onopen=null;pending.length=0;try{this.closeImpl?.();}catch{}}};
    outputPcm=state;
    channel.binaryType="arraybuffer";
    channel.onmessage=event=>{if(state.closed||!(event.data instanceof ArrayBuffer)||event.data.byteLength<10)return;pending.push(event.data);if(pending.length>200)pending.splice(0,pending.length-40);};
    void initializePcmPageWorklet(state,pending).catch(error=>{
      diagnostic("pcm-page-audioworklet-fallback",{name:error?.name||"Error",message:error?.message||String(error)});
      if(!state.closed&&outputPcm===state)initializeLegacyPcmPageOutput(state,pending);
    });
  }
  async function initializePcmPageWorklet(state,pending){
    if(!pageWorkletUrl)throw new Error("AudioWorklet module URL is unavailable");
    const context=new AudioContext({latencyHint:"interactive",sampleRate:48000});
    try{await context.audioWorklet.addModule(pageWorkletUrl);}catch(error){await context.close().catch(()=>{});throw error;}
    if(state.closed||outputPcm!==state){await context.close().catch(()=>{});return;}
    const destination=context.createMediaStreamDestination(),processor=new AudioWorkletNode(context,"meet-bridge-pcm-page-output",{numberOfInputs:0,numberOfOutputs:1,outputChannelCount:[1],channelCount:1,channelCountMode:"explicit"}),silent=context.createGain();
    silent.gain.value=0;processor.connect(destination);processor.connect(silent);silent.connect(context.destination);
    const track=destination.stream.getAudioTracks()[0];let lastReceiveAt=0,estimatedQueuedFrames=0;
    processor.port.onmessage=event=>{const data=event.data;if(data?.type!=="render-level")return;estimatedQueuedFrames=Number(data.queuedFrames)||0;diagnostic("pcm-page-render-level",{rms:Number(data.rms)||0,queuedFrames:estimatedQueuedFrames,contextState:context.state,trackId:track.id,renderer:"audio-worklet"});};
    const forward=buffer=>{if(state.closed||!(buffer instanceof ArrayBuffer)||buffer.byteLength<10)return;const header=new DataView(buffer,0,8),sampleRate=header.getUint32(0,true),sequence=header.getUint32(4,true),encoded=new Int16Array(buffer,8);let sum=0;for(const value of encoded){const sample=value/32768;sum+=sample*sample;}estimatedQueuedFrames+=encoded.length;const now=Date.now();if(now-lastReceiveAt>=1000){lastReceiveAt=now;diagnostic("pcm-datachannel-received",{sequence,frames:encoded.length,sampleRate,rms:Number(Math.sqrt(sum/encoded.length).toFixed(5)),queuedFrames:estimatedQueuedFrames,renderer:"audio-worklet"});}processor.port.postMessage(buffer,[buffer]);};
    state.channel.onmessage=event=>forward(event.data);
    state.channel.onopen=()=>{context.resume().then(()=>diagnostic("pcm-page-context-resumed",{state:context.state,trackId:track.id,renderer:"audio-worklet"})).catch(error=>diagnostic("pcm-page-context-resume-failed",{state:context.state,message:error?.message||String(error),renderer:"audio-worklet"}));};
    state.track=track;
    state.closeImpl=()=>{processor.port.onmessage=null;processor.port.postMessage({type:"close"});processor.disconnect();destination.disconnect();silent.disconnect();track.stop();void context.close();};
    for(const buffer of pending.splice(0))forward(buffer);
    if(state.channel.readyState==="open")state.channel.onopen();
    diagnostic("pcm-page-audioworklet-ready",{trackId:track.id,state:context.state});
    selectOutputTrack(track,"pcm-datachannel");
  }
  function initializeLegacyPcmPageOutput(state,pending){
    const context=new AudioContext({latencyHint:"interactive",sampleRate:48000}),destination=context.createMediaStreamDestination(),processor=context.createScriptProcessor(2048,1,1),clock=context.createConstantSource(),silent=context.createGain();
    silent.gain.value=0;clock.offset.value=0;clock.connect(processor);processor.connect(destination);processor.connect(silent);silent.connect(context.destination);clock.start();
    const track=destination.stream.getAudioTracks()[0],chunks=[];let chunkOffset=0,queuedFrames=0,started=false,lastReceiveAt=0,lastRenderAt=0;
    const discard=count=>{let remaining=count;while(remaining>0&&chunks.length){const available=chunks[0].length-chunkOffset,take=Math.min(remaining,available);chunkOffset+=take;queuedFrames-=take;remaining-=take;if(chunkOffset>=chunks[0].length){chunks.shift();chunkOffset=0;}}};
    const receive=buffer=>{if(state.closed||!(buffer instanceof ArrayBuffer)||buffer.byteLength<10)return;const header=new DataView(buffer,0,8),sampleRate=header.getUint32(0,true),sequence=header.getUint32(4,true),encoded=new Int16Array(buffer,8),samples=new Float32Array(encoded.length);let sum=0;for(let index=0;index<encoded.length;index++){const sample=encoded[index]/32768;samples[index]=sample;sum+=sample*sample;}chunks.push(samples);queuedFrames+=samples.length;if(queuedFrames>48000)discard(queuedFrames-9600);const now=Date.now();if(now-lastReceiveAt>=1000){lastReceiveAt=now;diagnostic("pcm-datachannel-received",{sequence,frames:samples.length,sampleRate,rms:Number(Math.sqrt(sum/samples.length).toFixed(5)),queuedFrames,renderer:"script-processor-fallback"});}};
    processor.onaudioprocess=event=>{const output=event.outputBuffer.getChannelData(0);if(!started&&queuedFrames<3840){output.fill(0);return;}started=true;if(queuedFrames>14400)discard(queuedFrames-9600);let sum=0;for(let index=0;index<output.length;index++){let sample=0;if(chunks.length){sample=chunks[0][chunkOffset++];queuedFrames--;if(chunkOffset>=chunks[0].length){chunks.shift();chunkOffset=0;}}output[index]=sample;sum+=sample*sample;}if(queuedFrames===0)started=false;const now=Date.now();if(now-lastRenderAt>=1000){lastRenderAt=now;diagnostic("pcm-page-render-level",{rms:Number(Math.sqrt(sum/output.length).toFixed(5)),queuedFrames,contextState:context.state,trackId:track.id,renderer:"script-processor-fallback"});}};
    state.channel.onmessage=event=>receive(event.data);
    state.channel.onopen=()=>{context.resume().then(()=>diagnostic("pcm-page-context-resumed",{state:context.state,trackId:track.id,renderer:"script-processor-fallback"})).catch(error=>diagnostic("pcm-page-context-resume-failed",{state:context.state,message:error?.message||String(error),renderer:"script-processor-fallback"}));};
    state.track=track;
    state.closeImpl=()=>{processor.onaudioprocess=null;clock.stop();clock.disconnect();processor.disconnect();destination.disconnect();silent.disconnect();track.stop();void context.close();};
    for(const buffer of pending.splice(0))receive(buffer);
    if(state.channel.readyState==="open")state.channel.onopen();
    diagnostic("pcm-page-scriptprocessor-ready",{trackId:track.id,state:context.state});
    selectOutputTrack(track,"pcm-datachannel");
  }
  function stopBinding(b,reason){if(!b||b.closed)return;b.closed=true;clearInterval(b.timer);bindings.delete(b);if(bindingsBySender.get(b.sender)===b)bindingsBySender.delete(b.sender);if(b.mix?.readyState==="live")b.mix.stop();debug("[Meet Bridge] final sender detached",{reason,source:b.source});}
  function clearBindings(reason){for(const b of [...bindings])stopBinding(b,reason);}
  const trackRole=track=>!track?"none":displayAudioTracks.has(track)?"display-audio":bridgeAudioTracks.has(track)?"bridge-audio":"unknown-audio";
  function stopSharedBinding(b,reason){if(!b||b.closed)return;b.closed=true;sharedBindings.delete(b);if(sharedBindingsBySender.get(b.sender)===b)sharedBindingsBySender.delete(b.sender);if(b.mix?.readyState==="live")b.mix.stop();diagnostic("shared-mic-binding-stopped",{reason});}
  function clearSharedBindings(reason){for(const b of [...sharedBindings])stopSharedBinding(b,reason);}
  async function attachSharedMix(b){if(b.closed||!active||micMode!=="shared")return false;const source=await waitOutput();if(b.closed||source.readyState!=="live")return false;const mix=source.clone();bridgeAudioTracks.add(mix);mix.enabled=b.enabledTrack.enabled;const old=b.mix;await nativeReplace.call(b.sender,mix);if(b.closed){mix.stop();return false;}b.mix=mix;if(old?.readyState==="live")old.stop();diagnostic("shared-mic-refreshed",{source:b.source,pcId:b.pcId});return true;}
  function refreshSharedBindings(){for(const b of [...sharedBindings])attachSharedMix(b).catch(error=>diagnostic("shared-mic-refresh-failed",{name:error?.name||"Error"}));}
  function bindSharedSender(sender,track,source,pc=null){if(!active||micMode!=="shared"||internalSenders.has(sender)||track?.kind!=="audio"||!bridgeAudioTracks.has(track))return;const previous=sharedBindingsBySender.get(sender);if(previous?.enabledTrack===track)return;if(previous)stopSharedBinding(previous,"site microphone changed");const b={sender,enabledTrack:track,source,pcId:pcId(pc),mix:null,closed:false};sharedBindingsBySender.set(sender,b);sharedBindings.add(b);diagnostic("shared-mic-bound",{source,pcId:b.pcId});attachSharedMix(b).catch(error=>{diagnostic("shared-mic-bind-failed",{name:error?.name||"Error"});stopSharedBinding(b,"attach error");});}
  async function attachMix(b){if(b.closed||!active||micMode!=="page")return false;const source=await waitOutput();if(b.closed||source.readyState!=="live")return false;const mix=source.clone();bridgeAudioTracks.add(mix);mix.enabled=b.physical.enabled;const old=b.mix;await nativeReplace.call(b.sender,mix);if(b.closed){mix.stop();return false;}b.mix=mix;if(old?.readyState==="live")old.stop();const info={source:b.source,pcId:b.pcId,mixTrackId:mix.id};debug("[Meet Bridge] final N-1 mix attached",info);diagnostic("final-mix-attached",info);return true;}
  function refreshBindings(){for(const b of [...bindings])attachMix(b).catch(e=>console.error("[Meet Bridge] final mix refresh failed",e));}
  const isJitsiEffectHost=()=>location.hostname==="meet.jit.si";
  async function waitForJitsiEffectOrFallback(){
    if(!isJitsiEffectHost()||jitsiSenderFallbackActive)return !jitsiEffectTrack;
    const deadline=Date.now()+2500;
    while(active&&micMode==="page"&&!jitsiEffectTrack&&!jitsiSenderFallbackActive&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));
    if(jitsiEffectTrack){diagnostic("jitsi-generic-sender-skipped",{reason:"effect-installed"});return false;}
    if(!jitsiSenderFallbackActive){jitsiSenderFallbackActive=true;diagnostic("jitsi-generic-sender-fallback",{reason:"effect-unavailable-after-startup"});}
    return true;
  }
  async function bindSender(sender,physical,source,pc=null){if(!active||micMode!=="page"||!nativeReplace||internalSenders.has(sender)||physical?.kind!=="audio")return;const meta=nativeTracks.get(physical);if(!meta)return;if(!(await waitForJitsiEffectOrFallback()))return;const previous=bindingsBySender.get(sender);if(previous?.physical===physical)return;if(previous)stopBinding(previous,"site microphone changed");const b={sender,physical,source,pcId:pcId(pc),mix:null,closed:false,timer:null};bindingsBySender.set(sender,b);bindings.add(b);b.timer=setInterval(()=>{if(b.closed)return;if(b.mix?.readyState==="live")b.mix.enabled=b.physical.enabled;if(b.physical.readyState!=="live")stopBinding(b,"physical track ended");},150);physical.addEventListener("ended",()=>stopBinding(b,"physical track ended"),{once:true});const info={source,pcId:b.pcId,requestId:meta.requestId};debug("[Meet Bridge] site sender detected",info);diagnostic("site-sender-detected",info);try{await updatePageTransport(physical,meta.requestId);await attachMix(b);}catch(e){diagnostic("final-mix-attach-failed",{name:e?.name||"Error",source});console.error("[Meet Bridge] final mix attach failed");stopBinding(b,"attach error");}}
  function installObserver(){const p=PC.prototype;if(p.__meetBridgeSenderObserverInstalled)return;const addTrack=p.addTrack,addTrans=p.addTransceiver,sp=window.RTCRtpSender?.prototype;nativeReplace=sp?.replaceTrack;if(!nativeReplace)return;Object.defineProperty(p,"__meetBridgeSenderObserverInstalled",{configurable:true,value:true});p.addTrack=function(track,...streams){const sender=addTrack.call(this,track,...streams);if(!internalPCs.has(this)){diagnostic("sender-add-track",{pcId:pcId(this),kind:track?.kind,trackRole:track?.kind==="audio"?trackRole(track):undefined,trackId:track?.id});bindSharedSender(sender,track,"addTrack",this);bindSender(sender,track,"addTrack",this);}return sender;};if(typeof addTrans==="function")p.addTransceiver=function(trackOrKind,init){const trans=addTrans.call(this,trackOrKind,init);if(!internalPCs.has(this)&&typeof trackOrKind!=="string"){diagnostic("sender-add-transceiver",{pcId:pcId(this),kind:trackOrKind?.kind,trackRole:trackOrKind?.kind==="audio"?trackRole(trackOrKind):undefined,trackId:trackOrKind?.id});bindSharedSender(trans.sender,trackOrKind,"addTransceiver",this);bindSender(trans.sender,trackOrKind,"addTransceiver",this);}return trans;};sp.replaceTrack=function(track){if(internalSenders.has(this))return nativeReplace.call(this,track);diagnostic("sender-replace-track",{trackId:track?.id||null,kind:track?.kind||"none",trackRole:track?.kind==="audio"?trackRole(track):undefined});if(!track){const b=bindingsBySender.get(this);if(b)stopBinding(b,"site cleared sender");const shared=sharedBindingsBySender.get(this);if(shared)stopSharedBinding(shared,"site cleared sender");return nativeReplace.call(this,track);}const shared=sharedBindingsBySender.get(this);if(shared&&!bridgeAudioTracks.has(track))stopSharedBinding(shared,trackRole(track)==="display-audio"?"site switched to display audio":"site microphone changed");const ret=nativeReplace.call(this,track);Promise.resolve(ret).then(()=>diagnostic("sender-replace-resolved",{trackId:this.track?.id||null,enabled:this.track?.enabled??null,muted:this.track?.muted??null,readyState:this.track?.readyState||null,trackRole:this.track?.kind==="audio"?trackRole(this.track):undefined})).catch(error=>diagnostic("sender-replace-failed",{name:error?.name||"Error"}));bindSharedSender(this,track,"replaceTrack");bindSender(this,track,"replaceTrack");return ret;};}
  function installLegacyObserver(){if(!LegacyPC||LegacyPC===PC||LegacyPC.prototype===PC.prototype)return;const p=LegacyPC.prototype;if(p.__meetBridgeLegacyObserverInstalled)return;const addTrack=p.addTrack,addTrans=p.addTransceiver;Object.defineProperty(p,"__meetBridgeLegacyObserverInstalled",{configurable:true,value:true});p.addTrack=function(track,...streams){const sender=addTrack.call(this,track,...streams);if(!internalPCs.has(this)){diagnostic("legacy-sender-add-track",{pcId:pcId(this),kind:track?.kind,trackId:track?.id});bindSender(sender,track,"legacy-addTrack",this);}return sender;};if(typeof addTrans==="function")p.addTransceiver=function(trackOrKind,init){const trans=addTrans.call(this,trackOrKind,init);if(!internalPCs.has(this)&&typeof trackOrKind!=="string"){diagnostic("legacy-sender-add-transceiver",{pcId:pcId(this),kind:trackOrKind?.kind,trackId:trackOrKind?.id});bindSender(trans.sender,trackOrKind,"legacy-addTransceiver",this);}return trans;};diagnostic("legacy-pc-observer-installed",{});}
  function closeOutput(){if(outputPcm){outputPcm.close();outputPcm=null;}if(outputPC){outputPC.ontrack=null;outputPC.ondatachannel=null;outputPC.onicecandidate=null;outputPC.close();}outputPC=null;outputTrack=null;outputCandidates=[];}
  function closePage(){generation++;clearBindings("bridge stopped");clearSharedBindings("bridge stopped");if(jitsiEffectTrack?.setEffect)jitsiEffectTrack.setEffect(undefined).catch(()=>{});if(jitsiEffectMixTrack?.readyState==="live")jitsiEffectMixTrack.stop();jitsiEffectTrack=null;jitsiEffectMixTrack=null;jitsiEffectInstance=null;jitsiSenderFallbackActive=false;if(pagePC){pagePC.onicecandidate=null;pagePC.close();}pagePC=null;pageSender=null;pageTrack=null;pageCandidates=[];updateQueue=Promise.resolve();}
  async function createOutput(offer){const early=outputCandidates;closeOutput();outputCandidates=early;const pc=new PC({iceServers:[]});internalPCs.add(pc);outputPC=pc;pc.onicecandidate=({candidate:c})=>{if(c)post("SIGNAL_FROM_MAIN",{signal:{candidate:candidate(c)}});};pc.ondatachannel=({channel})=>{if(channel.label==="meet-bridge-pcm")createPcmPageOutput(channel);};pc.ontrack=({track})=>{if(track.kind!=="audio"||outputPcm)return;selectOutputTrack(track,"webrtc-audio-fallback");track.addEventListener("ended",()=>{if(outputTrack===track)outputTrack=null;},{once:true});};await pc.setRemoteDescription(offer);for(const c of outputCandidates.splice(0))await pc.addIceCandidate(c);await pc.setLocalDescription(await pc.createAnswer());post("SIGNAL_FROM_MAIN",{signal:{description:description(pc.localDescription)}});}
  async function pageSignal(s){if(!pagePC)return;if(s.description?.type==="answer"){await pagePC.setRemoteDescription(s.description);for(const c of pageCandidates.splice(0))await pagePC.addIceCandidate(c);}if(s.candidate){if(pagePC.remoteDescription)await pagePC.addIceCandidate(s.candidate);else pageCandidates.push(s.candidate);}}
  async function outputSignal(s){if(s.description?.type==="offer")await createOutput(s.description);if(s.candidate){if(outputPC?.remoteDescription)await outputPC.addIceCandidate(s.candidate);else outputCandidates.push(s.candidate);}}
  function watchPageTrack(track){track.addEventListener("ended",()=>{if(pageTrack!==track)return;pageTrack=null;if(pageSender&&nativeReplace)nativeReplace.call(pageSender,null).catch(()=>{});},{once:true});}
  async function createPageTransport(physical,gen,id){if(pagePC)pagePC.close();const pc=new PC({iceServers:[]});internalPCs.add(pc);pagePC=pc;pageSender=pc.addTrack(physical,new MS([physical]));internalSenders.add(pageSender);pageTrack=physical;pageCandidates=[];watchPageTrack(physical);pc.onicecandidate=({candidate:c})=>{if(c&&pagePC===pc&&generation===gen)post("SIGNAL_FROM_MAIN",{signal:{channel:"page-mic",candidate:candidate(c)}});};await pc.setLocalDescription(await pc.createOffer({offerToReceiveAudio:false}));if(generation!==gen||pagePC!==pc||!active){pc.close();return false;}diagnostic("page-mic-offer-created",{requestId:id});post("SIGNAL_FROM_MAIN",{signal:{channel:"page-mic",description:description(pc.localDescription)}});diagnostic("page-mic-offer-sent",{requestId:id});debug("[Meet Bridge] page mic transport built",{id});return true;}
  function updatePageTransport(physical,id){const gen=generation;const run=async()=>{if(gen!==generation||!active)return false;const reuse=pagePC&&pageSender&&!["closed","failed"].includes(pagePC.connectionState);if(!reuse)return createPageTransport(physical,gen,id);if(pageTrack===physical)return true;await nativeReplace.call(pageSender,physical);if(gen!==generation||!active)return false;pageTrack=physical;watchPageTrack(physical);debug("[Meet Bridge] page mic transport replaced",{id});return true;};const update=updateQueue.catch(()=>{}).then(run);updateQueue=update;return update;}
  function findJitsiLocalAudioTrack(){
    const app=window.APP, conference=app?.conference, room=conference?._room;
    const candidates=[room?.getLocalAudioTrack?.(),conference?.getLocalAudioTrack?.(),room?.rtc?.getLocalAudioTrack?.()];
    return candidates.find(track=>track&&typeof track.setEffect==="function"&&((typeof track.isAudioTrack!=="function")||track.isAudioTrack()))||null;
  }
  async function installJitsiEffect(){
    if(!isJitsiEffectHost()||!active||micMode!=="page"||jitsiEffectRunning||jitsiSenderFallbackActive)return;
    const localTrack=findJitsiLocalAudioTrack();
    const state=localTrack?`track:${localTrack.getTrack?.()?.id||"unknown"}`:"waiting-for-jitsi-local-audio-track";
    if(state!==jitsiProbeState){jitsiProbeState=state;diagnostic("jitsi-effect-probe",{state,hasApp:Boolean(window.APP),hasConference:Boolean(window.APP?.conference)});}
    if(!localTrack||localTrack===jitsiEffectTrack)return;
    jitsiEffectRunning=true;
    let effectMuted=false,effectMixTrack=null;
    const effect={
      isEnabled:()=>true,
      startEffect:stream=>{
        const physical=stream?.getAudioTracks?.()[0];
        if(!physical)throw new DOMException("Jitsi effect 未收到原始麦克风轨。","NotReadableError");
        const id=++requestSeq;latestRequest=id;
        diagnostic("jitsi-effect-start",{requestId:id,physicalTrackId:physical.id});
        updatePageTransport(physical,id).then(ok=>diagnostic("jitsi-effect-page-mic-result",{requestId:id,ok})).catch(error=>diagnostic("jitsi-effect-page-mic-failed",{message:error?.message||String(error)}));
        const source=outputTrack;
        if(!source||source.readyState!=="live")throw new DOMException("Jitsi effect 启动时混音轨尚未就绪。","NotReadableError");
        const mix=source.clone();
        effectMuted=!physical.enabled;
        mix.enabled=!effectMuted;
        bridgeAudioTracks.add(mix);effectMixTrack=mix;jitsiEffectMixTrack=mix;
        probeAudioTrack(mix,"jitsi-effect-mix");
        diagnostic("jitsi-effect-returned-mix",{requestId:id,mixTrackId:mix.id,enabled:mix.enabled,muted:mix.muted,readyState:mix.readyState});
        return new MS([mix]);
      },
      isMuted:()=>effectMuted,
      setMuted:muted=>{effectMuted=Boolean(muted);if(effectMixTrack?.readyState==="live")effectMixTrack.enabled=!effectMuted;diagnostic("jitsi-effect-muted",{muted:effectMuted,mixTrackId:effectMixTrack?.id||null,enabled:effectMixTrack?.enabled??null});},
      stopEffect:()=>{
        if(effectMixTrack?.readyState==="live")effectMixTrack.stop();
        effectMixTrack=null;
        if(jitsiEffectInstance===effect){jitsiEffectMixTrack=null;jitsiEffectTrack=null;jitsiEffectInstance=null;diagnostic("jitsi-effect-stopped",{reinstallScheduled:true});}
        else diagnostic("jitsi-effect-stopped",{reinstallScheduled:false,reason:"superseded-effect"});
      },
    };
    try{await localTrack.setEffect(effect);if(jitsiSenderFallbackActive){await localTrack.setEffect(undefined).catch(()=>{});diagnostic("jitsi-effect-suppressed",{reason:"generic-fallback-active"});}else{jitsiEffectTrack=localTrack;jitsiEffectInstance=effect;diagnostic("jitsi-effect-installed",{trackId:localTrack.getTrack?.()?.id||null});}}
    catch(error){diagnostic("jitsi-effect-install-failed",{message:error?.message||String(error)});}
    finally{jitsiEffectRunning=false;}
  }
  setInterval(()=>installJitsiEffect().catch(error=>diagnostic("jitsi-effect-probe-failed",{message:error?.message||String(error)})),750);
  function register(stream){const id=++requestSeq;latestRequest=id;for(const track of stream.getAudioTracks()){const meta={requestId:id};nativeTracks.set(track,meta);nativeDebug.set(track,meta);track.addEventListener("ended",()=>nativeDebug.delete(track),{once:true});}debug("[Meet Bridge] native meeting microphone registered",{id,trackCount:stream.getAudioTracks().length});}
  async function gum(constraints={}){const wantsAudio=Boolean(constraints?.audio);diagnostic("gum-called",{wantsAudio,active,micMode,hasVideo:Boolean(constraints?.video)});if(wantsAudio&&!configKnown)await Promise.race([initialConfig,new Promise(r=>setTimeout(r,2500))]);if(wantsAudio&&active&&micMode==="page"){const stream=await nativeGum(constraints);diagnostic("native-gum-returned",{audioTrackCount:stream.getAudioTracks().length,allTracksLive:stream.getAudioTracks().every(t=>t.readyState==="live")});register(stream);return stream;}if(!wantsAudio||!active)return nativeGum(constraints);const track=await waitOutput(),stream=new MS();if(constraints?.video){const camera=await nativeGum({...constraints,audio:false});for(const t of camera.getVideoTracks())stream.addTrack(t);}const bridgeTrack=track.clone();bridgeAudioTracks.add(bridgeTrack);stream.addTrack(bridgeTrack);return stream;}
  async function gdm(constraints={}){diagnostic("display-media-called",{wantsAudio:Boolean(constraints?.audio),hasVideo:Boolean(constraints?.video)});const stream=await nativeGdm(constraints);const audioTracks=stream.getAudioTracks();for(const track of audioTracks){displayAudioTracks.add(track);track.addEventListener("ended",()=>diagnostic("display-audio-ended",{}),{once:true});}diagnostic("display-media-returned",{audioTrackCount:audioTracks.length,allAudioTracksLive:audioTracks.every(track=>track.readyState==="live")});return stream;}
  try{Object.defineProperty(md,"getUserMedia",{configurable:true,enumerable:true,writable:true,value:gum});}catch{md.getUserMedia=gum;}if(nativeGdm){try{Object.defineProperty(md,"getDisplayMedia",{configurable:true,enumerable:true,writable:true,value:gdm});}catch{md.getDisplayMedia=gdm;}}const legacy=(c,ok,bad)=>gum(c).then(ok,bad);navigator.getUserMedia=legacy;navigator.webkitGetUserMedia=legacy;installObserver();installLegacyObserver();installSpeechRecognitionBridge();
  Object.defineProperty(window,"__meetBridgeDebug",{configurable:true,value:{dump:()=>({active,bridgeRole,diagnosticsEnabled,generation,latestRequest,outputTrack:outputTrack?{id:outputTrack.id,muted:outputTrack.muted,readyState:outputTrack.readyState}:null,pageMicrophone:pageTrack?{id:pageTrack.id,muted:pageTrack.muted,readyState:pageTrack.readyState}:null,nativeMicrophones:[...nativeDebug.entries()].map(([t,m])=>({id:t.id,enabled:t.enabled,readyState:t.readyState,requestId:m.requestId})),finalSenderBindings:[...bindings].map(b=>({source:b.source,physicalTrackId:b.physical.id,physicalEnabled:b.physical.enabled,mixTrackId:b.mix?.id||null,mixEnabled:b.mix?.enabled??null,mixReadyState:b.mix?.readyState||"none"})),transportState:pagePC?.connectionState||"none"})}});
  window.addEventListener("message",event=>{const m=event.data;if(event.source!==window||m?.channel!==CHANNEL||m?.direction!=="to-main")return;if(m.type==="EXTENSION_READY")post("MAIN_READY");else if(m.type==="BRIDGE_CONFIG"){active=Boolean(m.active);micMode=m.micMode==="page"?"page":"shared";bridgeRole=m.role==="receiver"?"receiver":m.role==="source"?"source":"meeting";pageWorkletUrl=typeof m.pageWorkletUrl==="string"?m.pageWorkletUrl:"";diagnosticsEnabled=Boolean(m.diagnosticsEnabled);if(!diagnosticsEnabled){for(const probe of audioProbes.values()){clearInterval(probe.timer);void probe.context.close();}audioProbes.clear();}configKnown=true;resolveConfig();if(!active){settle(new DOMException("Meet Bridge 已停止。","NotAllowedError"));closePage();closeOutput();}}else if(m.type==="SIGNAL_FROM_OFFSCREEN"){(m.signal?.channel==="page-mic"?pageSignal:outputSignal)(m.signal).catch(e=>console.error("[Meet Bridge] WebRTC signaling failed",e));}});
  window.addEventListener("pagehide",()=>{diagnostic("main-pagehide");closePage();closeOutput();},{once:true});diagnostic("main-world-ready",{isTopFrame:window===window.top});post("MAIN_READY");
})();
