import React, { useState, useEffect, useRef, useCallback } from 'react';
import { FunctionDeclaration, GoogleGenAI, LiveServerMessage, Modality, Type } from '@google/genai';
import { Visualizer } from './components/Visualizer';
import { generateImage, editImage } from './services/imageService';
import { createPcmBlob, decodeAudioData } from './services/audioUtils';
import { HistoryItem, AppState } from './types';

// Define Tools
const generateImageTool: FunctionDeclaration = {
  name: 'generate_image',
  description: 'Generates a new image based on a text description. Can optionally use the current image as a reference.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      prompt: {
        type: Type.STRING,
        description: 'The detailed description of the image to generate.'
      },
      use_reference: {
        type: Type.BOOLEAN,
        description: 'Whether to use the currently visible image as a visual reference/structure for the generation.'
      },
      aspect_ratio: {
        type: Type.STRING,
        description: 'Aspect ratio of the generated image. Options: "1:1", "3:4", "4:3", "9:16", "16:9". Default is "16:9".'
      },
      image_size: {
        type: Type.STRING,
        description: 'Resolution of the generated image. Options: "1K", "2K", "4K". Default is "1K".'
      }
    },
    required: ['prompt']
  }
};

const editImageTool: FunctionDeclaration = {
  name: 'edit_image',
  description: 'Edits the currently visible image based on instructions.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      instruction: {
        type: Type.STRING,
        description: 'The instruction for how to modify the image.'
      },
      aspect_ratio: {
        type: Type.STRING,
        description: 'Target aspect ratio. Options: "1:1", "3:4", "4:3", "9:16", "16:9".'
      },
      image_size: {
        type: Type.STRING,
        description: 'Target resolution. Options: "1K", "2K", "4K".'
      }
    },
    required: ['instruction']
  }
};

// FIX: Removed conflicting global Window declaration. 
// To interact with window.aistudio, we will cast window to any to avoid type mismatch errors.

const App: React.FC = () => {
  // App State
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [hasApiKey, setHasApiKey] = useState<boolean>(false);
  
  // History State
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState<number>(-1);
  const [isLoadingImage, setIsLoadingImage] = useState(false);
  
  const [logs, setLogs] = useState<string[]>([]);
  
  // Computed properties
  const currentHistoryItem = currentIndex >= 0 ? history[currentIndex] : null;

  // Live API Refs
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  
  // Ref for current image data to be accessible in callbacks
  const currentImageRef = useRef<string | null>(null);

  // Check for API Key on mount
  useEffect(() => {
    const checkKey = async () => {
      // FIX: Cast to any to avoid conflict with existing global definitions
      const aistudio = (window as any).aistudio;
      if (aistudio && aistudio.hasSelectedApiKey) {
        const hasKey = await aistudio.hasSelectedApiKey();
        setHasApiKey(hasKey);
      } else {
        // Fallback for local dev or if aistudio bridge is missing, assuming env var is there
        setHasApiKey(!!process.env.API_KEY);
      }
    };
    checkKey();
  }, []);

  const handleSelectKey = async () => {
    // FIX: Cast to any to access openSelectKey
    const aistudio = (window as any).aistudio;
    if (aistudio && aistudio.openSelectKey) {
      await aistudio.openSelectKey();
      setHasApiKey(true);
    }
  };

  // Sync ref with state
  useEffect(() => {
    currentImageRef.current = currentHistoryItem?.data || null;
  }, [currentHistoryItem]);

  const addLog = (msg: string) => setLogs(prev => [...prev, msg].slice(-5));

  const addToHistory = (data: string, source: 'upload' | 'generated' | 'edited') => {
    const newItem: HistoryItem = {
      id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(),
      data,
      mimeType: 'image/png', // Simplified for this demo
      timestamp: Date.now(),
      source
    };
    
    setHistory(prev => {
      const newHistory = [...prev, newItem];
      setCurrentIndex(newHistory.length - 1);
      return newHistory;
    });
  };

  const handleDownload = () => {
    if (!currentHistoryItem) return;
    
    const link = document.createElement('a');
    link.href = currentHistoryItem.data;
    // Simple extension detection from data URI
    const match = currentHistoryItem.data.match(/data:image\/(\w+);/);
    const ext = match ? match[1] : 'png';
    link.download = `voice-pixels-${currentHistoryItem.id}.${ext}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleToolCall = async (toolCall: any) => {
    const functionCalls = toolCall.functionCalls;
    const responses = [];

    for (const call of functionCalls) {
      console.log('Tool call received:', call.name, call.args);
      addLog(`Executing: ${call.name}`);
      
      try {
        if (call.name === 'generate_image') {
          setIsLoadingImage(true);
          // Pass reference image only if requested AND available
          const referenceImage = call.args.use_reference ? currentImageRef.current : undefined;
          const config = {
            aspectRatio: call.args.aspect_ratio,
            imageSize: call.args.image_size
          };
          const newImageData = await generateImage(call.args.prompt, referenceImage || undefined, config);
          
          addToHistory(newImageData, 'generated');
          setIsLoadingImage(false);
          
          responses.push({
            id: call.id,
            name: call.name,
            response: { result: "Image generated successfully and added to timeline." }
          });
        } else if (call.name === 'edit_image') {
          if (!currentImageRef.current) {
             responses.push({
              id: call.id,
              name: call.name,
              response: { result: "Error: No image is currently selected to edit. Ask user to upload or generate one first." }
            });
          } else {
            setIsLoadingImage(true);
            const config = {
              aspectRatio: call.args.aspect_ratio,
              imageSize: call.args.image_size
            };
            const editedImageData = await editImage(currentImageRef.current, call.args.instruction, config);
            
            addToHistory(editedImageData, 'edited');
            setIsLoadingImage(false);
            
            responses.push({
              id: call.id,
              name: call.name,
              response: { result: "Image edited successfully and added to timeline." }
            });
          }
        }
      } catch (error: any) {
        console.error("Tool Execution Error", error);
        setIsLoadingImage(false);
        responses.push({
          id: call.id,
          name: call.name,
          response: { result: `Error executing tool: ${error.message}` }
        });
      }
    }

    // Send response back to Live API
    if (sessionPromiseRef.current && responses.length > 0) {
      try {
        const session = await sessionPromiseRef.current;
        session.sendToolResponse({ functionResponses: responses });
      } catch (e) {
        console.error("Failed to send tool response", e);
      }
    }
  };

  const startSession = async () => {
    try {
      setAppState(AppState.LISTENING);
      // New instance to pick up potentially selected key
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      // Initialize Audio Contexts
      const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
      inputAudioContextRef.current = new AudioContext({ sampleRate: 16000 });
      outputAudioContextRef.current = new AudioContext({ sampleRate: 24000 });
      
      const inputCtx = inputAudioContextRef.current;
      const outputCtx = outputAudioContextRef.current;
      
      // Connect Microphone
      streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      const source = inputCtx.createMediaStreamSource(streamRef.current);
      
      // Script Processor for raw PCM access
      const processor = inputCtx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;
      
      processor.onaudioprocess = (e) => {
        const inputData = e.inputBuffer.getChannelData(0);
        const pcmBlob = createPcmBlob(inputData);
        
        if (sessionPromiseRef.current) {
          sessionPromiseRef.current.then(session => {
             session.sendRealtimeInput({ media: pcmBlob });
          }).catch(err => {
            // Silently catch for cleanup races
          });
        }
      };
      
      source.connect(processor);
      
      // PREVENT FEEDBACK
      const gainNode = inputCtx.createGain();
      gainNode.gain.value = 0;
      processor.connect(gainNode);
      gainNode.connect(inputCtx.destination);

      // Connect Live API
      sessionPromiseRef.current = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        callbacks: {
          onopen: () => {
            addLog("Connected to Voice Agent");
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle Audio Output
            const audioData = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audioData) {
              setAppState(AppState.SPEAKING);
              
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputCtx.currentTime);
              
              const audioBuffer = await decodeAudioData(
                new Uint8Array(Array.from(atob(audioData), c => c.charCodeAt(0))),
                outputCtx,
                24000
              );
              
              const sourceNode = outputCtx.createBufferSource();
              sourceNode.buffer = audioBuffer;
              sourceNode.connect(outputCtx.destination);
              
              sourceNode.onended = () => {
                sourcesRef.current.delete(sourceNode);
                if (sourcesRef.current.size === 0) {
                   setAppState(AppState.LISTENING);
                }
              };
              
              sourceNode.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              sourcesRef.current.add(sourceNode);
            }

            // Handle Tool Calls
            if (message.toolCall) {
               await handleToolCall(message.toolCall);
            }
            
            // Handle Interruption
            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(node => node.stop());
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
              setAppState(AppState.LISTENING);
            }
          },
          onclose: () => {
            addLog("Connection closed");
            setAppState(AppState.IDLE);
            sessionPromiseRef.current = null;
          },
          onerror: (err) => {
            console.error(err);
            addLog("Connection error");
            setAppState(AppState.ERROR);
            sessionPromiseRef.current = null;
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }
          },
          systemInstruction: `You are a helpful visual design assistant powered by Gemini 3 Pro Image Preview (Nano Banana Pro).
          You manage a visual history timeline of images.
          
          Capabilities:
          - You can generate high-quality images up to 4K resolution.
          - You can control aspect ratios (16:9, 1:1, 9:16, etc).
          - The default generation behavior is 16:9 and 1K resolution unless the user asks otherwise.
          
          Tools:
          1. 'generate_image': Creates a new image. Use 'use_reference=true' if the user wants to base the new image on the currently visible one.
          2. 'edit_image': Modifies the currently visible image.
          
          When you use a tool, a new image will be added to the timeline.
          Always confirm your actions. Be concise.`,
          tools: [{ functionDeclarations: [generateImageTool, editImageTool] }]
        }
      });

    } catch (e) {
      console.error(e);
      setAppState(AppState.ERROR);
    }
  };

  const stopSession = () => {
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (inputAudioContextRef.current) {
      inputAudioContextRef.current.close();
      inputAudioContextRef.current = null;
    }
    if (outputAudioContextRef.current) {
      outputAudioContextRef.current.close();
      outputAudioContextRef.current = null;
    }
    
    sessionPromiseRef.current = null;
    setAppState(AppState.IDLE);
    setLogs([]);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        addToHistory(reader.result as string, 'upload');
      };
      reader.readAsDataURL(file);
    }
  };

  // API Key Selection Screen
  if (!hasApiKey) {
    return (
      <div className="min-h-screen bg-slate-900 text-slate-100 flex flex-col items-center justify-center p-8">
        <div className="max-w-md text-center space-y-6">
          <div className="w-20 h-20 bg-gradient-to-br from-blue-500 to-teal-400 rounded-2xl mx-auto shadow-xl flex items-center justify-center">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-10 h-10 text-white">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 0 1 3 3m3 0a6 6 0 0 1-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1 1 21.75 8.25Z" />
            </svg>
          </div>
          <h1 className="text-3xl font-bold">Setup Required</h1>
          <p className="text-slate-400">
            To use the high-definition <b>Gemini 3 Pro Image</b> model (Nano Banana Pro), you must select a Google Cloud Project with billing enabled.
          </p>
          <button 
            onClick={handleSelectKey}
            className="w-full bg-blue-600 hover:bg-blue-500 text-white py-3 rounded-xl font-bold transition-all shadow-lg shadow-blue-900/20 hover:scale-[1.02] active:scale-95"
          >
            Select API Key
          </button>
          <p className="text-xs text-slate-500">
            <a href="https://ai.google.dev/gemini-api/docs/billing" target="_blank" rel="noreferrer" className="underline hover:text-blue-400">Billing documentation</a>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 flex flex-col items-center p-4 md:p-8">
      <header className="w-full max-w-4xl flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold bg-gradient-to-r from-blue-400 to-teal-400 bg-clip-text text-transparent">
          Voice Pixels <span className="text-xs font-normal text-slate-500 ml-2 border border-slate-700 px-2 py-0.5 rounded">Pro</span>
        </h1>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${appState === AppState.IDLE ? 'bg-slate-500' : 'bg-green-500 animate-pulse'}`}></span>
          <span className="text-xs font-medium uppercase tracking-wider text-slate-400">
            {appState}
          </span>
        </div>
      </header>

      <main className="w-full max-w-4xl flex flex-col gap-6 flex-grow">
        
        {/* Main Image Display */}
        <div className="relative w-full aspect-video bg-slate-800 rounded-xl overflow-hidden border border-slate-700 shadow-2xl flex items-center justify-center group">
          {isLoadingImage && (
            <div className="absolute inset-0 bg-slate-900/80 z-20 flex items-center justify-center backdrop-blur-sm">
              <div className="flex flex-col items-center gap-3">
                <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                <span className="text-blue-400 font-medium">Generating...</span>
              </div>
            </div>
          )}
          
          {currentHistoryItem ? (
            <>
              <img 
                src={currentHistoryItem.data} 
                alt="Current View" 
                className="w-full h-full object-contain" 
              />
              <button 
                 onClick={handleDownload}
                 className="absolute top-4 right-4 p-2 bg-slate-900/60 hover:bg-slate-900/90 text-white rounded-lg backdrop-blur-sm transition-all opacity-0 group-hover:opacity-100 focus:opacity-100 border border-white/10 hover:border-white/20"
                 title="Download Image"
               >
                 <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
                  </svg>
              </button>
            </>
          ) : (
            <div className="text-center p-6">
              <div className="w-16 h-16 bg-slate-700 rounded-full flex items-center justify-center mx-auto mb-4 text-slate-400">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-8 h-8">
                  <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />
                </svg>
              </div>
              <p className="text-slate-400 mb-4">No image loaded</p>
              <label className="cursor-pointer inline-flex items-center gap-2 bg-slate-700 hover:bg-slate-600 transition px-4 py-2 rounded-full text-sm font-medium shadow-md">
                <input type="file" accept="image/*" onChange={handleFileUpload} className="hidden" />
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                   <path fillRule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM6.293 6.707a1 1 0 010-1.414l3-3a1 1 0 011.414 0l3 3a1 1 0 01-1.414 1.414L11 5.414V13a1 1 0 11-2 0V5.414L7.707 6.707a1 1 0 01-1.414 0z" clipRule="evenodd" />
                </svg>
                <span>Upload Image</span>
              </label>
            </div>
          )}
        </div>

        {/* Timeline Gallery */}
        {history.length > 0 && (
          <div className="w-full bg-slate-800/50 border border-slate-700 rounded-xl p-3 backdrop-blur-sm">
            <div className="text-xs font-semibold text-slate-500 uppercase mb-2 pl-1 flex justify-between">
               <span>History ({history.length})</span>
               {currentHistoryItem && (
                 <span className="text-slate-400 font-normal normal-case">
                   {new Date(currentHistoryItem.timestamp).toLocaleTimeString()} • {currentHistoryItem.source}
                 </span>
               )}
            </div>
            <div className="flex gap-3 overflow-x-auto pb-2 px-1 scrollbar-thin scrollbar-thumb-slate-600 scrollbar-track-transparent">
              {history.map((item, index) => (
                <button
                  key={item.id}
                  onClick={() => setCurrentIndex(index)}
                  className={`group relative shrink-0 w-24 h-24 rounded-lg overflow-hidden border-2 transition-all duration-200 ${
                    index === currentIndex 
                      ? 'border-blue-500 scale-105 shadow-lg shadow-blue-500/20 ring-2 ring-blue-500/20' 
                      : 'border-slate-700 opacity-60 hover:opacity-100 hover:border-slate-500'
                  }`}
                >
                  <img src={item.data} alt={`History ${index}`} className="w-full h-full object-cover" />
                  <div className={`absolute bottom-0 inset-x-0 bg-black/70 text-[10px] text-center py-1 truncate text-white/90 font-medium
                    ${index === currentIndex ? 'bg-blue-600/80' : ''}
                  `}>
                    {item.source}
                  </div>
                </button>
              ))}
              
              {/* Quick Upload Button in Timeline */}
              <label className="shrink-0 w-24 h-24 rounded-lg border-2 border-dashed border-slate-700 hover:border-slate-500 hover:bg-slate-800 transition-colors flex flex-col items-center justify-center cursor-pointer group opacity-60 hover:opacity-100">
                <input type="file" accept="image/*" onChange={handleFileUpload} className="hidden" />
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6 text-slate-500 group-hover:text-slate-300 mb-1">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
                <span className="text-[10px] text-slate-500 group-hover:text-slate-300 font-medium">Add New</span>
              </label>
            </div>
          </div>
        )}

        {/* Controls Area */}
        <div className="bg-slate-800 rounded-xl p-6 border border-slate-700 shadow-lg flex flex-col md:flex-row items-center gap-6">
          {/* Visualizer */}
          <div className="flex-grow flex flex-col gap-2 w-full md:w-auto">
             <div className="flex justify-between items-end">
               <span className="text-xs text-slate-500 font-mono">VOICE COMMAND</span>
               <Visualizer isActive={appState !== AppState.IDLE && appState !== AppState.ERROR} mode={appState === AppState.SPEAKING ? 'speaking' : 'listening'} />
             </div>
          </div>

          {/* Action Buttons */}
          <div className="flex items-center gap-4 shrink-0">
            {appState === AppState.IDLE || appState === AppState.ERROR ? (
              <button 
                onClick={startSession}
                className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white px-6 py-3 rounded-full font-bold transition-all shadow-lg shadow-blue-900/20 active:scale-95"
              >
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z" />
                </svg>
                Start Talking
              </button>
            ) : (
              <button 
                onClick={stopSession}
                className="flex items-center gap-2 bg-red-500 hover:bg-red-400 text-white px-6 py-3 rounded-full font-bold transition-all shadow-lg shadow-red-900/20 active:scale-95"
              >
                 <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25v13.5" />
                </svg>
                Stop Session
              </button>
            )}
          </div>
        </div>

        {/* Logs */}
        <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700/50">
           <h3 className="text-xs font-semibold text-slate-500 uppercase mb-2">Activity Log</h3>
           <div className="space-y-1 h-20 overflow-y-auto text-sm font-mono text-slate-400">
             {logs.length === 0 && <span className="opacity-50 italic">Ready to start...</span>}
             {logs.map((log, i) => (
               <div key={i} className="border-l-2 border-slate-600 pl-2 truncate">{log}</div>
             ))}
           </div>
        </div>
      </main>
    </div>
  );
};

export default App;