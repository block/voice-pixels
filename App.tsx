import React, { useState, useEffect, useRef } from 'react';
import { FunctionDeclaration, GoogleGenAI, LiveServerMessage, Modality, Type } from '@google/genai';
import { Visualizer } from './components/Visualizer';
import { generateImage, editImage } from './services/imageService';
import { segmentImage } from './services/segmentationService';
import { analyzeImageForContext } from './services/imageAnalysisService';
import { createPcmBlob, decodeAudioData } from './services/audioUtils';
import { initDB, saveHistoryItem, getSessionItems, getAllSessions, SessionSummary, saveSessionName, deleteSession } from './services/dbService';
import { generateSessionName } from './services/sessionNameService';
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

const segmentImageTool: FunctionDeclaration = {
  name: 'segment_image',
  description: 'Segments or cuts out specific objects from the currently visible image, creating transparent backgrounds or masks. Use this for object isolation, background removal, or creating cutouts.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      instruction: {
        type: Type.STRING,
        description: 'Detailed instruction describing what object(s) to segment/cut out from the image.'
      }
    },
    required: ['instruction']
  }
};

const selectImageTool: FunctionDeclaration = {
  name: 'select_image',
  description: 'Selects a specific image from the session timeline to view or use as reference. Images are numbered starting from 1 (first image).',
  parameters: {
    type: Type.OBJECT,
    properties: {
      position: {
        type: Type.STRING,
        description: 'Which image to select. Can be: a number (1 for first, 2 for second, etc.), "first", "last", "previous", or "next".'
      }
    },
    required: ['position']
  }
};

const downloadImageTool: FunctionDeclaration = {
  name: 'download_image',
  description: 'Downloads the currently visible image to the user\'s computer.',
  parameters: {
    type: Type.OBJECT,
    properties: {},
    required: []
  }
};

const App: React.FC = () => {
  // App State
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [hasApiKey, setHasApiKey] = useState<boolean>(false);
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [showLogs, setShowLogs] = useState<boolean>(false);
  const [showSessions, setShowSessions] = useState<boolean>(false);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingSessionName, setEditingSessionName] = useState<string>('');
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  
  // Session State
  const [sessionId, setSessionId] = useState<string>('');
  const [previousSessions, setPreviousSessions] = useState<SessionSummary[]>([]);
  const [sessionPrompts, setSessionPrompts] = useState<string[]>([]);
  
  // History State
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState<number>(-1);
  const [isLoadingImage, setIsLoadingImage] = useState(false);
  
  const [logs, setLogs] = useState<string[]>([]);
  
  // Ref for debouncing name generation
  const nameGenerationTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
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
  const imageContextRef = useRef<string | null>(null);
  const isProcessingToolRef = useRef<boolean>(false);
  const shouldSendAudioRef = useRef<boolean>(true);

  // Initialization
  useEffect(() => {
    const init = async () => {
      try {
        await initDB();
        // Generate new session ID
        const newSessionId = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString();
        setSessionId(newSessionId);
        
        // Check for API key
        const apiKey = localStorage.getItem('gemini_api_key');
        setHasApiKey(!!apiKey);
        
        // Set default models if not already set
        const savedGenerationModel = localStorage.getItem('gemini_generation_model');
        if (!savedGenerationModel) {
          localStorage.setItem('gemini_generation_model', 'imagen-3.0-generate-002');
        }
        
        const savedEditingModel = localStorage.getItem('gemini_editing_model');
        if (!savedEditingModel) {
          localStorage.setItem('gemini_editing_model', 'gemini-3-pro-image-preview');
        }
        
        // Load sessions
        loadSessions();
        addLog('✓ App initialized');
      } catch (error: any) {
        console.error("Initialization error:", error);
        addLog(`❌ Initialization error: ${error?.message || 'Unknown error'}`);
        setShowLogs(true);
      }
    };
    init();
  }, []);

  const loadSessions = async () => {
    try {
      const sessions = await getAllSessions();
      setPreviousSessions(sessions);
    } catch (error: any) {
      console.error("Failed to load sessions", error);
      addLog(`❌ Failed to load sessions: ${error?.message || 'Unknown error'}`);
    }
  };

  const handleSaveApiKey = (key: string) => {
    localStorage.setItem('gemini_api_key', key);
      setHasApiKey(true);
    setShowSettings(false);
  };

  const handleLoadSession = async (sid: string) => {
    try {
      setIsLoadingImage(true);
      const items = await getSessionItems(sid);
      setSessionId(sid);
      setHistory(items);
      setCurrentIndex(items.length - 1);
      
      // Extract prompts from loaded session
      const prompts = items.filter(item => item.prompt).map(item => item.prompt!);
      setSessionPrompts(prompts);
      
      addLog(`✓ Loaded session with ${items.length} items`);
      setShowSessions(false);
      setIsLoadingImage(false);
    } catch (error: any) {
      console.error("Failed to load session", error);
      addLog(`❌ Failed to load session: ${error?.message || 'Unknown error'}`);
      setIsLoadingImage(false);
      setShowLogs(true);
    }
  };

  const handleNewSession = () => {
    const newSessionId = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString();
    setSessionId(newSessionId);
    setHistory([]);
    setCurrentIndex(-1);
    setSessionPrompts([]);
    setShowSessions(false);
    loadSessions(); // Refresh the sessions list
  };

  const updateSessionName = (prompts: string[]) => {
    // Clear previous timeout
    if (nameGenerationTimeoutRef.current) {
      clearTimeout(nameGenerationTimeoutRef.current);
    }

    // Debounce: wait 3 seconds after last prompt before generating name
    nameGenerationTimeoutRef.current = setTimeout(async () => {
      try {
        const name = await generateSessionName(prompts);
        await saveSessionName(sessionId, name);
        addLog(`✓ Session named: "${name}"`);
        // Refresh sessions list to show updated name
        loadSessions();
      } catch (error: any) {
        console.error('Failed to update session name:', error);
        addLog(`❌ Failed to generate session name: ${error?.message || 'Unknown error'}`);
      }
    }, 3000);
  };

  const handleStartEditingSessionName = (session: SessionSummary) => {
    setEditingSessionId(session.sessionId);
    setEditingSessionName(session.name);
  };

  const handleSaveSessionName = async () => {
    if (editingSessionId && editingSessionName.trim()) {
      try {
        await saveSessionName(editingSessionId, editingSessionName.trim());
        addLog(`✓ Session renamed: "${editingSessionName.trim()}"`);
        setEditingSessionId(null);
        setEditingSessionName('');
        loadSessions();
      } catch (error: any) {
        console.error('Failed to save session name:', error);
        addLog(`❌ Failed to rename session: ${error?.message || 'Unknown error'}`);
        setShowLogs(true);
      }
    }
  };

  const handleCancelEditingSessionName = () => {
    setEditingSessionId(null);
    setEditingSessionName('');
  };

  const handleDeleteSession = async (sid: string) => {
    try {
      await deleteSession(sid);
      addLog(`✓ Session deleted`);
      
      // If we deleted the current session, start a new one
      if (sid === sessionId) {
        handleNewSession();
      }
      
      // Refresh sessions list
      loadSessions();
      setDeletingSessionId(null);
    } catch (error: any) {
      console.error('Failed to delete session:', error);
      addLog(`❌ Failed to delete session: ${error?.message || 'Unknown error'}`);
      setShowLogs(true);
      setDeletingSessionId(null);
    }
  };


  // Sync ref with state
  useEffect(() => {
    currentImageRef.current = currentHistoryItem?.data || null;
  }, [currentHistoryItem]);

  const addLog = (msg: string) => setLogs(prev => [...prev, msg].slice(-20));

  const addToHistory = async (data: string, source: 'upload' | 'generated' | 'edited', prompt?: string) => {
    const newItem: HistoryItem = {
      id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(),
      data,
      mimeType: 'image/png', 
      timestamp: Date.now(),
      source,
      sessionId,
      prompt
    };
    
    // Update UI
    setHistory(prev => {
      const newHistory = [...prev, newItem];
      setCurrentIndex(newHistory.length - 1);
      return newHistory;
    });

    // Persist to DB
    try {
      await saveHistoryItem(newItem);
      // Refresh sessions list just in case (though optimization would be to not do this every time)
      loadSessions(); 
    } catch (error: any) {
      console.error("Failed to save history item", error);
      addLog(`❌ Failed to save item: ${error?.message || 'Unknown error'}`);
      setShowLogs(true);
    }
  };

  const handleDownload = () => {
    if (!currentHistoryItem) return;
    
    const link = document.createElement('a');
    link.href = currentHistoryItem.data;
    const match = currentHistoryItem.data.match(/data:image\/(\w+);/);
    const ext = match ? match[1] : 'png';
    link.download = `voice-pixels-${currentHistoryItem.id}.${ext}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleToolCall = async (toolCall: any) => {
    // Prevent concurrent tool executions
    if (isProcessingToolRef.current) {
      console.log('Tool call skipped - already processing');
      return;
    }

    const functionCalls = toolCall.functionCalls;
    const responses = [];

    // Mute microphone during processing
    isProcessingToolRef.current = true;
    shouldSendAudioRef.current = false;
    setAppState(AppState.PROCESSING);
    addLog('🔇 Microphone muted during processing');

    for (const call of functionCalls) {
      console.log('Tool call received:', call.name, call.args);
      addLog(`Executing: ${call.name}`);
      
      try {
        if (call.name === 'generate_image') {
          setIsLoadingImage(true);
          const referenceImage = call.args.use_reference ? currentImageRef.current : undefined;
          const config = {
            aspectRatio: call.args.aspect_ratio,
            imageSize: call.args.image_size
          };
          const newImageData = await generateImage(call.args.prompt, referenceImage || undefined, config);
          
          await addToHistory(newImageData, 'generated', call.args.prompt);
          setIsLoadingImage(false);
          
          // Track prompt and update session name
          const updatedPrompts = [...sessionPrompts, call.args.prompt];
          setSessionPrompts(updatedPrompts);
          updateSessionName(updatedPrompts);
          
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
            
            await addToHistory(editedImageData, 'edited', call.args.instruction);
            setIsLoadingImage(false);
            
            // Track instruction and update session name
            const updatedPrompts = [...sessionPrompts, call.args.instruction];
            setSessionPrompts(updatedPrompts);
            updateSessionName(updatedPrompts);
            
            responses.push({
              id: call.id,
              name: call.name,
              response: { result: "Image edited successfully and added to timeline." }
            });
          }
        } else if (call.name === 'segment_image') {
          if (!currentImageRef.current) {
             responses.push({
              id: call.id,
              name: call.name,
              response: { result: "Error: No image is currently selected to segment. Ask user to upload or generate one first." }
            });
          } else {
            setIsLoadingImage(true);
            const segmentedImageData = await segmentImage(currentImageRef.current, call.args.instruction);
            
            await addToHistory(segmentedImageData, 'edited', call.args.instruction);
            setIsLoadingImage(false);
            
            // Track instruction and update session name
            const updatedPrompts = [...sessionPrompts, `Segment: ${call.args.instruction}`];
            setSessionPrompts(updatedPrompts);
            updateSessionName(updatedPrompts);
            
            responses.push({
              id: call.id,
              name: call.name,
              response: { result: "Image segmented successfully and added to timeline." }
            });
          }
        } else if (call.name === 'select_image') {
          const position = call.args.position.toLowerCase();
          let newIndex = currentIndex;
          
          if (position === 'first') {
            newIndex = 0;
          } else if (position === 'last') {
            newIndex = history.length - 1;
          } else if (position === 'previous') {
            newIndex = Math.max(0, currentIndex - 1);
          } else if (position === 'next') {
            newIndex = Math.min(history.length - 1, currentIndex + 1);
          } else {
            // Try to parse as number (1-based)
            const num = parseInt(position);
            if (!isNaN(num) && num >= 1 && num <= history.length) {
              newIndex = num - 1; // Convert to 0-based index
            }
          }
          
          setCurrentIndex(newIndex);
          const selectedItem = history[newIndex];
          const positionDesc = position === 'first' ? 'first' : position === 'last' ? 'last' : `#${newIndex + 1}`;
          
          responses.push({
            id: call.id,
            name: call.name,
            response: { result: `Selected ${positionDesc} image. ${selectedItem.prompt ? `This image was created with: "${selectedItem.prompt}"` : 'This is an uploaded image.'}` }
          });
        } else if (call.name === 'download_image') {
          handleDownload();
          
          responses.push({
            id: call.id,
            name: call.name,
            response: { result: "Image downloaded successfully." }
          });
        }
      } catch (error: any) {
        console.error("Tool Execution Error", error);
        const errorMessage = error.message || 'Unknown error';
        addLog(`❌ Error: ${errorMessage}`);
        setIsLoadingImage(false);
        responses.push({
          id: call.id,
          name: call.name,
          response: { result: `Error executing tool: ${errorMessage}` }
        });
      }
    }

    if (sessionPromiseRef.current && responses.length > 0) {
      try {
        const session = await sessionPromiseRef.current;
        session.sendToolResponse({ functionResponses: responses });
      } catch (e) {
        console.error("Failed to send tool response", e);
      }
    }

    // Unmute microphone after processing
    isProcessingToolRef.current = false;
    shouldSendAudioRef.current = true;
    setAppState(AppState.LISTENING);
    addLog('🔊 Microphone active');
  };

  const startSession = async () => {
    try {
      setAppState(AppState.LISTENING);
      const apiKey = localStorage.getItem('gemini_api_key');
      if (!apiKey) {
        throw new Error('API key not found');
      }
      
      // Analyze current image for context if one exists
      if (currentImageRef.current) {
        try {
          // Show processing overlay and mute during analysis
          setIsLoadingImage(true);
          isProcessingToolRef.current = true;
          shouldSendAudioRef.current = false;
          setAppState(AppState.PROCESSING);
          addLog('🔇 Analyzing uploaded image...');
          
          const description = await analyzeImageForContext(currentImageRef.current);
          imageContextRef.current = description;
          
          // Resume after analysis
          setIsLoadingImage(false);
          isProcessingToolRef.current = false;
          shouldSendAudioRef.current = true;
          addLog('✓ Image analyzed');
        } catch (error: any) {
          console.error('Failed to analyze image:', error);
          addLog(`⚠️ Could not analyze image: ${error?.message || 'Unknown error'}`);
          imageContextRef.current = null;
          // Resume even on error
          setIsLoadingImage(false);
          isProcessingToolRef.current = false;
          shouldSendAudioRef.current = true;
        }
      } else {
        imageContextRef.current = null;
      }
      
      const ai = new GoogleGenAI({ apiKey });
      
      // Reset processing flags
      isProcessingToolRef.current = false;
      shouldSendAudioRef.current = true;
      
      // Initialize Audio Contexts
      const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
      inputAudioContextRef.current = new AudioContext({ sampleRate: 16000 });
      outputAudioContextRef.current = new AudioContext({ sampleRate: 24000 });
      
      const inputCtx = inputAudioContextRef.current;
      const outputCtx = outputAudioContextRef.current;
      
      streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      const source = inputCtx.createMediaStreamSource(streamRef.current);
      
      const processor = inputCtx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;
      
      processor.onaudioprocess = (e) => {
        // Don't send audio if we're processing a tool call
        if (!shouldSendAudioRef.current) {
          return;
        }
        
        const inputData = e.inputBuffer.getChannelData(0);
        const pcmBlob = createPcmBlob(inputData);
        
        if (sessionPromiseRef.current) {
          sessionPromiseRef.current.then(session => {
             session.sendRealtimeInput({ media: pcmBlob });
          }).catch(err => {
            // Silently catch
          });
        }
      };
      
      source.connect(processor);
      
      const gainNode = inputCtx.createGain();
      gainNode.gain.value = 0;
      processor.connect(gainNode);
      gainNode.connect(inputCtx.destination);

      sessionPromiseRef.current = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        callbacks: {
          onopen: async () => {
            addLog("Connected to Voice Agent");
            setAppState(AppState.LISTENING);
            
            // Send image context if available
            if (imageContextRef.current) {
              try {
                const session = await sessionPromiseRef.current;
                const contextMessage = `I just uploaded an image. It shows: ${imageContextRef.current}. Can you greet me and ask what I'd like to do with it?`;
                
                session.sendClientContent({
                  turns: [{ role: 'user', parts: [{ text: contextMessage }] }],
                  turnComplete: true
                });
                
                addLog('✓ Image context sent to AI');
                addLog('🔊 Microphone active');
              } catch (error: any) {
                console.error('Failed to send image context:', error);
                addLog(`⚠️ Could not send context: ${error?.message || 'Unknown error'}`);
              }
            } else {
              addLog('🔊 Microphone active');
            }
          },
          onmessage: async (message: LiveServerMessage) => {
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
                if (sourcesRef.current.size === 0) setAppState(AppState.LISTENING);
              };
              sourceNode.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              sourcesRef.current.add(sourceNode);
            }

            if (message.toolCall) {
               await handleToolCall(message.toolCall);
            }
            
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
            console.error('Connection error:', err);
            const errorMsg = err?.message || err?.toString() || 'Unknown error';
            addLog(`❌ Connection Error: ${errorMsg}`);
            setAppState(AppState.ERROR);
            sessionPromiseRef.current = null;
            // Auto-show logs on error
            setShowLogs(true);
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }
          },
          systemInstruction: `You are a helpful visual design assistant.
          
          The user may provide image context at the start of the conversation if they have uploaded an image. Use this context to understand what they're working with.
          
          Capabilities:
          - You can generate high-quality images up to 4K resolution.
          - You can control aspect ratios (16:9, 1:1, 9:16, etc).
          - The default generation behavior is 16:9 and 1K resolution unless the user asks otherwise.
          
          Tools:
          1. 'generate_image': Creates a new image. Use 'use_reference=true' if the user wants to base the new image on the currently visible one.
          2. 'edit_image': Modifies the currently visible image (color changes, style adjustments, adding/removing elements).
          3. 'segment_image': Segments or cuts out specific objects from the image, removes backgrounds, creates masks, or isolates parts of an image with transparent backgrounds.
          
          When to use which tool:
          - Use 'edit_image' for general modifications like changing colors, styles, or adding/removing elements.
          - Use 'segment_image' when the user wants to cut out, isolate, remove backgrounds, or extract specific objects.
          
          When you use a tool, a new image will be added to the timeline.
          
          The user can also ask you to select different images from the session timeline or download images.
          
          Always confirm your actions. Be concise and friendly.`,
          tools: [{ functionDeclarations: [generateImageTool, editImageTool, segmentImageTool, selectImageTool, downloadImageTool] }]
        }
      });

    } catch (e: any) {
      console.error('Session start error:', e);
      const errorMsg = e?.message || e?.toString() || 'Failed to start session';
      addLog(`❌ Start Error: ${errorMsg}`);
      setAppState(AppState.ERROR);
      // Auto-show logs on error
      setShowLogs(true);
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
    
    // Reset processing flags
    isProcessingToolRef.current = false;
    shouldSendAudioRef.current = true;
    
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

  // --- RENDER HELPERS ---

  if (!hasApiKey) {
    return (
      <div className="min-h-screen bg-[#050505] text-white flex flex-col items-center justify-center p-8 font-sans">
        <div className="max-w-md w-full space-y-8 relative">
          {/* Background Glow */}
          <div className="absolute -top-20 -left-20 w-64 h-64 bg-blue-600/20 rounded-full blur-3xl pointer-events-none" />
          <div className="absolute -bottom-20 -right-20 w-64 h-64 bg-purple-600/20 rounded-full blur-3xl pointer-events-none" />

          <div className="relative bg-white/5 backdrop-blur-2xl border border-white/10 p-8 rounded-3xl shadow-2xl">
            <div className="flex flex-col items-center text-center mb-8">
              <div className="w-16 h-16 bg-gradient-to-tr from-blue-500 to-indigo-500 rounded-2xl flex items-center justify-center shadow-lg shadow-blue-500/20 mb-6">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-8 h-8 text-white">
                  <path fillRule="evenodd" d="M9.315 7.584C12.195 3.883 16.695 1.5 21.75 1.5a.75.75 0 0 1 .75.75c0 5.056-2.383 9.555-6.084 12.436h.008c.36.003.714.014 1.064.032a.75.75 0 0 1 .694.864 12.02 12.02 0 0 1-9.324 9.324.75.75 0 0 1-.864-.694 22.65 22.65 0 0 1-.032-1.064V22.5a.75.75 0 0 1-.75-.75c-2.881 0-5.438-.918-7.555-2.486l.445-.445a3 3 0 0 1 4.242 0l1.575 1.575a.75.75 0 0 1 0 1.06l-2.533 2.533a20.84 20.84 0 0 0 6.525 1.108c.08-.287.168-.572.262-.854l.84-2.52a2.25 2.25 0 0 1 2.848-1.424l2.52.84c.282.094.567.182.854.262A20.84 20.84 0 0 0 21.643 14.8l-2.533-2.533a.75.75 0 0 1 1.06-1.06l1.575 1.575a3 3 0 0 1 0 4.242l-.445.445C19.731 9.994 17.175 7.5 14.295 7.5h-.008a22.65 22.65 0 0 1-1.064-.032v-.008Zm-4.25 3.22a.75.75 0 0 0-1.5 0v.01c0 2.978.63 5.815 1.768 8.416l2.16-2.16a.75.75 0 0 1 1.06 1.06l-2.16 2.16A18.73 18.73 0 0 1 4.5 12v-.008a.75.75 0 0 0-.75-.75h-.005a.75.75 0 0 0-.745.75v.008c0 3.27.69 6.382 1.935 9.22l-1.62 1.62a.75.75 0 0 0 1.06 1.06l1.62-1.62a20.23 20.23 0 0 0 9.22 1.935h.008a.75.75 0 0 0 .75-.745v-.005a.75.75 0 0 0-.75-.75h-.008A18.73 18.73 0 0 1 12 20.25l2.16-2.16a.75.75 0 0 1 1.06 1.06l-2.16 2.16c2.601 1.138 5.438 1.768 8.416 1.768h.01a.75.75 0 0 0 0-1.5h-.01a18.73 18.73 0 0 1-8.356-1.972l2.085-2.085a.75.75 0 0 1 1.06 1.06l-2.085 2.085c2.36-1.12 4.504-2.67 6.32-4.56l-.45-.45a1.5 1.5 0 0 0-2.12 0l-1.575 1.575a.75.75 0 0 1-1.06-1.06l1.575-1.575a3 3 0 0 1 4.242 0l.45.45c1.89-1.816 3.44-3.96 4.56-6.32l-2.085 2.085a.75.75 0 0 1-1.06-1.06l2.085-2.085A18.73 18.73 0 0 1 21.75 12v.01a.75.75 0 0 0 1.5 0V12a20.23 20.23 0 0 0-1.935-9.22l1.62-1.62a.75.75 0 0 0-1.06-1.06l-1.62 1.62A20.23 20.23 0 0 0 12 1.5h-.008a.75.75 0 0 0-.75.75v.008ZM5.065 16.416c-1.138-2.601-1.768-5.438-1.768-8.416v-.01a.75.75 0 0 1 1.5 0v.01c0 2.723.57 5.324 1.618 7.71l-1.35 1.35a.75.75 0 0 1-1.06-1.06l1.35-1.35Z" clipRule="evenodd" />
            </svg>
          </div>
              <h1 className="text-3xl font-bold font-display mb-2 flex items-center gap-3 justify-center">
                <img src="/favicon.png" alt="Voice Pixels" className="w-10 h-10" />
                Voice Pixels <span className="text-blue-400">Pro</span>
              </h1>
              <p className="text-gray-400 text-sm">Enter your Gemini API key to begin creating.</p>
            </div>

            <form 
              onSubmit={(e) => {
                e.preventDefault();
                const input = e.currentTarget.elements.namedItem('apiKey') as HTMLInputElement;
                if (input.value.trim()) handleSaveApiKey(input.value.trim());
              }}
              className="space-y-4"
            >
              <div className="relative group">
                <div className="absolute -inset-0.5 bg-gradient-to-r from-blue-500 to-purple-600 rounded-xl opacity-50 group-focus-within:opacity-100 transition duration-500 blur-sm"></div>
                <input
                  type="password"
                  name="apiKey"
                  placeholder="Gemini API Key"
                  className="relative w-full bg-[#0A0A0A] text-white placeholder-gray-600 px-4 py-3.5 rounded-xl focus:outline-none focus:ring-0 border border-white/10"
                  required
                />
              </div>
          <button 
                type="submit"
                className="w-full bg-white text-black hover:bg-gray-200 py-3.5 rounded-xl font-bold transition-all active:scale-95 shadow-lg shadow-white/5"
          >
                Connect
          </button>
            </form>
            
            <div className="mt-6 text-center">
              <a href="https://ai.google.dev/gemini-api/docs/api-key" target="_blank" rel="noreferrer" className="text-xs text-gray-500 hover:text-white transition-colors underline decoration-gray-700 underline-offset-4">
                Get your API key
              </a>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen bg-[#050505] text-white flex flex-col overflow-hidden relative selection:bg-blue-500/30">
      
      {/* HEADER */}
      <header className="absolute top-0 left-0 right-0 z-20 p-6 pointer-events-none">
        <div className="flex justify-between items-start">
          {/* Left: Sessions Button */}
          <div className="pointer-events-auto flex-1">
            <button
              onClick={() => setShowSessions(true)}
              className="p-2.5 bg-black/20 hover:bg-white/10 border border-white/5 hover:border-white/20 rounded-full backdrop-blur-md transition-all text-gray-500 hover:text-white"
              title="History / Sessions"
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z" />
              </svg>
            </button>
          </div>

          {/* Center: Logo */}
          <div className="pointer-events-auto flex flex-col items-center flex-1">
            <h1 className="text-xl font-bold font-display tracking-tight flex items-center gap-2">
              <img src="/favicon.png" alt="Voice Pixels" className="w-6 h-6" />
              Voice Pixels 
              <span className="text-[10px] font-mono font-normal bg-white/10 px-1.5 py-0.5 rounded text-gray-300">BETA</span>
            </h1>
            <div className="flex items-center gap-2 mt-1">
              <div className={`w-1.5 h-1.5 rounded-full ${appState === AppState.IDLE ? 'bg-gray-500' : appState === AppState.ERROR ? 'bg-red-500' : 'bg-green-400 animate-pulse'}`} />
              <span className="text-[10px] font-mono uppercase text-gray-500 tracking-widest">{appState}</span>
            </div>
          </div>

          {/* Right: Logs + Settings */}
          <div className="pointer-events-auto flex gap-2 justify-end flex-1">
            <button
              onClick={() => setShowLogs(!showLogs)}
              className={`p-2.5 rounded-full backdrop-blur-md transition-all border ${showLogs ? 'bg-white/10 border-white/20 text-white' : 'bg-black/20 border-white/5 text-gray-500 hover:text-white'}`}
              title="Toggle Logs"
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
              </svg>
            </button>
            <button
              onClick={() => setShowSettings(true)}
              className="p-2.5 bg-black/20 hover:bg-white/10 border border-white/5 hover:border-white/20 rounded-full backdrop-blur-md transition-all text-gray-500 hover:text-white"
              title="Settings"
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
              </svg>
            </button>
              </div>
            </div>
      </header>
          
      {/* MAIN CANVAS */}
      <main className="flex-grow relative flex items-center justify-center p-4 md:p-10 lg:p-20">
        {/* Image Container */}
        <div className={`relative transition-all duration-700 ${currentHistoryItem ? 'opacity-100 scale-100' : 'opacity-50 scale-95'} max-w-full max-h-full flex flex-col items-center`}>
          {currentHistoryItem ? (
            <div className="relative group rounded-lg overflow-hidden shadow-2xl ring-1 ring-white/10">
              <img 
                src={currentHistoryItem.data} 
                alt="Generated Content" 
                className={`max-w-full max-h-[75vh] object-contain transition-all duration-300 ${isLoadingImage ? 'blur-sm' : ''}`}
              />
              
              {/* Processing Overlay (only on image) */}
              {isLoadingImage && (
                <div className="absolute inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center">
                  <div className="bg-black/80 border border-white/10 px-6 py-4 rounded-full flex items-center gap-4 shadow-xl">
                    <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '0s' }} />
                    <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }} />
                    <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }} />
                    <span className="font-mono text-xs tracking-widest text-blue-400 uppercase">Processing</span>
                  </div>
                </div>
              )}
              
              {/* Overlay Prompt */}
              {currentHistoryItem.prompt && !isLoadingImage && (
                <div className="absolute bottom-0 left-0 right-0 bg-black/60 backdrop-blur-md border-t border-white/10 p-4 transform translate-y-full group-hover:translate-y-0 transition-transform duration-300">
                  <p className="text-white/90 font-medium text-sm text-center font-display leading-relaxed">
                    "{currentHistoryItem.prompt}"
                  </p>
                </div>
              )}

              <div className="absolute top-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
              <button 
                 onClick={handleDownload}
                  className="p-2 bg-black/50 hover:bg-black/80 text-white rounded-lg backdrop-blur-sm border border-white/10"
               >
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
                  </svg>
              </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center text-gray-600 max-w-md">
              <label
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const file = e.dataTransfer.files?.[0];
                  if (file && file.type.startsWith('image/')) {
                    const reader = new FileReader();
                    reader.onloadend = () => {
                      addToHistory(reader.result as string, 'upload');
                    };
                    reader.readAsDataURL(file);
                  }
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                className="flex flex-col items-center cursor-pointer group w-full"
              >
                <input 
                  type="file" 
                  accept="image/*" 
                  onChange={handleFileUpload} 
                  className="hidden" 
                />
                <div className="w-32 h-32 border-2 border-dashed border-gray-800 group-hover:border-gray-600 rounded-2xl flex items-center justify-center mb-6 transition-all bg-white/5 group-hover:bg-white/10">
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1} stroke="currentColor" className="w-12 h-12 text-gray-700 group-hover:text-gray-500 transition-colors">
                  <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />
                </svg>
              </div>
                <p className="font-medium text-gray-400 group-hover:text-gray-300 transition-colors mb-1">Upload an image to start</p>
                <p className="font-mono text-xs text-gray-700 group-hover:text-gray-600 transition-colors">Click or drag & drop</p>
              </label>
              <div className="mt-6 text-center">
                <p className="text-sm text-gray-500">or press <span className="font-bold text-gray-400">Start</span> and ask me to generate one</p>
              </div>
            </div>
          )}
        </div>

        {/* Log Panel (Floating) */}
        {showLogs && (
           <div className="absolute top-20 right-6 w-80 bg-black/80 backdrop-blur-xl border border-white/10 rounded-xl p-4 shadow-2xl z-30 max-h-[calc(100vh-200px)] overflow-y-auto">
             <h3 className="text-[10px] font-mono uppercase text-gray-500 mb-3 sticky top-0 bg-transparent">System Logs</h3>
             <div className="space-y-1.5 font-mono text-[11px]">
               {logs.length === 0 && <span className="text-gray-700 italic">Waiting for activity...</span>}
               {logs.map((log, i) => (
                 <div key={i} className="text-gray-400 border-l border-gray-800 pl-2 py-0.5 leading-tight break-words">
                   {log}
            </div>
               ))}
             </div>
           </div>
        )}
      </main>

      {/* BOTTOM CONTROLS */}
      <div className="absolute bottom-8 left-1/2 -translate-x-1/2 z-30 w-full max-w-2xl px-4">
        <div className="bg-black/40 backdrop-blur-2xl border border-white/10 rounded-3xl p-2 flex items-center gap-4 shadow-2xl ring-1 ring-white/5">
          
          {/* Visualizer Area */}
          <div className="flex-1 h-12 bg-black/20 rounded-2xl overflow-hidden relative flex items-center justify-center group">
            {appState === AppState.PROCESSING ? (
              <span className="text-xs font-mono text-blue-400 group-hover:text-blue-300 transition-colors animate-pulse">🔇 PROCESSING...</span>
            ) : appState !== AppState.IDLE && appState !== AppState.ERROR ? (
              <Visualizer isActive={true} mode={appState === AppState.SPEAKING ? 'speaking' : 'listening'} />
            ) : (
              <span className="text-xs font-mono text-gray-600 group-hover:text-gray-500 transition-colors">READY TO INITIALIZE</span>
               )}
            </div>

          {/* Main Action Button */}
          {appState === AppState.IDLE || appState === AppState.ERROR ? (
            <button 
              onClick={startSession}
              className="h-12 px-8 bg-white hover:bg-gray-200 text-black rounded-2xl font-bold transition-all active:scale-95 flex items-center gap-2 shadow-[0_0_20px_-5px_rgba(255,255,255,0.3)] hover:shadow-[0_0_25px_-5px_rgba(255,255,255,0.5)]"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
                <path d="M8.25 4.5a3.75 3.75 0 1 1 7.5 0v8.25a3.75 3.75 0 1 1-7.5 0V4.5Z" />
                <path d="M6 10.5a.75.75 0 0 1 .75.75v1.5a5.25 5.25 0 1 0 10.5 0v-1.5a.75.75 0 0 1 1.5 0v1.5a6.751 6.751 0 0 1-6 6.709v2.291h3a.75.75 0 0 1 0 1.5h-7.5a.75.75 0 0 1 0-1.5h3v-2.291a6.751 6.751 0 0 1-6-6.709v-1.5A.75.75 0 0 1 6 10.5Z" />
              </svg>
              Start
            </button>
          ) : (
            <button 
              onClick={stopSession}
              className="h-12 px-8 bg-red-500/10 hover:bg-red-500/20 text-red-500 border border-red-500/20 rounded-2xl font-bold transition-all active:scale-95 flex items-center gap-2"
            >
               <div className="w-2 h-2 bg-red-500 rounded-sm" />
               Stop
            </button>
          )}
        </div>
      </div>

      {/* TIMELINE (Film Strip) */}
      {history.length > 0 && (
        <div className="absolute bottom-32 left-0 right-0 flex justify-center pointer-events-none">
          <div className="pointer-events-auto flex gap-2 p-2 bg-black/20 backdrop-blur-sm rounded-2xl border border-white/5 max-w-[90vw] overflow-x-auto scrollbar-hide">
             <label className="relative w-12 h-12 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 flex items-center justify-center cursor-pointer transition-colors shrink-0">
               <input type="file" accept="image/*" onChange={handleFileUpload} className="hidden" />
               <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5 text-gray-400">
                 <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
               </svg>
             </label>
              {history.map((item, index) => (
                <button
                  key={item.id}
                  onClick={() => setCurrentIndex(index)}
                className={`relative w-12 h-12 rounded-xl overflow-hidden border transition-all duration-300 shrink-0 ${
                    index === currentIndex 
                    ? 'border-white scale-105 shadow-lg shadow-white/20' 
                    : 'border-white/10 opacity-50 hover:opacity-100'
                }`}
              >
                <img src={item.data} alt="" className="w-full h-full object-cover" />
                </button>
              ))}
          </div>
        </div>
      )}

      {/* Sessions Drawer (Left Side) */}
      {showSessions && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex justify-start" onClick={() => setShowSessions(false)}>
          <div 
            className="h-full w-80 bg-[#0A0A0A] border-r border-white/10 p-6 overflow-y-auto shadow-2xl animate-in slide-in-from-left duration-300"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-lg font-bold font-display">Session History</h2>
              <button 
                onClick={() => setShowSessions(false)}
                className="text-gray-500 hover:text-white transition-colors"
              >
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            
            <button
              onClick={handleNewSession}
              className="w-full mb-4 p-3 bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20 text-white rounded-xl font-medium transition-all flex items-center justify-center gap-2 active:scale-95 group"
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5 text-gray-400 group-hover:text-white transition-colors">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
              New Session
            </button>
            
            <div className="space-y-3">
              {previousSessions.length === 0 && (
                <p className="text-gray-600 text-sm text-center py-8 italic">No previous sessions found</p>
              )}
              
              {previousSessions.map((session) => (
                <div
                  key={session.sessionId}
                  className={`w-full p-3 rounded-xl border transition-all relative overflow-hidden ${
                    session.sessionId === sessionId 
                      ? 'bg-blue-900/20 border-blue-500/50' 
                      : 'bg-white/5 border-white/5 hover:bg-white/10 hover:border-white/20'
                  }`}
                >
                  <div className="flex gap-3">
                    <button
                      onClick={() => handleLoadSession(session.sessionId)}
                      className="flex gap-3 flex-1 min-w-0 text-left group"
                    >
                      <div className="w-16 h-16 bg-black/50 rounded-lg overflow-hidden shrink-0">
                        {session.previewImage ? (
                          <img src={session.previewImage} alt="Preview" className="w-full h-full object-cover opacity-70 group-hover:opacity-100 transition-opacity" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-gray-700">
                             <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6">
                               <path fillRule="evenodd" d="M1.5 6a2.25 2.25 0 0 1 2.25-2.25h16.5A2.25 2.25 0 0 1 22.5 6v12a2.25 2.25 0 0 1-2.25 2.25H3.75A2.25 2.25 0 0 1 1.5 18V6ZM3 16.06V18c0 .414.336.75.75.75h16.5A.75.75 0 0 0 21 18v-1.94l-2.69-2.689a1.5 1.5 0 0 0-2.12 0l-.88.879.97.97a.75.75 0 1 1-1.06 1.06l-5.16-5.159a1.5 1.5 0 0 0-2.12 0L3 16.061Zm10.125-7.81a1.125 1.125 0 1 1 2.25 0 1.125 1.125 0 0 1-2.25 0Z" clipRule="evenodd" />
                             </svg>
            </div>
                        )}
          </div>
                      <div className="flex-1 min-w-0">
                        {editingSessionId === session.sessionId ? (
                          <div onClick={(e) => e.stopPropagation()}>
                            <input
                              type="text"
                              value={editingSessionName}
                              onChange={(e) => setEditingSessionName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') handleSaveSessionName();
                                if (e.key === 'Escape') handleCancelEditingSessionName();
                              }}
                              className="w-full bg-white/10 border border-white/20 text-white text-sm px-2 py-1 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                              autoFocus
                            />
                            <div className="flex gap-1 mt-1">
                              <button
                                onClick={handleSaveSessionName}
                                className="text-[10px] text-green-400 hover:text-green-300 font-mono"
                              >
                                SAVE
                              </button>
                              <button
                                onClick={handleCancelEditingSessionName}
                                className="text-[10px] text-gray-500 hover:text-gray-400 font-mono"
                              >
                                CANCEL
                              </button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <p className="text-sm font-medium text-gray-300 group-hover:text-white truncate">
                              {session.name}
                            </p>
                            <p className="text-xs text-gray-500 truncate">
                              {new Date(session.startTime).toLocaleDateString()} • {new Date(session.startTime).toLocaleTimeString()}
                            </p>
                            <div className="flex items-center gap-2 mt-2">
                              <span className="text-[10px] font-mono bg-white/10 px-1.5 rounded text-gray-400 group-hover:text-gray-300">
                                {session.itemCount} ITEMS
                              </span>
                              {session.sessionId === sessionId && (
                                <span className="text-[10px] font-mono text-blue-400">ACTIVE</span>
                              )}
             </div>
                          </>
                        )}
          </div>
                    </button>
                    {editingSessionId !== session.sessionId && (
                      <div className="flex gap-1 shrink-0">
              <button 
                          onClick={() => handleStartEditingSessionName(session)}
                          className="p-2 text-gray-500 hover:text-white transition-colors"
                          title="Edit name"
              >
                          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                            <path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10" />
                </svg>
              </button>
              <button 
                          onClick={() => setDeletingSessionId(session.sessionId)}
                          className="p-2 text-gray-500 hover:text-red-400 transition-colors"
                          title="Delete session"
              >
                          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
                            <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
                </svg>
              </button>
                      </div>
            )}
          </div>
        </div>
             ))}
           </div>
        </div>
          </div>
        )}

      {/* Delete Confirmation Modal */}
      {deletingSessionId && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 z-50">
          <div className="bg-[#0A0A0A] rounded-2xl p-6 max-w-sm w-full border border-red-500/20 shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-red-500/10 rounded-full flex items-center justify-center">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5 text-red-500">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
                </svg>
              </div>
              <h3 className="text-lg font-bold font-display">Delete Session?</h3>
            </div>
            <p className="text-gray-400 text-sm mb-6">
              This will permanently delete this session and all its images. This action cannot be undone.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setDeletingSessionId(null)}
                className="flex-1 bg-white/5 hover:bg-white/10 text-white py-2.5 rounded-xl font-medium transition-all text-sm"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDeleteSession(deletingSessionId)}
                className="flex-1 bg-red-500 hover:bg-red-400 text-white py-2.5 rounded-xl font-bold transition-all text-sm"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 z-50 animate-in fade-in duration-200">
          <div className="bg-[#0A0A0A] rounded-2xl p-6 max-w-md w-full border border-white/10 shadow-2xl relative overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-blue-500 to-purple-600" />
            
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-lg font-bold font-display">Settings</h2>
              <button 
                onClick={() => setShowSettings(false)}
                className="p-1 hover:bg-white/10 rounded-lg transition-colors text-gray-400 hover:text-white"
              >
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const input = e.currentTarget.elements.namedItem('apiKey') as HTMLInputElement;
                const generationModelSelect = e.currentTarget.elements.namedItem('generationModel') as HTMLSelectElement;
                const editingModelSelect = e.currentTarget.elements.namedItem('editingModel') as HTMLSelectElement;
                if (input.value.trim()) {
                  handleSaveApiKey(input.value.trim());
                  localStorage.setItem('gemini_generation_model', generationModelSelect.value);
                  localStorage.setItem('gemini_editing_model', editingModelSelect.value);
                }
              }}
              className="space-y-5"
            >
              <div>
                <label className="block text-xs font-mono uppercase text-gray-500 mb-2 tracking-wider">Gemini API Key</label>
                <input
                  type="password"
                  name="apiKey"
                  placeholder="Paste API Key"
                  defaultValue={localStorage.getItem('gemini_api_key') || ''}
                  className="w-full bg-white/5 border border-white/10 text-white px-4 py-3 rounded-xl focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 transition-all font-mono text-sm"
                  required
                />
              </div>
              
              <div>
                <label className="block text-xs font-mono uppercase text-gray-500 mb-2 tracking-wider">Generation Model</label>
                <select
                  name="generationModel"
                  defaultValue={localStorage.getItem('gemini_generation_model') || 'imagen-3.0-generate-002'}
                  className="w-full bg-white/5 border border-white/10 text-white px-4 py-3 rounded-xl focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 transition-all text-sm appearance-none cursor-pointer"
                >
                  <option value="imagen-3.0-generate-002">Imagen 3</option>
                  <option value="imagen-4.0-generate-preview-06-06">Imagen 4 (Latest)</option>
                  <option value="gemini-3-pro-image-preview">Gemini 3 Pro Image</option>
                  <option value="gemini-2.5-flash-image">Gemini 2.5 Flash Image</option>
                </select>
                <p className="text-[10px] text-gray-600 mt-2">For creating new images from prompts</p>
              </div>
              
              <div>
                <label className="block text-xs font-mono uppercase text-gray-500 mb-2 tracking-wider">Editing Model</label>
                <select
                  name="editingModel"
                  defaultValue={localStorage.getItem('gemini_editing_model') || 'gemini-3-pro-image-preview'}
                  className="w-full bg-white/5 border border-white/10 text-white px-4 py-3 rounded-xl focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 transition-all text-sm appearance-none cursor-pointer"
                >
                  <option value="gemini-3-pro-image-preview">Gemini 3 Pro Image</option>
                  <option value="gemini-2.5-flash-image">Gemini 2.5 Flash Image</option>
                  <option value="imagen-3.0-generate-002">Imagen 3</option>
                  <option value="imagen-4.0-generate-preview-06-06">Imagen 4</option>
                </select>
                <p className="text-[10px] text-gray-600 mt-2">For modifying existing images</p>
              </div>
              
              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowSettings(false)}
                  className="flex-1 bg-white/5 hover:bg-white/10 text-white py-2.5 rounded-xl font-medium transition-all text-sm"
                >
                  Cancel
                </button>
              <button 
                  type="submit"
                  className="flex-1 bg-white text-black hover:bg-gray-200 py-2.5 rounded-xl font-bold transition-all text-sm shadow-lg shadow-white/5"
                >
                  Save Changes
              </button>
              </div>
            </form>
            
            <div className="mt-6 pt-6 border-t border-white/5">
               <p className="text-xs text-gray-600 text-center">Voice Pixels Pro • v1.0.0</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;