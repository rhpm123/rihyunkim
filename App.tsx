
import React, { useState, useRef, useCallback, useEffect, ChangeEvent } from 'react';
import { GoogleGenAI } from '@google/genai';
import { Play, Download, Square, Settings, Upload, Image as ImageIcon, Trash2, Plus, Film, Monitor, MousePointer2, Layers, X, ChevronRight, ChevronDown, FolderOpen, Save, Loader2, CheckCircle, AlertCircle, Clipboard, Clock, FlaskConical } from 'lucide-react';
import { Project, Cut, Scene, GenerationStatus, CompositionState } from './types';

// Utility functions
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isRetryableError = (error: any) => {
  if (!error) return false;
  const msg = (typeof error === 'string' ? error : error.message) || '';
  return msg.includes('429') || msg.includes('Quota exceeded') || msg.includes('RESOURCE_EXHAUSTED');
};

// Toast Interface
interface Toast {
    id: number;
    message: string;
    type: 'info' | 'success' | 'error';
}

// --- Helper Component for Timer ---
const StatusTimer: React.FC<{ startTime: number }> = ({ startTime }) => {
    const [elapsed, setElapsed] = useState(0);

    useEffect(() => {
        const interval = setInterval(() => {
            setElapsed(Math.floor((Date.now() - startTime) / 1000));
        }, 1000);
        return () => clearInterval(interval);
    }, [startTime]);

    const formatTime = (sec: number) => {
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return `${m}:${s.toString().padStart(2, '0')}`;
    };

    return (
        <div className="flex items-center gap-1 text-xs font-mono bg-black/50 px-2 py-1 rounded text-zinc-300">
            <Clock size={12} />
            {formatTime(elapsed)}
        </div>
    );
};

const App: React.FC = () => {
  // --- State ---
  const [project, setProject] = useState<Project>({
    project_title: 'Untitled Project',
    default_settings: { resolution: '1080p', cut_duration_seconds: 5 },
    scenes: [],
    assets: [],
    global_prompts: {}
  });

  const [activeCutId, setActiveCutId] = useState<string | null>(null);
  const [isBatchGenerating, setIsBatchGenerating] = useState(false);
  const [qualityMode, setQualityMode] = useState(false); // false = Turbo, true = Quality
  const [isMockMode, setIsMockMode] = useState(false); // NEW: Test/Dev Mode
  const [globalProgress, setGlobalProgress] = useState(0);
  
  // UI State
  const [showImportModal, setShowImportModal] = useState(false);
  const [importJsonText, setImportJsonText] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [showImgGenModal, setShowImgGenModal] = useState(false);
  const [imgGenPrompt, setImgGenPrompt] = useState('');
  const [isImgGenLoading, setIsImgGenLoading] = useState(false);
  const [activeAssetTab, setActiveAssetTab] = useState<'background' | 'character'>('background');
  
  // Processed Character Preview (for White BG Removal)
  const [processedCharUrl, setProcessedCharUrl] = useState<string | null>(null);
  
  // Notifications
  const [toasts, setToasts] = useState<Toast[]>([]);

  // Theater Mode
  const [showTheater, setShowTheater] = useState(false);
  const [theaterCutIndex, setTheaterCutIndex] = useState(0);

  // Refs
  const abortControllerRef = useRef<AbortController | null>(null);
  const projectRef = useRef<Project>(project);
  const charImgRef = useRef<HTMLImageElement>(null); // For Direct DOM manipulation

  // Sync ref
  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  // Derived State
  const activeScene = project.scenes.find(s => s.cuts.some(c => c.cut_id === activeCutId));
  const activeCut = activeScene?.cuts.find(c => c.cut_id === activeCutId);
  const allCuts = project.scenes.flatMap(s => s.cuts);
  
  // --- Toast Helper ---
  const addToast = (message: string, type: 'info' | 'success' | 'error' = 'info') => {
      const id = Date.now();
      setToasts(prev => [...prev, { id, message, type }]);
      setTimeout(() => {
          setToasts(prev => prev.filter(t => t.id !== id));
      }, 3000);
  };

  // --- Helper: Update Project State ---
  const updateCutState = useCallback((cutId: string, updates: Partial<Cut>) => {
    setProject((prev) => {
      const newScenes = prev.scenes.map((scene) => ({
        ...scene,
        cuts: scene.cuts.map((cut) => {
           if (cut.cut_id === cutId) {
               if (updates.composition) {
                   return {
                       ...cut,
                       ...updates,
                       composition: {
                           ...cut.composition, 
                           ...updates.composition 
                       } as CompositionState
                   };
               }
               return { ...cut, ...updates };
           }
           return cut;
        }),
      }));
      return { ...prev, scenes: newScenes };
    });
  }, []);

  const addAsset = (assetDataUrl: string) => {
      if (!project.assets.includes(assetDataUrl)) {
          setProject(prev => ({
              ...prev,
              assets: [assetDataUrl, ...prev.assets]
          }));
      }
  };

  // --- WHITE BG REMOVAL PREVIEW ---
  // This effect runs pixel manipulation for the PREVIEW whenever the asset or flag changes.
  useEffect(() => {
      if (!activeCut?.composition?.character_asset) {
          setProcessedCharUrl(null);
          return;
      }
      
      const comp = activeCut.composition;
      if (!comp.remove_background) {
          setProcessedCharUrl(comp.character_asset || null);
          return;
      }

      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext('2d');
          if (!ctx) return;
          
          ctx.drawImage(img, 0, 0);
          const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const data = imgData.data;
          
          for(let i = 0; i < data.length; i += 4) {
             const r = data[i];
             const g = data[i+1];
             const b = data[i+2];
             // Threshold for white (improved)
             if (r > 240 && g > 240 && b > 240) {
                 data[i+3] = 0; 
             }
          }
          ctx.putImageData(imgData, 0, 0);
          setProcessedCharUrl(canvas.toDataURL());
      };
      img.src = comp.character_asset;
  }, [activeCut?.composition?.character_asset, activeCut?.composition?.remove_background]);


  // --- COMPOSITING LOGIC (Generation) ---
  const createCompositeImage = async (composition: CompositionState): Promise<string> => {
      const { background_asset, character_asset, character_scale, character_x, character_y, remove_background } = composition;
      
      if (!character_asset && background_asset) return background_asset;
      if (!background_asset) return '';

      return new Promise((resolve, reject) => {
          const canvas = document.createElement('canvas');
          canvas.width = 1920; 
          canvas.height = 1080;
          const ctx = canvas.getContext('2d');
          if (!ctx) { reject("No ctx"); return; }

          const bgImg = new Image();
          bgImg.crossOrigin = "anonymous";
          bgImg.onload = () => {
              ctx.drawImage(bgImg, 0, 0, canvas.width, canvas.height);

              if (character_asset) {
                  const charImg = new Image();
                  charImg.crossOrigin = "anonymous";
                  charImg.onload = () => {
                      // Logic matches CSS object-contain behavior EXACTLY for WYSIWYG
                      const safeW = canvas.width * 0.8;
                      const safeH = canvas.height * 0.8;
                      
                      const scaleX = safeW / charImg.width;
                      const scaleY = safeH / charImg.height;
                      
                      // Use the smaller scale factor to contain the image within the safe area (like CSS object-contain)
                      const fitScale = Math.min(scaleX, scaleY);
                      
                      // Apply user scale
                      const finalScale = fitScale * character_scale;

                      const finalW = charImg.width * finalScale;
                      const finalH = charImg.height * finalScale;

                      // Position logic (Center + Offset)
                      const centerX = canvas.width / 2;
                      const centerY = canvas.height / 2;
                      
                      // User coordinates are -1 to 1 based on 50% of container size
                      const posX = centerX + (character_x * (canvas.width / 2)) - (finalW / 2);
                      const posY = centerY + (character_y * (canvas.height / 2)) - (finalH / 2);

                      if (remove_background) {
                           const tempCanvas = document.createElement('canvas');
                           tempCanvas.width = finalW;
                           tempCanvas.height = finalH;
                           const tempCtx = tempCanvas.getContext('2d');
                           if (tempCtx) {
                               tempCtx.drawImage(charImg, 0, 0, finalW, finalH);
                               const imgData = tempCtx.getImageData(0, 0, finalW, finalH);
                               const data = imgData.data;
                               for(let i = 0; i < data.length; i += 4) {
                                   const r = data[i];
                                   const g = data[i+1];
                                   const b = data[i+2];
                                   if (r > 240 && g > 240 && b > 240) {
                                       data[i+3] = 0;
                                   }
                               }
                               tempCtx.putImageData(imgData, 0, 0);
                               ctx.drawImage(tempCanvas, posX, posY, finalW, finalH);
                           }
                      } else {
                          ctx.drawImage(charImg, posX, posY, finalW, finalH);
                      }
                      
                      resolve(canvas.toDataURL('image/jpeg', 0.95));
                  };
                  charImg.src = character_asset;
              } else {
                  resolve(canvas.toDataURL('image/jpeg', 0.95));
              }
          };
          bgImg.src = background_asset;
      });
  };

  // --- Cancel Logic ---
  const handleCancelGeneration = (cutId: string) => {
      updateCutState(cutId, { 
          status: 'idle', 
          progress: 0, 
          statusMessage: "Cancelled by user" 
      });
      addToast("Generation cancelled.", 'info');
  };

  // --- API: Generate Cut ---
  const generateCutVideo = async (cutId: string) => {
    try {
      if (window.aistudio && !isMockMode) {
        const hasKey = await window.aistudio.hasSelectedApiKey();
        if (!hasKey) {
          await window.aistudio.openSelectKey();
        }
      }

      // Fetch latest state immediately
      let currentProject = projectRef.current;
      let currentCut = currentProject.scenes.flatMap(s => s.cuts).find(c => c.cut_id === cutId);
      if (!currentCut) return;

      addToast(`Preparing request for ${cutId}...`, 'info');
      
      // Initialize state
      updateCutState(cutId, { 
          status: 'generating', 
          error: undefined, 
          progress: 5,
          startTime: Date.now(),
          statusMessage: "Initializing composition..."
      });

      // --- MOCK MODE: Bypass API for testing ---
      if (isMockMode) {
          addToast("🧪 Test Mode: Calculating Composition...", 'info');
          
          // Simulate Composition time
          await wait(500);
          updateCutState(cutId, { statusMessage: "🧪 Merging Layers (Canvas)...", progress: 30 });
          
          // Check cancel
          if (projectRef.current.scenes.flatMap(s=>s.cuts).find(c=>c.cut_id === cutId)?.status !== 'generating') return;

          // ACTUALLY RUN THE COMPOSITING LOGIC
          let finalImage = "";
          if (currentCut.composition && (currentCut.composition.background_asset || project.global_image)) {
               try {
                   finalImage = await createCompositeImage(currentCut.composition);
               } catch (e) {
                   console.error(e);
                   finalImage = "https://placehold.co/1920x1080?text=Compositing+Failed";
               }
          } else {
               finalImage = "https://placehold.co/1920x1080?text=No+Assets+Selected";
          }
          
          await wait(1000);
          if (projectRef.current.scenes.flatMap(s=>s.cuts).find(c=>c.cut_id === cutId)?.status !== 'generating') return;

          updateCutState(cutId, { statusMessage: "🧪 Finalizing Verification...", progress: 90 });
          await wait(500);

          updateCutState(cutId, { 
              status: 'completed', 
              videoUrl: finalImage, // Store the IMAGE as the videoUrl for verification
              progress: 100, 
              statusMessage: "Composite Verified (Static Image)" 
          });
          addToast("🧪 Composite Frame Generated!", 'success');
          return;
      }
      // -----------------------------------------

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

      let startImageBase64 = '';
      let mimeType = '';

      const comp = currentCut.composition;
      if (comp && comp.background_asset) {
           updateCutState(cutId, { statusMessage: "Compositing layers..." });
           const dataUrl = await createCompositeImage(comp);
           // Check cancel
           if (projectRef.current.scenes.flatMap(s=>s.cuts).find(c=>c.cut_id === cutId)?.status !== 'generating') return;

           const matches = dataUrl.match(/^data:(.+);base64,(.+)$/);
           if (matches) {
               mimeType = matches[1];
               startImageBase64 = matches[2];
           }
      } else if (project.global_image) {
          const matches = project.global_image.match(/^data:(.+);base64,(.+)$/);
          if (matches) {
            mimeType = matches[1];
            startImageBase64 = matches[2];
          }
      }

      const prompt = currentCut.prompts.action_prompt || "A cinematic scene.";
      const model = qualityMode ? 'veo-3.1-generate-preview' : 'veo-3.1-fast-generate-preview';
      
      let requestPayload: any = {
        model: model,
        prompt: prompt,
        config: {
            numberOfVideos: 1,
            resolution: '1080p',
            aspectRatio: '16:9'
        }
      };

      if (startImageBase64) {
          requestPayload.image = {
              imageBytes: startImageBase64,
              mimeType: mimeType
          };
      }

      updateCutState(cutId, { statusMessage: `Sending request to Veo (${qualityMode ? 'Quality' : 'Turbo'})...` });
      addToast(`Sending to Veo (${qualityMode ? 'Quality' : 'Turbo'})...`, 'info');
      
      // Check cancel
      if (projectRef.current.scenes.flatMap(s=>s.cuts).find(c=>c.cut_id === cutId)?.status !== 'generating') return;

      // --- RETRY LOOP FOR INITIAL GENERATION ---
      let operation: any = null;
      let genRetries = 0;
      let success = false;

      while (!success) {
          // Check cancel
          if (projectRef.current.scenes.flatMap(s=>s.cuts).find(c=>c.cut_id === cutId)?.status !== 'generating') return;

          try {
              operation = await ai.models.generateVideos(requestPayload);
              success = true; 
          } catch (err: any) {
              if (isRetryableError(err)) {
                  genRetries++;
                  const delay = Math.min(60000, 5000 * Math.pow(1.5, genRetries)); // Max 60s delay
                  let msg = `⏳ API Quota Full. Waiting... (${Math.round(delay/1000)}s)`;
                  if (genRetries > 3) {
                      msg = `⚠️ High Retry Count (#${genRetries}). Daily Quota (10/day) likely exhausted.`;
                  }
                  
                  updateCutState(cutId, { 
                      error: undefined, 
                      statusMessage: msg
                  });
                  await wait(delay);
              } else {
                  throw err; // Fatal error
              }
          }
      }

      updateCutState(cutId, { status: 'polling', progress: 20, statusMessage: "Server accepted. Rendering..." });
      addToast("Request sent! Polling for results...", 'info');

      const pollInterval = qualityMode ? 5000 : 1500;
      let retries = 0;

      while (!operation.done) {
        if (isBatchGenerating && abortControllerRef.current?.signal.aborted) {
            throw new Error("Batch cancelled");
        }
        await wait(pollInterval);
        
        // Check cancel & update progress
        const freshProject = projectRef.current;
        const freshCut = freshProject.scenes.flatMap(s => s.cuts).find(c => c.cut_id === cutId);
        
        if (!freshCut || freshCut.status !== 'polling') return; // Cancelled

        try {
            operation = await ai.operations.getVideosOperation({ operation });
            
            // Check if cancelled again after await
            if (projectRef.current.scenes.flatMap(s=>s.cuts).find(c=>c.cut_id === cutId)?.status !== 'polling') return;

            const currentProgress = freshCut?.progress || 20;
            
            updateCutState(cutId, { 
                progress: Math.min(95, currentProgress + (qualityMode ? 5 : 15)),
                statusMessage: `Rendering Video... ${freshCut?.progress}%`
            });
        } catch (e: any) {
            if (isRetryableError(e)) {
                const msg = `Polling Rate Limit. Pausing... (Retry #${retries+1})`;
                updateCutState(cutId, { statusMessage: msg });
                await wait(10000 * Math.pow(1.5, retries));
                retries++;
                continue;
            }
            throw e;
        }
      }

      const videoUri = operation.response?.generatedVideos?.[0]?.video?.uri;
      if (videoUri) {
          updateCutState(cutId, { statusMessage: "Downloading final video..." });
          const response = await fetch(`${videoUri}&key=${process.env.API_KEY}`);
          if (!response.ok) throw new Error("Failed to download video bytes");
          const blob = await response.blob();
          const videoUrl = URL.createObjectURL(blob);
          updateCutState(cutId, { status: 'completed', videoUrl, progress: 100, statusMessage: "Completed" });
          addToast(`${cutId} Generated Successfully!`, 'success');
      } else {
          throw new Error("No video URI returned");
      }

    } catch (error: any) {
       console.error(error);
       // If status is idle, it was cancelled, don't show error
       const currentStatus = projectRef.current.scenes.flatMap(s => s.cuts).find(c => c.cut_id === cutId)?.status;
       if (currentStatus === 'idle') return;

       if (isRetryableError(error)) {
           updateCutState(cutId, { status: 'error', error: "Rate limit exceeded. Try again in a moment.", statusMessage: "Failed: Rate Limit" });
           addToast("Rate limit exceeded.", 'error');
       } else {
           updateCutState(cutId, { status: 'error', error: error.message || 'Gen Error', statusMessage: `Failed: ${error.message}` });
           addToast("Generation failed.", 'error');
       }
    }
  };

  const generateBatch = async (cutsToGen: Cut[]) => {
      if (cutsToGen.length === 0) return;
      setIsBatchGenerating(true);
      abortControllerRef.current = new AbortController();
      setGlobalProgress(0);
      addToast(`Starting batch generation for ${cutsToGen.length} cuts.`, 'info');

      const total = cutsToGen.length;
      let completed = 0;

      for (const cut of cutsToGen) {
          if (abortControllerRef.current.signal.aborted) break;
          if (cut.status === 'completed') {
              completed++;
              continue;
          }
          let success = false;
          while (!success && !abortControllerRef.current.signal.aborted) {
             try {
                 await generateCutVideo(cut.cut_id);
                 const updatedCut = projectRef.current.scenes.flatMap(s=>s.cuts).find(c=>c.cut_id === cut.cut_id);
                 if (updatedCut?.status === 'completed') {
                     success = true;
                 } else if (updatedCut?.status === 'error' && updatedCut.error?.includes('429')) {
                     // In mock mode, we don't need long waits
                     const waitTime = isMockMode ? 1000 : 15000;
                     addToast(`Quota limit. Waiting ${waitTime/1000}s before retrying ${cut.cut_id}...`, 'error');
                     await wait(waitTime); 
                 } else {
                     break; 
                 }
             } catch (e) {
                 await wait(15000);
             }
          }
          completed++;
          setGlobalProgress((completed / total) * 100);
          await wait(2000);
      }
      setIsBatchGenerating(false);
      abortControllerRef.current = null;
      addToast("Batch generation completed!", 'success');
  };

  // --- Handlers ---
  const handleImportJson = async () => {
      try {
          let cleanJson = importJsonText.replace(/```json/g, '').replace(/```/g, '').trim();
          const data = JSON.parse(cleanJson);
          
          let adaptedProject: Project = {
              project_title: data.project_title || data.project_metadata?.title || "Imported Project",
              default_settings: { resolution: '1080p', cut_duration_seconds: 5 },
              scenes: [],
              assets: [],
              global_prompts: {}
          };

          if (data.reference_image_generation) {
             adaptedProject.global_prompts = data.reference_image_generation;
          }

          if (data.video_sequence_data) {
              const scene: Scene = {
                  scene_id: 'scene_1',
                  scene_title: 'Sequence 1',
                  cuts: data.video_sequence_data.map((item: any) => ({
                      cut_id: `cut_${item.cut_id}`,
                      time_code: item.time_code,
                      prompts: {
                          global_anchor: item.full_combined_prompt || item.master_composite_prompt || "",
                          start_state: (item.pre_roll_context && item.pre_roll_context !== "None") ? item.pre_roll_context : "",
                          action_prompt: item.action_instruction || item.action_only_prompt || ""
                      },
                      status: 'idle',
                      composition: { character_scale: 1, character_x: 0, character_y: 0, remove_background: false }
                  }))
              };
              adaptedProject.scenes.push(scene);
          } else if (data.scenes) {
              adaptedProject.scenes = data.scenes.map((s: any) => ({
                  ...s,
                  cuts: s.cuts.map((c: any) => ({
                      ...c,
                      status: 'idle',
                      composition: c.composition || { character_scale: 1, character_x: 0, character_y: 0, remove_background: false }
                  }))
              }));
          }

          setProject(prev => ({...adaptedProject, assets: prev.assets}));
          setShowImportModal(false);
          setImportError(null);
          if (adaptedProject.scenes.length > 0 && adaptedProject.scenes[0].cuts.length > 0) {
              setActiveCutId(adaptedProject.scenes[0].cuts[0].cut_id);
          }
          addToast("Project loaded successfully!", 'success');
      } catch (e) {
          setImportError("Invalid JSON format");
          addToast("Failed to import JSON", 'error');
      }
  };

  const handleGenerateImage = async () => {
    if (!imgGenPrompt) return;
    setIsImgGenLoading(true);
    addToast("Generating 4K Asset... This takes a few seconds.", 'info');
    try {
        if (window.aistudio && !isMockMode) {
            const hasKey = await window.aistudio.hasSelectedApiKey();
            if (!hasKey) await window.aistudio.openSelectKey();
        }
        
        // Mock Mode for Image Gen
        if (isMockMode) {
            await wait(2000);
            // Dummy image asset (Placehold.co)
            const dummyImg = "https://placehold.co/1920x1080/png?text=Mock+Asset";
            addAsset(dummyImg);
             if (activeAssetTab === 'background') {
                setProject(prev => ({...prev, global_image: dummyImg}));
            }
            addToast("🧪 Mock Asset Generated", 'success');
            setShowImgGenModal(false);
            setIsImgGenLoading(false);
            return;
        }

        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
        const response = await ai.models.generateContent({
            model: 'gemini-3-pro-image-preview',
            contents: { parts: [{ text: imgGenPrompt }] },
            config: {
                imageConfig: { aspectRatio: "16:9", imageSize: "4K" }
            }
        });
        
        let imgUrl = '';
        for (const part of response.candidates?.[0]?.content?.parts || []) {
            if (part.inlineData) {
                imgUrl = `data:image/png;base64,${part.inlineData.data}`;
                break;
            }
        }

        if (imgUrl) {
            addAsset(imgUrl);
            if (activeAssetTab === 'background') {
                setProject(prev => ({...prev, global_image: imgUrl}));
            }
            addToast("Asset generated and added to library.", 'success');
        }
        setShowImgGenModal(false);
    } catch (e: any) {
        addToast(`Image generation failed: ${e.message}`, 'error');
    } finally {
        setIsImgGenLoading(false);
    }
  };

  const handleFileUpload = (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
          const reader = new FileReader();
          reader.onload = (ev) => {
              const res = ev.target?.result as string;
              addAsset(res);
              addToast("File uploaded successfully", 'success');
          };
          reader.readAsDataURL(file);
      }
  };

  const handleGlobalUpload = (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
          const reader = new FileReader();
          reader.onload = (ev) => {
              const res = ev.target?.result as string;
              addAsset(res);
              setProject(prev => ({...prev, global_image: res}));
              addToast("Global Reference updated", 'success');
          };
          reader.readAsDataURL(file);
      }
  }

  // --- Interaction Handlers (Direct DOM Manipulation for Performance) ---
  const isDragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const startPos = useRef({ x: 0, y: 0 });

  const handleMonitorMouseDown = (e: React.MouseEvent) => {
      if (activeAssetTab !== 'character' || !activeCut?.composition?.character_asset) return;
      isDragging.current = true;
      dragStart.current = { x: e.clientX, y: e.clientY };
      startPos.current = { 
          x: activeCut.composition.character_x || 0, 
          y: activeCut.composition.character_y || 0 
      };
  };

  const handleMonitorMouseMove = (e: React.MouseEvent) => {
      if (!isDragging.current || !activeCut || !charImgRef.current) return;
      e.preventDefault();
      
      const container = e.currentTarget.getBoundingClientRect();
      const dxPixels = e.clientX - dragStart.current.x;
      const dyPixels = e.clientY - dragStart.current.y;

      const dx = dxPixels / (container.width / 2);
      const dy = dyPixels / (container.height / 2);

      const newX = startPos.current.x + dx;
      const newY = startPos.current.y + dy;
      
      // Update DOM directly for 60fps performance without re-render
      // We must match the transform logic used in render: translate(x*50%, y*50%) scale(s)
      const scale = activeCut.composition?.character_scale || 1;
      charImgRef.current.style.transform = `translate(${newX * 50}%, ${newY * 50}%) scale(${scale})`;
      
      // Store current values in a temp property on the ref to retrieve on mouse up
      (charImgRef.current as any)._tempX = newX;
      (charImgRef.current as any)._tempY = newY;
  };

  const handleMonitorMouseUp = () => { 
      if (isDragging.current && activeCut && charImgRef.current) {
          isDragging.current = false;
          // Commit to state
          const newX = (charImgRef.current as any)._tempX;
          const newY = (charImgRef.current as any)._tempY;
          if (newX !== undefined && newY !== undefined) {
              updateCutState(activeCut.cut_id, {
                  composition: {
                      ...activeCut.composition!,
                      character_x: newX,
                      character_y: newY
                  }
              });
          }
      }
  };

  const handleMonitorWheel = (e: React.WheelEvent) => {
      if (activeAssetTab !== 'character' || !activeCut?.composition?.character_asset) return;
      const delta = e.deltaY * -0.001;
      const newScale = Math.max(0.1, Math.min(5, (activeCut.composition!.character_scale || 1) + delta));
      updateCutState(activeCut.cut_id, {
          composition: { ...activeCut.composition!, character_scale: newScale }
      });
  };

  // List of prompt options for dropdown
  const allCutsForDropdown = React.useMemo(() => {
    const list = [];
    if (project.global_prompts) {
        Object.entries(project.global_prompts).forEach(([key, val]) => {
             if (typeof val === 'string' && val.length > 0) {
                 list.push({ label: `Master: ${key}`, value: val });
             } else if (typeof val === 'object') {
                 Object.entries(val).forEach(([subKey, subVal]) => {
                     if (typeof subVal === 'string') {
                         list.push({ label: `Master: ${key}.${subKey}`, value: subVal });
                     }
                 });
             }
        });
    }
    project.scenes.forEach(scene => {
      scene.cuts.forEach(cut => {
        const val = cut.prompts.global_anchor || cut.prompts.start_state;
        if (val) list.push({ label: `${scene.scene_title} - ${cut.time_code}`, value: val });
      });
    });
    return list;
  }, [project]);

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-200 overflow-hidden font-sans select-none" onMouseUp={handleMonitorMouseUp}>
      
      {/* --- Sidebar --- */}
      <aside className="w-80 flex flex-col border-r border-zinc-800 bg-zinc-900/50">
        <div className="p-4 border-b border-zinc-800 flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
                <Film className="w-5 h-5 text-white" />
            </div>
            <h1 className="font-bold text-lg tracking-tight">Veo 3.1 <span className="text-zinc-500 font-normal">Pro</span></h1>
        </div>

        {/* Global Ref */}
        <div className="p-4 border-b border-zinc-800">
            <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-zinc-500 uppercase">Global Reference</span>
                <div className="flex gap-1">
                    {/* RESTORED: Upload Button */}
                    <label className="p-1.5 hover:bg-zinc-800 rounded text-zinc-400 cursor-pointer">
                        <Upload size={14} />
                        <input type="file" onChange={handleGlobalUpload} className="hidden" />
                    </label>
                    <button onClick={() => setShowImgGenModal(true)} className="p-1.5 hover:bg-zinc-800 rounded text-blue-400"><ImageIcon size={14} /></button>
                    {project.global_image && (
                         <a href={project.global_image} download={`ref-${Date.now()}.png`} className="p-1.5 hover:bg-zinc-800 rounded text-green-400"><Download size={14} /></a>
                    )}
                </div>
            </div>
            <div className="aspect-video bg-zinc-950 rounded-lg border border-zinc-800 overflow-hidden relative group">
                {project.global_image ? (
                    <img src={project.global_image} className="w-full h-full object-cover" />
                ) : (
                    <div className="w-full h-full flex items-center justify-center text-zinc-700 text-xs">No Global Ref</div>
                )}
            </div>
        </div>

        {/* Scenes List */}
        <div className="flex-1 overflow-y-auto p-2">
            {project.scenes.map(scene => (
                <div key={scene.scene_id} className="mb-4">
                    <div className="flex items-center justify-between px-2 py-1 mb-1">
                         <span className="text-xs font-bold text-zinc-400 uppercase">{scene.scene_title}</span>
                         <button onClick={() => generateBatch(scene.cuts)} className="text-zinc-600 hover:text-blue-500"><Play size={12} /></button>
                    </div>
                    <div className="space-y-1">
                        {scene.cuts.map(cut => (
                            <div 
                                key={cut.cut_id}
                                onClick={() => setActiveCutId(cut.cut_id)}
                                className={`flex items-center gap-3 px-3 py-3 rounded-md cursor-pointer transition-colors border ${
                                    activeCutId === cut.cut_id ? 'bg-blue-900/20 border-blue-800' : 'hover:bg-zinc-800 border-transparent'
                                }`}
                            >
                                <div className={`w-2 h-2 rounded-full ${
                                    cut.status === 'completed' ? 'bg-green-500' :
                                    cut.status === 'generating' ? 'bg-amber-500 animate-pulse' :
                                    cut.status === 'polling' ? 'bg-amber-500 animate-pulse' :
                                    cut.status === 'error' ? 'bg-red-500' : 'bg-zinc-700'
                                }`} />
                                <div className="flex-1 min-w-0">
                                    <div className="flex justify-between items-center">
                                        <span className={`text-sm font-medium ${activeCutId === cut.cut_id ? 'text-blue-100' : 'text-zinc-300'}`}>{cut.cut_id}</span>
                                        <span className="text-xs text-zinc-600">{cut.time_code}</span>
                                    </div>
                                    <div className="text-xs text-zinc-500 truncate">{cut.prompts.action_prompt}</div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            ))}
        </div>
      </aside>

      {/* --- Main Content --- */}
      <main className="flex-1 flex flex-col min-w-0 relative">
        {/* Header */}
        <header className="h-16 border-b border-zinc-800 flex items-center justify-between px-6 bg-zinc-900/50">
            <div className="flex gap-4">
                <button onClick={() => setShowImportModal(true)} className="flex items-center gap-2 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded text-sm border border-zinc-700">
                    <FolderOpen size={16} /> <span>Import JSON</span>
                </button>
            </div>
            <div className="flex items-center gap-4">
                {isBatchGenerating && <div className="text-xs text-amber-400 animate-pulse">Batch Generating... {Math.round(globalProgress)}%</div>}
                
                {/* --- MOCK MODE TOGGLE --- */}
                <button 
                    onClick={() => setIsMockMode(!isMockMode)}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs font-bold border ${isMockMode ? 'bg-green-900/30 text-green-400 border-green-800' : 'bg-zinc-800 text-zinc-500 border-zinc-700'}`}
                >
                    <FlaskConical size={14} /> {isMockMode ? "Test Mode: ON" : "Test Mode: OFF"}
                </button>

                <div className="flex bg-zinc-800 rounded-lg p-1 border border-zinc-700">
                    <button onClick={()=>setQualityMode(false)} className={`px-3 py-1 text-xs rounded ${!qualityMode ? 'bg-zinc-600 text-white' : 'text-zinc-400'}`}>Turbo</button>
                    <button onClick={()=>setQualityMode(true)} className={`px-3 py-1 text-xs rounded ${qualityMode ? 'bg-purple-600 text-white' : 'text-zinc-400'}`}>Quality</button>
                </div>
                <button 
                    onClick={() => isBatchGenerating ? abortControllerRef.current?.abort() : generateBatch(allCuts)}
                    className={`flex items-center gap-2 px-4 py-2 rounded-md font-medium text-sm ${
                        isBatchGenerating ? 'bg-red-900/50 text-red-200 border border-red-800' : 'bg-blue-600 hover:bg-blue-500 text-white'
                    }`}
                >
                    {isBatchGenerating ? <><Square size={16} fill="currentColor" /> Stop</> : <><Play size={16} fill="currentColor" /> Generate All</>}
                </button>
                {allCuts.some(c => c.status === 'completed') && (
                     <button onClick={() => setShowTheater(true)} className="p-2 bg-zinc-800 rounded-md hover:bg-zinc-700"><Monitor size={18}/></button>
                )}
            </div>
        </header>

        {/* Viewport / Monitor */}
        <div className="flex-1 bg-zinc-950 flex flex-col relative overflow-hidden">
            {activeCut ? (
                <div className="flex-1 flex items-center justify-center p-8">
                     <div 
                        className="relative aspect-video w-full max-w-5xl bg-zinc-900 shadow-2xl overflow-hidden border border-zinc-800 group"
                        onMouseDown={handleMonitorMouseDown}
                        onMouseMove={handleMonitorMouseMove}
                        onWheel={handleMonitorWheel}
                     >
                        {/* 1. Background Layer */}
                        {(activeCut.composition?.background_asset || project.global_image) ? (
                            <img 
                                src={activeCut.composition?.background_asset || project.global_image} 
                                className="absolute inset-0 w-full h-full object-cover" 
                                alt="bg"
                            />
                        ) : (
                            <div className="absolute inset-0 flex items-center justify-center text-zinc-700">
                                No Background Set
                            </div>
                        )}

                        {/* 2. Character Layer */}
                        {activeCut.composition?.character_asset && (
                             <img 
                                ref={charImgRef}
                                src={processedCharUrl || activeCut.composition.character_asset}
                                className="absolute pointer-events-none transition-transform duration-75 origin-center will-change-transform"
                                style={{
                                    /* WYSIWYG PREVIEW - Matches canvas object-contain logic */
                                    width: '80%',
                                    height: '80%',
                                    objectFit: 'contain',
                                    left: '10%',
                                    top: '10%',
                                    transform: `translate(${activeCut.composition.character_x * 50}%, ${activeCut.composition.character_y * 50}%) scale(${activeCut.composition.character_scale})`
                                }}
                                alt="char"
                             />
                        )}

                        {/* 3. Generated Video Overlay OR Test Image Verification */}
                        {activeCut.videoUrl && (
                            activeCut.videoUrl.startsWith('data:image') ? (
                                <div className="absolute inset-0 z-20 bg-black flex items-center justify-center">
                                    <img src={activeCut.videoUrl} className="w-full h-full object-contain" alt="Test Result" />
                                    <div className="absolute bottom-4 right-4 bg-green-600 text-white px-3 py-1 text-xs font-bold rounded shadow-lg flex items-center gap-2">
                                        <CheckCircle size={14} /> TEST MODE: COMPOSITE VERIFIED
                                    </div>
                                </div>
                            ) : (
                                <video 
                                    src={activeCut.videoUrl} 
                                    className="absolute inset-0 w-full h-full object-cover z-20" 
                                    controls 
                                    autoPlay 
                                    loop 
                                />
                            )
                        )}

                        {/* Status Overlay */}
                        {!activeCut.videoUrl && (activeCut.status === 'generating' || activeCut.status === 'polling' || activeCut.status === 'error') && (
                            <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-30">
                                {activeCut.status === 'error' ? (
                                    <div className="bg-red-900/90 px-6 py-4 rounded-xl border border-red-700 shadow-2xl flex flex-col items-center gap-2">
                                        <AlertCircle size={32} className="text-red-200" />
                                        <div className="text-white font-bold">{activeCut.error || "Generation Failed"}</div>
                                        <div className="text-xs text-red-200">{activeCut.statusMessage}</div>
                                    </div>
                                ) : (
                                    <div className="bg-black/80 backdrop-blur-md px-6 py-5 rounded-xl border border-zinc-700 shadow-2xl flex flex-col gap-3 min-w-[250px]">
                                        <div className="flex items-center justify-between border-b border-zinc-700 pb-2 mb-1">
                                            <span className="text-blue-400 font-bold flex items-center gap-2">
                                                <Loader2 className="animate-spin" size={16} /> 
                                                {activeCut.status === 'generating' ? 'Initializing' : 'Processing'}
                                            </span>
                                            {activeCut.startTime && <StatusTimer startTime={activeCut.startTime} />}
                                        </div>
                                        
                                        <div className="text-sm text-zinc-200 font-medium">
                                            {activeCut.statusMessage || "Waiting for worker..."}
                                        </div>

                                        <div className="h-2 w-full bg-zinc-800 rounded-full overflow-hidden">
                                            <div 
                                                className="h-full bg-gradient-to-r from-blue-600 to-purple-600 transition-all duration-300"
                                                style={{ width: `${activeCut.progress || 5}%` }}
                                            />
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                        
                        {/* Drag Hint */}
                        {activeAssetTab === 'character' && activeCut.composition?.character_asset && (
                            <div className="absolute top-2 left-2 bg-black/50 text-[10px] px-2 py-1 rounded text-zinc-400 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity">
                                Drag to move • Scroll to scale
                            </div>
                        )}
                     </div>
                </div>
            ) : (
                <div className="flex-1 flex items-center justify-center text-zinc-600">Select a cut to edit</div>
            )}
        </div>

        {/* --- BIG GENERATE BUTTON --- */}
        {activeCut && (
             <div className="flex gap-2 w-full z-10">
                 {(activeCut.status === 'generating' || activeCut.status === 'polling') ? (
                     <button 
                        onClick={() => handleCancelGeneration(activeCut.cut_id)}
                        className="w-full h-14 bg-red-600 hover:bg-red-500 text-white font-bold text-lg flex items-center justify-center gap-2 shadow-xl"
                    >
                        <X size={24} /> Cancel Generation
                    </button>
                 ) : (
                     <button 
                        onClick={() => generateCutVideo(activeCut.cut_id)}
                        disabled={activeCut.status === 'error' && false} // Allow retry on error
                        className="w-full h-14 bg-blue-600 hover:bg-blue-500 text-white font-bold text-lg flex items-center justify-center gap-2 shadow-xl"
                    >
                        <Play fill="currentColor" /> Generate Cut {isMockMode && "(Test Mode)"}
                    </button>
                 )}
             </div>
        )}

        {/* --- Bottom Panel (Assets & Comp) --- */}
        <div className="h-72 bg-zinc-900 border-t border-zinc-800 flex flex-col">
            {activeCut ? (
                <>
                {/* Tabs & Controls */}
                <div className="h-12 border-b border-zinc-800 flex items-center justify-between px-4 bg-zinc-900">
                     <div className="flex gap-1 bg-zinc-950 p-1 rounded-lg">
                         <button onClick={() => setActiveAssetTab('background')} className={`px-4 py-1 text-xs rounded-md font-medium transition-colors ${activeAssetTab === 'background' ? 'bg-zinc-700 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}>Background</button>
                         <button onClick={() => setActiveAssetTab('character')} className={`px-4 py-1 text-xs rounded-md font-medium transition-colors ${activeAssetTab === 'character' ? 'bg-zinc-700 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}>Character</button>
                     </div>

                     {activeAssetTab === 'character' && activeCut.composition && (
                         <div className="flex items-center gap-6">
                             <div className="flex items-center gap-2">
                                 <span className="text-xs text-zinc-500 uppercase font-bold">Scale</span>
                                 <input 
                                    type="range" min="0.1" max="3" step="0.1"
                                    value={activeCut.composition.character_scale}
                                    onChange={(e) => updateCutState(activeCut.cut_id, { composition: { ...activeCut.composition!, character_scale: parseFloat(e.target.value) }})}
                                    className="w-24 accent-blue-500 h-1 bg-zinc-700 rounded-full appearance-none"
                                 />
                             </div>
                             <div className="flex items-center gap-2">
                                 <span className="text-xs text-zinc-500 uppercase font-bold">X</span>
                                 <input 
                                    type="range" min="-1" max="1" step="0.05"
                                    value={activeCut.composition.character_x}
                                    onChange={(e) => updateCutState(activeCut.cut_id, { composition: { ...activeCut.composition!, character_x: parseFloat(e.target.value) }})}
                                    className="w-24 accent-blue-500 h-1 bg-zinc-700 rounded-full appearance-none"
                                 />
                             </div>
                             <div className="flex items-center gap-2">
                                 <span className="text-xs text-zinc-500 uppercase font-bold">Y</span>
                                 <input 
                                    type="range" min="-1" max="1" step="0.05"
                                    value={activeCut.composition.character_y}
                                    onChange={(e) => updateCutState(activeCut.cut_id, { composition: { ...activeCut.composition!, character_y: parseFloat(e.target.value) }})}
                                    className="w-24 accent-blue-500 h-1 bg-zinc-700 rounded-full appearance-none"
                                 />
                             </div>
                             <div className="flex items-center gap-2 border-l border-zinc-800 pl-4">
                                 <label className="flex items-center gap-2 text-xs cursor-pointer">
                                     <input 
                                        type="checkbox"
                                        checked={activeCut.composition.remove_background}
                                        onChange={(e) => updateCutState(activeCut.cut_id, { composition: { ...activeCut.composition!, remove_background: e.target.checked }})}
                                     />
                                     Remove White BG
                                 </label>
                             </div>
                         </div>
                     )}
                </div>

                {/* Asset Grid */}
                <div className="flex-1 overflow-x-auto p-4">
                    <div className="flex gap-3 h-full">
                        <div className="min-w-[160px] h-full border border-dashed border-zinc-700 rounded-lg flex flex-col items-center justify-center hover:bg-zinc-800/50 transition-colors relative">
                            <Upload className="mb-2 text-zinc-500" size={24} />
                            <span className="text-xs text-zinc-500">Upload Asset</span>
                            <input type="file" onChange={handleFileUpload} className="absolute inset-0 opacity-0 cursor-pointer" />
                        </div>
                        {activeAssetTab === 'background' && project.global_image && (
                            <div 
                                onClick={() => updateCutState(activeCut.cut_id, { composition: { ...activeCut.composition!, background_asset: undefined }})} 
                                className={`min-w-[200px] h-full rounded-lg border-2 overflow-hidden relative cursor-pointer group ${!activeCut.composition?.background_asset ? 'border-blue-500' : 'border-zinc-800'}`}
                            >
                                <img src={project.global_image} className="w-full h-full object-cover opacity-50" />
                                <div className="absolute inset-0 flex items-center justify-center font-bold text-white z-10">Use Global</div>
                            </div>
                        )}
                         {activeAssetTab === 'character' && (
                            <div 
                                onClick={() => updateCutState(activeCut.cut_id, { composition: { ...activeCut.composition!, character_asset: undefined }})}
                                className={`min-w-[100px] h-full rounded-lg border-2 border-dashed border-zinc-700 flex items-center justify-center cursor-pointer hover:bg-red-900/10 ${!activeCut.composition?.character_asset ? 'border-blue-500' : ''}`}
                            >
                                <X className="text-zinc-500" />
                            </div>
                        )}
                        {project.assets.map((asset, idx) => {
                             const isSelected = activeAssetTab === 'background' ? activeCut.composition?.background_asset === asset : activeCut.composition?.character_asset === asset;
                             return (
                                <div 
                                    key={idx} 
                                    onClick={() => {
                                        if (activeAssetTab === 'background') {
                                            updateCutState(activeCut.cut_id, { composition: { ...activeCut.composition!, background_asset: asset }});
                                        } else {
                                            updateCutState(activeCut.cut_id, { composition: { ...activeCut.composition!, character_asset: asset }});
                                        }
                                    }}
                                    className={`min-w-[200px] bg-zinc-950 h-full rounded-lg border-2 overflow-hidden relative cursor-pointer group ${isSelected ? 'border-blue-500 shadow-lg shadow-blue-500/20' : 'border-zinc-800 hover:border-zinc-600'}`}
                                >
                                    <img src={asset} className="w-full h-full object-contain p-2" />
                                    {isSelected && <div className="absolute top-2 right-2 w-5 h-5 bg-blue-500 rounded-full flex items-center justify-center text-white text-[10px]">✓</div>}
                                </div>
                             )
                        })}
                    </div>
                </div>
                </>
            ) : (
                <div className="w-full h-full flex items-center justify-center text-zinc-700 uppercase font-bold tracking-widest text-sm">
                    Select a cut to edit
                </div>
            )}
        </div>
      </main>

      {/* --- Toast Container --- */}
      <div className="fixed bottom-6 right-6 flex flex-col gap-2 z-50">
          {toasts.map(toast => (
              <div key={toast.id} className={`px-4 py-3 rounded-lg shadow-xl border flex items-center gap-2 animate-in slide-in-from-right-10 fade-in duration-300 ${
                  toast.type === 'error' ? 'bg-red-900/90 border-red-700 text-white' : 
                  toast.type === 'success' ? 'bg-green-900/90 border-green-700 text-white' : 
                  'bg-zinc-800/90 border-zinc-700 text-zinc-100'
              }`}>
                  {toast.type === 'error' ? <AlertCircle size={18}/> : toast.type === 'success' ? <CheckCircle size={18}/> : <Loader2 size={18} className="animate-spin"/>}
                  <span className="text-sm font-medium">{toast.message}</span>
              </div>
          ))}
      </div>

      {/* --- Import Modal --- */}
      {showImportModal && (
          <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
              <div className="bg-zinc-900 w-full max-w-2xl rounded-xl border border-zinc-800 shadow-2xl flex flex-col max-h-[90vh]">
                  <div className="p-4 border-b border-zinc-800 flex justify-between items-center">
                      <h2 className="text-lg font-bold">Import Project JSON</h2>
                      <button onClick={() => setShowImportModal(false)} className="text-zinc-500 hover:text-white"><X size={20}/></button>
                  </div>
                  <div className="p-4 flex-1 overflow-hidden flex flex-col gap-4">
                      <div className="bg-zinc-950 p-4 rounded-lg border border-zinc-800 text-sm text-zinc-400">
                          Paste your script JSON or upload a file. The app will automatically adapt different JSON formats.
                      </div>
                      <textarea 
                        className="w-full h-64 bg-zinc-950 border border-zinc-800 rounded-lg p-3 text-xs font-mono text-zinc-300 focus:outline-none focus:border-blue-600 resize-none"
                        placeholder='Paste JSON here...'
                        value={importJsonText}
                        onChange={(e) => setImportJsonText(e.target.value)}
                      />
                      {importError && <div className="text-red-400 text-sm flex items-center gap-2"><AlertCircle size={14}/> {importError}</div>}
                  </div>
                  <div className="p-4 border-t border-zinc-800 flex justify-end gap-3">
                       <button onClick={() => setImportJsonText('')} className="px-4 py-2 text-zinc-400 hover:text-white text-sm">Clear</button>
                       <button onClick={handleImportJson} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-md text-sm font-medium">Load Project</button>
                  </div>
              </div>
          </div>
      )}

      {/* --- Image Generation Modal --- */}
      {showImgGenModal && (
          <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
              <div className="bg-zinc-900 w-full max-w-lg rounded-xl border border-zinc-800 shadow-2xl relative overflow-hidden">
                  {isImgGenLoading && (
                      <div className="absolute inset-0 bg-black/60 z-10 flex flex-col items-center justify-center text-blue-400 gap-3 backdrop-blur-sm">
                          <Loader2 size={48} className="animate-spin" />
                          <span className="font-bold animate-pulse">Creating 4K Asset...</span>
                      </div>
                  )}
                  <div className="p-4 border-b border-zinc-800 flex justify-between items-center">
                      <h2 className="text-lg font-bold">Generate 4K Asset</h2>
                      <button onClick={() => setShowImgGenModal(false)} className="text-zinc-500 hover:text-white"><X size={20}/></button>
                  </div>
                  <div className="p-4 flex flex-col gap-4">
                      <div className="space-y-1">
                          <label className="text-xs font-bold text-zinc-500 uppercase">Load Prompt From Cut</label>
                          <div className="relative">
                            <select 
                                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg py-2 px-3 text-sm appearance-none focus:outline-none focus:border-blue-600"
                                onChange={(e) => setImgGenPrompt(e.target.value)}
                            >
                                <option value="">Select a source cut...</option>
                                {allCutsForDropdown.map((opt, i) => (
                                    <option key={i} value={opt.value}>{opt.label}</option>
                                ))}
                            </select>
                            <ChevronDown className="absolute right-3 top-2.5 text-zinc-500 pointer-events-none" size={14} />
                          </div>
                      </div>
                      <div className="space-y-1">
                          <label className="text-xs font-bold text-zinc-500 uppercase">Prompt</label>
                          <textarea 
                            className="w-full h-32 bg-zinc-950 border border-zinc-800 rounded-lg p-3 text-sm text-zinc-300 focus:outline-none focus:border-blue-600 resize-none"
                            placeholder="Describe the image..."
                            value={imgGenPrompt}
                            onChange={(e) => setImgGenPrompt(e.target.value)}
                          />
                      </div>
                      <div className="bg-zinc-950 p-3 rounded text-xs text-zinc-500 border border-zinc-800">
                          <strong>Model:</strong> gemini-3-pro-image-preview (Nano Banana Pro) <br/>
                          <strong>Res:</strong> 4K (16:9)
                      </div>
                  </div>
                  <div className="p-4 border-t border-zinc-800 flex justify-end gap-3">
                       <button onClick={() => setShowImgGenModal(false)} className="px-4 py-2 text-zinc-400 hover:text-white text-sm">Cancel</button>
                       <button onClick={handleGenerateImage} className="px-6 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-md text-sm font-medium flex items-center gap-2">
                           <ImageIcon size={16} /> Generate {isMockMode && "(Test)"}
                       </button>
                  </div>
              </div>
          </div>
      )}

      {/* --- Theater Mode --- */}
      {showTheater && (
          <div className="fixed inset-0 bg-black z-[100] flex flex-col">
              <div className="h-16 flex items-center justify-between px-8 absolute top-0 w-full z-10 bg-gradient-to-b from-black/80 to-transparent">
                   <h2 className="text-xl font-bold text-white tracking-widest">THEATER MODE</h2>
                   <button onClick={() => setShowTheater(false)} className="text-white/70 hover:text-white"><X size={32}/></button>
              </div>
              <div className="flex-1 flex items-center justify-center bg-black">
                  {allCuts[theaterCutIndex]?.videoUrl ? (
                       <video 
                         src={allCuts[theaterCutIndex].videoUrl} 
                         className="max-w-full max-h-full aspect-video" 
                         controls 
                         autoPlay 
                         onEnded={() => {
                             if (theaterCutIndex < allCuts.length - 1) {
                                 setTheaterCutIndex(prev => prev + 1);
                             }
                         }}
                       />
                  ) : (
                      <div className="text-zinc-500">Cut {theaterCutIndex + 1} not generated yet</div>
                  )}
              </div>
              <div className="h-24 bg-zinc-900/90 border-t border-zinc-800 flex items-center gap-4 px-8 overflow-x-auto">
                   {allCuts.map((cut, i) => (
                       <div 
                         key={cut.cut_id} 
                         onClick={() => setTheaterCutIndex(i)}
                         className={`min-w-[100px] h-16 rounded border-2 cursor-pointer relative overflow-hidden ${theaterCutIndex === i ? 'border-blue-500' : 'border-zinc-700 opacity-50 hover:opacity-100'}`}
                       >
                           {cut.videoUrl ? (
                               <video src={cut.videoUrl} className="w-full h-full object-cover" />
                           ) : (
                               <div className="w-full h-full bg-zinc-800 flex items-center justify-center text-xs text-zinc-500">Pending</div>
                           )}
                           <div className="absolute bottom-0 left-0 bg-black/60 px-1 text-[10px] text-white">{cut.cut_id}</div>
                       </div>
                   ))}
              </div>
          </div>
      )}

    </div>
  );
};

export default App;
