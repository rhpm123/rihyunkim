
import React, { useState, useRef, useCallback, useEffect, ChangeEvent } from 'react';
import { GoogleGenAI } from '@google/genai';
import { Play, Download, Square, Settings, Upload, Image as ImageIcon, Trash2, Plus, Film, Monitor, MousePointer2, Layers, X, ChevronRight, ChevronDown, FolderOpen, Save, Loader2, CheckCircle, AlertCircle, Clipboard, Clock, FlaskConical, RefreshCw, Copy, Palette, RotateCcw, CheckSquare, ListChecks, Lock, History as HistoryIcon, Rewind } from 'lucide-react';
import { Project, Cut, Scene, GenerationStatus, CompositionState, CompositionPreset, GeneratedAsset } from './types';

// --- IndexedDB Helpers for Persistence ---
const DB_NAME = 'VeoDirectorDB';
const STORE_NAME = 'project_store';

const initDB = () => {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

const saveProjectToDB = async (project: Project) => {
  try {
    const db = await initDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(project, 'current_project');
  } catch (e) {
    console.error("Failed to save to DB", e);
  }
};

const loadProjectFromDB = async (): Promise<Project | undefined> => {
  try {
    const db = await initDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).get('current_project');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(undefined);
    });
  } catch (e) {
    console.error("Failed to load from DB", e);
    return undefined;
  }
};

const clearProjectDB = async () => {
    try {
        const db = await initDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete('current_project');
    } catch (e) { console.error(e); }
};

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
    global_prompts: {},
    compositionPresets: []
  });

  const [activeCutId, setActiveCutId] = useState<string | null>(null);
  const [isBatchGenerating, setIsBatchGenerating] = useState(false);
  const [qualityMode, setQualityMode] = useState(false); // false = Turbo, true = Quality
  const [strictMode, setStrictMode] = useState(true); // Enforce visual consistency
  const [isMockMode, setIsMockMode] = useState(false); // Test/Dev Mode
  const [globalProgress, setGlobalProgress] = useState(0);
  const [isHydrated, setIsHydrated] = useState(false); // DB Load status
  
  // UI State
  const [showImportModal, setShowImportModal] = useState(false);
  const [importJsonText, setImportJsonText] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [showImgGenModal, setShowImgGenModal] = useState(false);
  const [imgGenPrompt, setImgGenPrompt] = useState('');
  const [imgGenGreenScreen, setImgGenGreenScreen] = useState(false);
  
  // Dual Reference Images for Generation
  const [imgGenBgRef, setImgGenBgRef] = useState<string | null>(null); 
  const [imgGenCharRef, setImgGenCharRef] = useState<string | null>(null);

  const [isImgGenLoading, setIsImgGenLoading] = useState(false);
  const [imgGenMode, setImgGenMode] = useState<'custom' | 'batch'>('custom');
  const [batchSelectedCuts, setBatchSelectedCuts] = useState<string[]>([]);
  const [batchImgGenProgress, setBatchImgGenProgress] = useState<{current: number, total: number} | null>(null);

  const [activeAssetTab, setActiveAssetTab] = useState<'background' | 'character' | 'history'>('background');
  
  // Video Batch Selection State
  const [isVideoBatchMode, setIsVideoBatchMode] = useState(false);
  const [videoBatchSelection, setVideoBatchSelection] = useState<string[]>([]);

  // Processed Character Preview (for Chroma Key)
  const [processedCharUrl, setProcessedCharUrl] = useState<string | null>(null);
  
  // Notifications
  const [toasts, setToasts] = useState<Toast[]>([]);

  // Theater Mode
  const [showTheater, setShowTheater] = useState(false);
  const [theaterCutIndex, setTheaterCutIndex] = useState(0);

  // Refs
  const abortControllerRef = useRef<AbortController | null>(null);
  const imgGenAbortControllerRef = useRef<AbortController | null>(null);
  const projectRef = useRef<Project>(project);
  const charImgRef = useRef<HTMLImageElement>(null); // For Direct DOM manipulation
  const generatingLocks = useRef(new Set<string>()); // Prevent double-clicks

  // Sync ref
  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  // --- Persistence Effects ---
  // 1. Load on mount
  useEffect(() => {
      const load = async () => {
          const saved = await loadProjectFromDB();
          if (saved) {
              // Migration for presets and chroma key
              if (!saved.compositionPresets) saved.compositionPresets = [];
              saved.scenes.forEach(s => s.cuts.forEach(c => {
                  if (c.composition && 'remove_background' in c.composition) {
                      // @ts-ignore
                      c.composition.chroma_key = c.composition.remove_background ? 'white' : 'none';
                      // @ts-ignore
                      delete c.composition.remove_background;
                  }
                  if (!c.composition?.chroma_key) {
                      if (c.composition) c.composition.chroma_key = 'none';
                  }
                  if (!c.history) c.history = [];
              }));

              setProject(saved);
              addToast("Project restored from storage", 'success');
              if (saved.scenes.length > 0 && saved.scenes[0].cuts.length > 0) {
                  setActiveCutId(saved.scenes[0].cuts[0].cut_id);
              }
          }
          setIsHydrated(true);
      };
      load();
  }, []);

  // 2. Save on change (only if hydrated to avoid overwriting with empty state)
  useEffect(() => {
      if (isHydrated) {
          saveProjectToDB(project);
      }
  }, [project, isHydrated]);

  // Derived State
  const activeScene = project.scenes.find(s => s.cuts.some(c => c.cut_id === activeCutId));
  const activeCut = activeScene?.cuts.find(c => c.cut_id === activeCutId);
  const allCuts = project.scenes.flatMap(s => s.cuts);
  
  // --- Toast Helper (Fixed) ---
  const addToast = useCallback((message: string, type: 'info' | 'success' | 'error' = 'info') => {
      const id = Date.now() + Math.random();
      setToasts(prev => {
          if (prev.some(t => t.message === message)) return prev;
          return [...prev, { id, message, type }];
      });
      // setTimeout must be outside the setState updater
      setTimeout(() => {
          setToasts(current => current.filter(t => t.id !== id));
      }, 3000);
  }, []);

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

  // --- Preset Logic ---
  const handleSavePreset = () => {
      if (!activeCut?.composition) return;
      const name = `Layout ${project.compositionPresets.length + 1}`;
      const newPreset: CompositionPreset = {
          id: Date.now().toString(),
          name,
          data: JSON.parse(JSON.stringify(activeCut.composition)) // Deep copy
      };
      setProject(prev => ({
          ...prev,
          compositionPresets: [...prev.compositionPresets, newPreset]
      }));
      addToast("Current layout saved as preset!", 'success');
  };

  const handleApplyPreset = (preset: CompositionPreset) => {
      if (!activeCutId) return;
      updateCutState(activeCutId, { composition: JSON.parse(JSON.stringify(preset.data)) });
      addToast(`Applied preset: ${preset.name}`, 'info');
  };

  const handleDeletePreset = (id: string, e: React.MouseEvent) => {
      e.stopPropagation();
      setProject(prev => ({
          ...prev,
          compositionPresets: prev.compositionPresets.filter(p => p.id !== id)
      }));
  };

  // --- History Restoration ---
  const handleRestoreHistory = (item: GeneratedAsset) => {
      if (!activeCutId) return;
      if (item.type === 'video') {
          updateCutState(activeCutId, { 
              status: 'completed',
              videoUrl: item.url,
              progress: 100,
              statusMessage: 'Restored from history'
          });
          addToast("Video restored from history", 'success');
      } else {
          // Image restore -> background
          updateCutState(activeCutId, {
              composition: { ...activeCut?.composition!, background_asset: item.url }
          });
          addToast("Background restored from history", 'success');
      }
  };

  // --- CHROMA KEY PREVIEW (White/Green) ---
  useEffect(() => {
      if (!activeCut?.composition?.character_asset) {
          setProcessedCharUrl(null);
          return;
      }
      
      const comp = activeCut.composition;
      if (comp.chroma_key === 'none') {
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

             if (comp.chroma_key === 'white') {
                 // Remove White
                 if (r > 240 && g > 240 && b > 240) {
                     data[i+3] = 0; 
                 }
             } else if (comp.chroma_key === 'green') {
                 // Remove Green (Simple Chroma Key)
                 if (g > r + 40 && g > b + 40) {
                     data[i+3] = 0;
                 }
             }
          }
          ctx.putImageData(imgData, 0, 0);
          setProcessedCharUrl(canvas.toDataURL());
      };
      img.src = comp.character_asset;
  }, [activeCut?.composition?.character_asset, activeCut?.composition?.chroma_key]);


  // --- COMPOSITING LOGIC (Generation) ---
  const createCompositeImage = async (composition: CompositionState, globalImage?: string): Promise<string> => {
      const { background_asset, character_asset, character_scale, character_x, character_y, chroma_key } = composition;
      
      const bgSrc = background_asset || globalImage;
      if (!bgSrc) return '';
      if (!character_asset && bgSrc) return bgSrc;

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
                      const safeW = canvas.width * 0.8;
                      const safeH = canvas.height * 0.8;
                      
                      const scaleX = safeW / charImg.width;
                      const scaleY = safeH / charImg.height;
                      
                      const fitScale = Math.min(scaleX, scaleY);
                      const finalScale = fitScale * character_scale;

                      const finalW = charImg.width * finalScale;
                      const finalH = charImg.height * finalScale;

                      const centerX = canvas.width / 2;
                      const centerY = canvas.height / 2;
                      
                      const posX = centerX + (character_x * (canvas.width / 2)) - (finalW / 2);
                      const posY = centerY + (character_y * (canvas.height / 2)) - (finalH / 2);

                      if (chroma_key !== 'none') {
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
                                   
                                   if (chroma_key === 'white') {
                                       if (r > 240 && g > 240 && b > 240) data[i+3] = 0;
                                   } else if (chroma_key === 'green') {
                                       if (g > r + 40 && g > b + 40) data[i+3] = 0;
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
          bgImg.src = bgSrc;
      });
  };

  // --- Cancel Logic ---
  const handleCancelGeneration = (cutId: string) => {
      updateCutState(cutId, { 
          status: 'idle', 
          progress: 0, 
          statusMessage: "Cancelled by user" 
      });
      generatingLocks.current.delete(cutId); 
      addToast("Generation cancelled.", 'info');
  };

  const handleCancelImgGen = () => {
      imgGenAbortControllerRef.current?.abort();
      setIsImgGenLoading(false);
      setBatchImgGenProgress(null);
      addToast("Image generation cancelled.", 'info');
  };

  const handleResetProject = async () => {
      if (confirm("Are you sure? This will delete all assets and cuts.")) {
          await clearProjectDB();
          window.location.reload();
      }
  };

  // --- API: Generate Cut ---
  const generateCutVideo = async (cutId: string) => {
    if (generatingLocks.current.has(cutId)) return;
    generatingLocks.current.add(cutId);

    try {
      if (window.aistudio && !isMockMode) {
        const hasKey = await window.aistudio.hasSelectedApiKey();
        if (!hasKey) {
          await window.aistudio.openSelectKey();
        }
      }

      let currentProject = projectRef.current;
      let currentCut = currentProject.scenes.flatMap(s => s.cuts).find(c => c.cut_id === cutId);
      if (!currentCut) return;

      updateCutState(cutId, { 
          status: 'generating', 
          error: undefined, 
          progress: 5,
          startTime: Date.now(),
          statusMessage: "Initializing composition..."
      });

      // --- MOCK MODE ---
      if (isMockMode) {
          await wait(500);
          updateCutState(cutId, { statusMessage: "🧪 Merging Layers (Canvas)...", progress: 30 });
          
          if (projectRef.current.scenes.flatMap(s=>s.cuts).find(c=>c.cut_id === cutId)?.status !== 'generating') return;

          let finalImage = "";
          if (currentCut.composition) {
               try {
                   finalImage = await createCompositeImage(currentCut.composition, project.global_image);
               } catch (e) {
                   console.error(e);
                   finalImage = "https://placehold.co/1920x1080?text=Compositing+Failed";
               }
          } else {
               finalImage = "https://placehold.co/1920x1080?text=No+Assets+Selected";
          }
          
          await wait(1000);
          if (projectRef.current.scenes.flatMap(s=>s.cuts).find(c=>c.cut_id === cutId)?.status !== 'generating') return;
          
          const mockAsset: GeneratedAsset = {
              id: Date.now().toString(),
              type: 'video',
              url: finalImage, // It's an image, but used as video placeholder in test mode
              timestamp: Date.now(),
              prompt: "TEST MODE COMPOSITE"
          };

          updateCutState(cutId, { 
              status: 'completed', 
              videoUrl: finalImage, 
              progress: 100, 
              statusMessage: "Composite Verified (Static Image)",
              history: [mockAsset, ...(currentCut.history || [])]
          });
          addToast("🧪 Composite Frame Generated!", 'success');
          return;
      }

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

      let startImageBase64 = '';
      let mimeType = '';

      const comp = currentCut.composition;
      if (comp) {
           updateCutState(cutId, { statusMessage: "Compositing layers..." });
           const dataUrl = await createCompositeImage(comp, project.global_image);
           
           if (projectRef.current.scenes.flatMap(s=>s.cuts).find(c=>c.cut_id === cutId)?.status !== 'generating') return;

           const matches = dataUrl.match(/^data:(.+);base64,(.+)$/);
           if (matches) {
               mimeType = matches[1];
               startImageBase64 = matches[2];
           }
      }

      let prompt = currentCut.prompts.action_prompt || "A cinematic scene.";
      
      // --- STRICT CONSISTENCY MODE (Enhanced) ---
      if (strictMode && startImageBase64) {
          prompt += " \n\n[STRICT VISUAL ADHERENCE REQUIRED]\n" +
          "1. GROUND TRUTH: The provided start frame is the absolute reference for character identity, lighting, and background.\n" +
          "2. NO MORPHING: Do not alter the character's species, fur pattern, colors, or facial structure. Keep the background static unless interaction is specified.\n" +
          "3. CONTINUITY: The video must look like a seamless animation of the provided start image. Maintain the exact aesthetic and camera angle.";
          
          // Chroma Key Protection
          if (comp?.chroma_key === 'green') {
              prompt += "\n4. GREEN SCREEN: The background MUST remain a solid neon green for chroma keying. Do not add details to the green areas.";
          }
      }

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

      if (projectRef.current.scenes.flatMap(s=>s.cuts).find(c=>c.cut_id === cutId)?.status !== 'generating') return;

      let operation: any = null;
      let genRetries = 0;
      let success = false;

      while (!success) {
          if (projectRef.current.scenes.flatMap(s=>s.cuts).find(c=>c.cut_id === cutId)?.status !== 'generating') return;

          try {
              operation = await ai.models.generateVideos(requestPayload);
              success = true; 
          } catch (err: any) {
              if (isRetryableError(err)) {
                  genRetries++;
                  const delay = Math.min(60000, 5000 * Math.pow(1.5, genRetries)); 
                  let msg = `⏳ API Quota Full. Waiting... (${Math.round(delay/1000)}s)`;
                  if (genRetries > 3) {
                      msg = `⚠️ High Retry Count (#${genRetries}). Daily Quota (10/day) likely exhausted.`;
                  }
                  updateCutState(cutId, { error: undefined, statusMessage: msg });
                  await wait(delay);
              } else {
                  throw err; 
              }
          }
      }

      updateCutState(cutId, { status: 'polling', progress: 20, statusMessage: "Server accepted. Rendering..." });
      addToast("Request accepted! Rendering...", 'info');

      const pollInterval = qualityMode ? 5000 : 1500;
      let retries = 0;

      while (!operation.done) {
        if (isBatchGenerating && abortControllerRef.current?.signal.aborted) throw new Error("Batch cancelled");
        await wait(pollInterval);
        
        const freshProject = projectRef.current;
        const freshCut = freshProject.scenes.flatMap(s => s.cuts).find(c => c.cut_id === cutId);
        
        if (!freshCut || freshCut.status !== 'polling') return; 

        try {
            operation = await ai.operations.getVideosOperation({ operation });
            if (projectRef.current.scenes.flatMap(s=>s.cuts).find(c=>c.cut_id === cutId)?.status !== 'polling') return;

            const currentProgress = freshCut?.progress || 20;
            updateCutState(cutId, { 
                progress: Math.min(95, currentProgress + (qualityMode ? 5 : 15)),
                statusMessage: `Rendering Video... ${freshCut?.progress}%`
            });
        } catch (e: any) {
            if (isRetryableError(e)) {
                updateCutState(cutId, { statusMessage: `Polling Rate Limit. Pausing... (Retry #${retries+1})` });
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
          
          const newAsset: GeneratedAsset = {
              id: Date.now().toString(),
              type: 'video',
              url: videoUrl,
              timestamp: Date.now(),
              prompt: prompt
          };

          updateCutState(cutId, { 
              status: 'completed', 
              videoUrl, 
              progress: 100, 
              statusMessage: "Completed",
              history: [newAsset, ...(currentCut.history || [])]
          });
          addToast(`${cutId} Generated Successfully!`, 'success');
      } else {
          throw new Error("No video URI returned");
      }

    } catch (error: any) {
       console.error(error);
       const currentStatus = projectRef.current.scenes.flatMap(s => s.cuts).find(c => c.cut_id === cutId)?.status;
       if (currentStatus === 'idle') return;

       if (isRetryableError(error)) {
           updateCutState(cutId, { status: 'error', error: "Rate limit exceeded. Try again in a moment.", statusMessage: "Failed: Rate Limit" });
           addToast("Rate limit exceeded.", 'error');
       } else {
           updateCutState(cutId, { status: 'error', error: error.message || 'Gen Error', statusMessage: `Failed: ${error.message}` });
           addToast("Generation failed.", 'error');
       }
    } finally {
        generatingLocks.current.delete(cutId);
    }
  };

  const generateBatch = async (cutsToGen: Cut[]) => {
      if (cutsToGen.length === 0) return;
      setIsBatchGenerating(true);
      abortControllerRef.current = new AbortController();
      setGlobalProgress(0);
      addToast(`Starting parallel batch generation for ${cutsToGen.length} cuts.`, 'info');

      const CONCURRENCY_LIMIT = 2; // Run 2 generations at once
      const total = cutsToGen.length;
      let completedCount = 0;
      
      const pendingQueue = [...cutsToGen];
      const activePromises = new Set<Promise<void>>();

      while (pendingQueue.length > 0 && !abortControllerRef.current.signal.aborted) {
          // Fill up the active pool
          while (activePromises.size < CONCURRENCY_LIMIT && pendingQueue.length > 0) {
              const cut = pendingQueue.shift()!;
              
              if (cut.status === 'completed') {
                  completedCount++;
                  setGlobalProgress((completedCount / total) * 100);
                  continue;
              }

              // Create a promise wrapper for the generation task
              const taskPromise = (async () => {
                  try {
                      // We need to implement a robust retry wrapper here for batch stability
                      let success = false;
                      while (!success && !abortControllerRef.current?.signal.aborted) {
                           try {
                               await generateCutVideo(cut.cut_id);
                               const updatedCut = projectRef.current.scenes.flatMap(s=>s.cuts).find(c=>c.cut_id === cut.cut_id);
                               
                               if (updatedCut?.status === 'completed') {
                                   success = true;
                               } else if (updatedCut?.status === 'error' && updatedCut.error?.includes('429')) {
                                   // Wait and retry inside the task
                                   const waitTime = isMockMode ? 1000 : 20000; // Longer wait for 429 in batch
                                   await wait(waitTime);
                               } else {
                                   // Fatal error or cancelled
                                   break;
                               }
                           } catch (e) {
                               console.error(`Batch task failed for ${cut.cut_id}`, e);
                               await wait(5000); // General error backoff
                           }
                      }
                  } finally {
                      completedCount++;
                      setGlobalProgress((completedCount / total) * 100);
                  }
              })();

              // Add to set, and remove self when done
              const p = taskPromise.then(() => {
                  activePromises.delete(p);
              });
              activePromises.add(p);
              
              // Slight stagger to prevent hitting rate limits instantly with simultaneous requests
              await wait(isMockMode ? 100 : 2000); 
          }

          // Wait for at least one task to finish before looping to add more
          if (activePromises.size > 0) {
              await Promise.race(activePromises);
          }
      }

      // Wait for remaining tasks to finish
      await Promise.all(activePromises);

      setIsBatchGenerating(false);
      abortControllerRef.current = null;
      addToast("Batch generation completed!", 'success');
  };

  // --- Video Batch Selection Handlers ---
  const toggleVideoBatchMode = () => {
      setIsVideoBatchMode(!isVideoBatchMode);
      setVideoBatchSelection([]); // Clear selection when toggling off? Or keep? Let's clear to avoid confusion.
  };

  const toggleVideoBatchCut = (cutId: string) => {
      setVideoBatchSelection(prev => 
          prev.includes(cutId) ? prev.filter(id => id !== cutId) : [...prev, cutId]
      );
  };

  const handleSelectSceneForVideoBatch = (scene: Scene, e: React.MouseEvent) => {
      e.stopPropagation();
      if (!isVideoBatchMode) return;
      const sceneCutIds = scene.cuts.map(c => c.cut_id);
      const allSelected = sceneCutIds.every(id => videoBatchSelection.includes(id));
      
      if (allSelected) {
          setVideoBatchSelection(prev => prev.filter(id => !sceneCutIds.includes(id)));
      } else {
          setVideoBatchSelection(prev => [...new Set([...prev, ...sceneCutIds])]);
      }
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
              global_prompts: {},
              compositionPresets: []
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
                      composition: { character_scale: 1, character_x: 0, character_y: 0, chroma_key: 'none' },
                      history: []
                  }))
              };
              adaptedProject.scenes.push(scene);
          } else if (data.scenes) {
              adaptedProject.scenes = data.scenes.map((s: any) => ({
                  ...s,
                  cuts: s.cuts.map((c: any) => ({
                      ...c,
                      status: 'idle',
                      composition: {
                          ...c.composition,
                          chroma_key: c.composition?.chroma_key || 'none'
                      } || { character_scale: 1, character_x: 0, character_y: 0, chroma_key: 'none' },
                      history: c.history || []
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

  const handleSaveJsonFile = () => {
    if (!importJsonText) {
        addToast("Nothing to save", 'error');
        return;
    }
    const blob = new Blob([importJsonText], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `project-script-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    addToast("JSON file saved", 'success');
  };

  const handleJsonFileSelect = (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
          const reader = new FileReader();
          reader.onload = (ev) => {
              const text = ev.target?.result as string;
              setImportJsonText(text);
              addToast("JSON loaded from file", 'success');
          };
          reader.readAsText(file);
      }
  };

  const handleImgGenRefUpload = (type: 'bg' | 'char') => (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
          const reader = new FileReader();
          reader.onload = (ev) => {
              if (type === 'bg') setImgGenBgRef(ev.target?.result as string);
              else setImgGenCharRef(ev.target?.result as string);
          };
          reader.readAsDataURL(file);
      }
  };

  const handleGenerateImage = async () => {
    if (imgGenMode === 'custom' && !imgGenPrompt) return;
    if (imgGenMode === 'batch' && batchSelectedCuts.length === 0) {
        addToast("No cuts selected for batch generation", 'error');
        return;
    }

    setIsImgGenLoading(true);
    setBatchImgGenProgress(null);
    imgGenAbortControllerRef.current = new AbortController();

    // --- Helper for Single Generation ---
    const generateSingleImage = async (prompt: string, forCutId?: string) => {
        if (isMockMode) {
            await wait(1000);
            return "https://placehold.co/1920x1080/png?text=Mock+Asset+" + Date.now();
        }

        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
        let finalPrompt = imgGenGreenScreen 
            ? `${prompt}. IMPORTANT: The background must be a solid, flat, bright neon green color (hex #00FF00) strictly for chroma keying. No gradients, no shadows, no texture in the background.` 
            : prompt;

        // Force Consistency via Prompt Engineering if Reference Images are present
        let instructions = "";
        if (imgGenBgRef) {
            instructions += " REFERENCE 1 (BACKGROUND): Use the first provided image as a strict guide for the environment, lighting, and style. ";
        }
        if (imgGenCharRef) {
            instructions += " REFERENCE 2 (CHARACTER): Use the second provided image as a strict guide for the character's appearance (species, fur, features). ";
        }
        
        if (instructions) {
             finalPrompt += ` MULTIMODAL INSTRUCTIONS: ${instructions}. Combine these elements seamlessly. Style & Character Consistency: Use the provided reference image as a strict visual guide. You MUST maintain the exact appearance of the character (species, fur texture, facial features, body shape) AND the background environment (lighting, color palette, setting) from the reference image.`;
        }
        
        // Build contents parts (Text + Optional Reference Images)
        const parts: any[] = [];
        // Important: Order matters. We reference "first" and "second" above.
        if (imgGenBgRef) {
            const matches = imgGenBgRef.match(/^data:(.+);base64,(.+)$/);
            if (matches) parts.push({ inlineData: { mimeType: matches[1], data: matches[2] } });
        }
        if (imgGenCharRef) {
            const matches = imgGenCharRef.match(/^data:(.+);base64,(.+)$/);
            if (matches) parts.push({ inlineData: { mimeType: matches[1], data: matches[2] } });
        }
        
        parts.push({ text: finalPrompt });

        const response = await ai.models.generateContent({
            model: 'gemini-3-pro-image-preview',
            contents: { parts },
            config: {
                imageConfig: { aspectRatio: "16:9", imageSize: "4K" },
                seed: 424242 
            }
        });
        
        for (const part of response.candidates?.[0]?.content?.parts || []) {
            if (part.inlineData) {
                return `data:image/png;base64,${part.inlineData.data}`;
            }
        }
        return null;
    };

    try {
        if (window.aistudio && !isMockMode) {
            const hasKey = await window.aistudio.hasSelectedApiKey();
            if (!hasKey) await window.aistudio.openSelectKey();
        }
        
        if (imgGenMode === 'custom') {
            addToast("Generating 4K Asset...", 'info');
            const imgUrl = await generateSingleImage(imgGenPrompt);
            if (imgUrl) {
                addAsset(imgUrl);
                if (activeCutId) {
                   const latestCut = projectRef.current.scenes.flatMap(s=>s.cuts).find(c=>c.cut_id === activeCutId);
                   const newAsset: GeneratedAsset = {
                       id: Date.now().toString(),
                       type: 'image',
                       url: imgUrl,
                       timestamp: Date.now(),
                       prompt: imgGenPrompt
                   };
                   updateCutState(activeCutId, { 
                       composition: { ...latestCut?.composition!, background_asset: imgUrl },
                       history: [newAsset, ...(latestCut?.history || [])]
                   });
                   addToast("Asset generated and assigned to active cut.", 'success');
                } else {
                   setProject(prev => ({...prev, global_image: imgUrl}));
                }
                setShowImgGenModal(false);
            }
        } else {
            // --- BATCH MODE ---
            const total = batchSelectedCuts.length;
            let current = 0;
            setBatchImgGenProgress({ current, total });

            for (const cutId of batchSelectedCuts) {
                if (imgGenAbortControllerRef.current?.signal.aborted) break;

                current++;
                setBatchImgGenProgress({ current, total });
                
                const cut = allCuts.find(c => c.cut_id === cutId);
                if (!cut) continue;

                // Use Global Anchor or Start State as prompt
                const prompt = cut.prompts.global_anchor || cut.prompts.start_state || "Cinematic scene";
                
                try {
                    const imgUrl = await generateSingleImage(prompt, cutId);
                    if (imgUrl) {
                        addAsset(imgUrl);
                        // Auto-assign to the cut's background AND history
                        const latestCut = projectRef.current.scenes.flatMap(s=>s.cuts).find(c=>c.cut_id === cutId);
                        const newAsset: GeneratedAsset = {
                           id: Date.now().toString(),
                           type: 'image',
                           url: imgUrl,
                           timestamp: Date.now(),
                           prompt: prompt
                        };
                        updateCutState(cutId, { 
                            composition: { ...cut.composition!, background_asset: imgUrl },
                            history: [newAsset, ...(latestCut?.history || [])]
                        });
                    }
                } catch (e: any) {
                    console.error(`Failed to gen image for ${cutId}`, e);
                    // Continue to next cut even if one fails
                }
                // Small delay to be gentle on rate limits
                await wait(isMockMode ? 200 : 2000);
            }
            if (!imgGenAbortControllerRef.current?.signal.aborted) {
                addToast(`Batch Image Gen Completed (${total} cuts)`, 'success');
                setShowImgGenModal(false);
            }
        }

    } catch (e: any) {
        addToast(`Image generation failed: ${e.message}`, 'error');
    } finally {
        setIsImgGenLoading(false);
        setBatchImgGenProgress(null);
        imgGenAbortControllerRef.current = null;
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
      
      const scale = activeCut.composition?.character_scale || 1;
      charImgRef.current.style.transform = `translate(${newX * 50}%, ${newY * 50}%) scale(${scale})`;
      
      (charImgRef.current as any)._tempX = newX;
      (charImgRef.current as any)._tempY = newY;
  };

  const handleMonitorMouseUp = () => { 
      if (isDragging.current && activeCut && charImgRef.current) {
          isDragging.current = false;
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

  // --- Theater Auto-Advance Effect for Images ---
  useEffect(() => {
      const currentVideo = allCuts[theaterCutIndex]?.videoUrl;
      const isImage = currentVideo?.startsWith('data:image') || currentVideo?.startsWith('https://placehold');
      
      if (showTheater && isImage) {
          const timer = setTimeout(() => {
               if (theaterCutIndex < allCuts.length - 1) {
                   setTheaterCutIndex(prev => prev + 1);
               } else {
                   // Stop at end
               }
          }, 3000); // 3 seconds per image
          return () => clearTimeout(timer);
      }
  }, [showTheater, theaterCutIndex, allCuts]);

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
  
  const isGlobalOverridden = activeCut?.composition?.background_asset !== undefined;

  // Toggle cut selection for batch
  const toggleBatchCut = (cutId: string) => {
      setBatchSelectedCuts(prev => 
          prev.includes(cutId) ? prev.filter(id => id !== cutId) : [...prev, cutId]
      );
  };
  const toggleSelectAllBatch = () => {
      if (batchSelectedCuts.length === allCuts.length) setBatchSelectedCuts([]);
      else setBatchSelectedCuts(allCuts.map(c => c.cut_id));
  };

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-200 overflow-hidden font-sans select-none" onMouseUp={handleMonitorMouseUp}>
      
      {/* --- Sidebar --- */}
      <aside className="w-80 flex flex-col border-r border-zinc-800 bg-zinc-900/50">
        <div className="p-4 border-b border-zinc-800 flex items-center justify-between">
            <div className="flex items-center gap-2">
                <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
                    <Film className="w-5 h-5 text-white" />
                </div>
                <h1 className="font-bold text-xl tracking-tight">Veo 3.1 <span className="text-zinc-500 font-normal">Pro</span></h1>
            </div>
            {/* Batch Selection Mode Toggle */}
            <button 
                onClick={toggleVideoBatchMode} 
                className={`p-2 rounded hover:bg-zinc-800 ${isVideoBatchMode ? 'text-blue-400 bg-blue-900/20 ring-1 ring-blue-500' : 'text-zinc-400'}`}
                title="Toggle Video Batch Selection Mode"
            >
                <ListChecks size={20} />
            </button>
        </div>

        {/* Global Ref */}
        <div className="p-4 border-b border-zinc-800">
            <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-bold text-zinc-500 uppercase">Global Reference</span>
                <div className="flex gap-1">
                    <label className="p-1.5 hover:bg-zinc-800 rounded text-zinc-400 cursor-pointer">
                        <Upload size={16} />
                        <input type="file" onChange={handleGlobalUpload} className="hidden" />
                    </label>
                    <button onClick={() => setShowImgGenModal(true)} className="p-1.5 hover:bg-zinc-800 rounded text-blue-400"><ImageIcon size={16} /></button>
                    {project.global_image && (
                         <a href={project.global_image} download={`ref-${Date.now()}.png`} className="p-1.5 hover:bg-zinc-800 rounded text-green-400"><Download size={16} /></a>
                    )}
                </div>
            </div>
            <div className="aspect-video bg-zinc-950 rounded-lg border border-zinc-800 overflow-hidden relative group">
                {project.global_image ? (
                    <>
                        <img src={project.global_image} className={`w-full h-full object-cover transition-opacity ${isGlobalOverridden ? 'opacity-30 blur-sm' : 'opacity-100'}`} />
                        {isGlobalOverridden && (
                            <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-2 gap-2">
                                <span className="text-xs font-bold text-amber-400 bg-black/80 px-2 py-1 rounded">
                                    Inactive<br/>(Custom BG Set)
                                </span>
                                {/* Restore Global Button */}
                                <button 
                                    onClick={() => updateCutState(activeCutId!, { composition: { ...activeCut!.composition!, background_asset: undefined } })}
                                    className="flex items-center gap-1 px-2 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded text-xs font-medium shadow-lg"
                                >
                                    <RotateCcw size={12} /> Restore Global
                                </button>
                            </div>
                        )}
                    </>
                ) : (
                    <div className="w-full h-full flex items-center justify-center text-zinc-700 text-sm">No Global Ref</div>
                )}
            </div>
        </div>

        {/* Scenes List */}
        <div className="flex-1 overflow-y-auto p-2">
            {project.scenes.map(scene => (
                <div key={scene.scene_id} className="mb-4">
                    <div className="flex items-center justify-between px-2 py-1 mb-1">
                         <span className="text-sm font-bold text-zinc-400 uppercase">{scene.scene_title}</span>
                         {isVideoBatchMode ? (
                             <button onClick={(e) => handleSelectSceneForVideoBatch(scene, e)} className="text-zinc-500 hover:text-blue-400 text-xs font-bold">Select Scene</button>
                         ) : (
                             <button onClick={() => generateBatch(scene.cuts)} className="text-zinc-600 hover:text-blue-500"><Play size={14} /></button>
                         )}
                    </div>
                    <div className="space-y-1">
                        {scene.cuts.map(cut => (
                            <div 
                                key={cut.cut_id}
                                onClick={() => isVideoBatchMode ? toggleVideoBatchCut(cut.cut_id) : setActiveCutId(cut.cut_id)}
                                className={`flex items-center gap-3 px-3 py-3 rounded-md cursor-pointer transition-colors border ${
                                    isVideoBatchMode 
                                        ? (videoBatchSelection.includes(cut.cut_id) ? 'bg-blue-900/30 border-blue-600' : 'hover:bg-zinc-800 border-transparent')
                                        : (activeCutId === cut.cut_id ? 'bg-blue-900/20 border-blue-800' : 'hover:bg-zinc-800 border-transparent')
                                }`}
                            >
                                {isVideoBatchMode ? (
                                    <div className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${videoBatchSelection.includes(cut.cut_id) ? 'bg-blue-600 border-blue-600' : 'border-zinc-600'}`}>
                                         {videoBatchSelection.includes(cut.cut_id) && <CheckSquare size={10} className="text-white" />}
                                    </div>
                                ) : (
                                    <div className={`w-2.5 h-2.5 rounded-full ${
                                        cut.status === 'completed' ? (cut.videoUrl?.startsWith('data:') ? 'bg-teal-400' : 'bg-green-500') :
                                        cut.status === 'generating' ? 'bg-amber-500 animate-pulse' :
                                        cut.status === 'polling' ? 'bg-amber-500 animate-pulse' :
                                        cut.status === 'error' ? 'bg-red-500' : 'bg-zinc-700'
                                    }`} />
                                )}
                                
                                <div className="flex-1 min-w-0">
                                    <div className="flex justify-between items-center">
                                        <span className={`text-base font-semibold ${activeCutId === cut.cut_id && !isVideoBatchMode ? 'text-blue-100' : 'text-zinc-300'}`}>{cut.cut_id}</span>
                                        <span className="text-sm text-zinc-600">{cut.time_code}</span>
                                    </div>
                                    <div className="text-sm text-zinc-500 truncate">{cut.prompts.action_prompt}</div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            ))}
        </div>
        
        <div className="p-4 border-t border-zinc-800">
             <button onClick={handleResetProject} className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm text-zinc-500 hover:text-red-400 hover:bg-zinc-800 rounded font-medium">
                 <RefreshCw size={14} /> Reset Project
             </button>
        </div>
      </aside>

      {/* --- Main Content --- */}
      <main className="flex-1 flex flex-col min-w-0 relative">
        {/* Header */}
        <header className="h-16 border-b border-zinc-800 flex items-center justify-between px-6 bg-zinc-900/50">
            <div className="flex gap-4">
                <button onClick={() => setShowImportModal(true)} className="flex items-center gap-2 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded text-sm font-semibold border border-zinc-700">
                    <FolderOpen size={16} /> <span>Import JSON</span>
                </button>
            </div>
            <div className="flex items-center gap-4">
                {isBatchGenerating && <div className="text-sm font-bold text-amber-400 animate-pulse">Batch Generating... {Math.round(globalProgress)}%</div>}
                
                <button 
                    onClick={() => setIsMockMode(!isMockMode)}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded text-sm font-bold border ${isMockMode ? 'bg-green-900/30 text-green-400 border-green-800' : 'bg-zinc-800 text-zinc-500 border-zinc-700'}`}
                >
                    <FlaskConical size={16} /> {isMockMode ? "Test Mode: ON" : "Test Mode: OFF"}
                </button>

                <div className="flex bg-zinc-800 rounded-lg p-1 border border-zinc-700">
                    <button onClick={()=>setQualityMode(false)} className={`px-3 py-1 text-sm font-semibold rounded ${!qualityMode ? 'bg-zinc-600 text-white' : 'text-zinc-400'}`}>Turbo</button>
                    <button onClick={()=>setQualityMode(true)} className={`px-3 py-1 text-sm font-semibold rounded ${qualityMode ? 'bg-purple-600 text-white' : 'text-zinc-400'}`}>Quality</button>
                </div>

                <button 
                    onClick={() => setStrictMode(!strictMode)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-bold border transition-colors ${strictMode ? 'bg-blue-900/30 text-blue-300 border-blue-800' : 'bg-zinc-800 text-zinc-500 border-zinc-700'}`}
                    title="Enforce strict visual consistency with the reference image"
                >
                    <Lock size={16} /> {strictMode ? "Strict Ref: ON" : "Strict Ref: OFF"}
                </button>

                <button 
                    onClick={() => {
                        if (isBatchGenerating) {
                            abortControllerRef.current?.abort();
                        } else if (isVideoBatchMode && videoBatchSelection.length > 0) {
                            const selectedCuts = allCuts.filter(c => videoBatchSelection.includes(c.cut_id));
                            generateBatch(selectedCuts);
                        } else {
                            generateBatch(allCuts);
                        }
                    }}
                    disabled={isVideoBatchMode && videoBatchSelection.length === 0}
                    className={`flex items-center gap-2 px-4 py-2 rounded-md font-bold text-sm transition-all ${
                        isBatchGenerating 
                            ? 'bg-red-900/50 text-red-200 border border-red-800' 
                            : (isVideoBatchMode 
                                ? (videoBatchSelection.length === 0 ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-900/50')
                                : 'bg-blue-600 hover:bg-blue-500 text-white')
                    }`}
                >
                    {isBatchGenerating ? (
                        <><Square size={16} fill="currentColor" /> Stop</>
                    ) : (
                        isVideoBatchMode ? <><ListChecks size={16} /> Generate Selected ({videoBatchSelection.length})</> : <><Play size={16} fill="currentColor" /> Generate All</>
                    )}
                </button>
                {allCuts.some(c => c.status === 'completed') && (
                     <button onClick={() => setShowTheater(true)} className="p-2 bg-zinc-800 rounded-md hover:bg-zinc-700"><Monitor size={20}/></button>
                )}
            </div>
        </header>

        {/* Viewport / Monitor (Fixed Layout) */}
        <div className="flex-1 bg-zinc-950 flex flex-col relative overflow-hidden p-2">
            {activeCut ? (
                <div className="flex-1 flex items-center justify-center overflow-hidden">
                     <div 
                        className="relative h-full w-full max-w-5xl max-h-full aspect-video bg-zinc-900 shadow-2xl overflow-hidden border border-zinc-800 group mx-auto"
                        onMouseDown={handleMonitorMouseDown}
                        onMouseMove={handleMonitorMouseMove}
                        onWheel={handleMonitorWheel}
                     >
                        {(activeCut.composition?.background_asset || project.global_image) ? (
                            <>
                                <img 
                                    src={activeCut.composition?.background_asset || project.global_image} 
                                    className="absolute inset-0 w-full h-full object-cover" 
                                    alt="bg"
                                />
                                <div className="absolute top-2 right-2 bg-black/60 backdrop-blur px-2 py-1 rounded text-[10px] text-zinc-300 z-10 font-medium">
                                    {activeCut.composition?.background_asset ? 'BG: Custom Asset' : 'BG: Global Ref'}
                                </div>
                            </>
                        ) : (
                            <div className="absolute inset-0 flex items-center justify-center text-zinc-700 font-medium">
                                No Background Set
                            </div>
                        )}

                        {activeCut.composition?.character_asset && (
                             <img 
                                ref={charImgRef}
                                src={processedCharUrl || activeCut.composition.character_asset}
                                className="absolute pointer-events-none transition-transform duration-75 origin-center will-change-transform"
                                style={{
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

                        {activeCut.videoUrl && (
                            (activeCut.videoUrl.startsWith('data:image') || activeCut.videoUrl.startsWith('https://placehold')) ? (
                                <div className="absolute inset-0 z-20 bg-black flex items-center justify-center">
                                    <img src={activeCut.videoUrl} className="w-full h-full object-contain" alt="Test Result" />
                                    <div className="absolute bottom-4 right-4 bg-teal-600 text-white px-3 py-1 text-xs font-bold rounded shadow-lg flex items-center gap-2">
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

                        {!activeCut.videoUrl && (activeCut.status === 'generating' || activeCut.status === 'polling' || activeCut.status === 'error') && (
                            <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-30">
                                {activeCut.status === 'error' ? (
                                    <div className="bg-red-900/90 px-6 py-4 rounded-xl border border-red-700 shadow-2xl flex flex-col items-center gap-2">
                                        <AlertCircle size={32} className="text-red-200" />
                                        <div className="text-white font-bold text-lg">{activeCut.error || "Generation Failed"}</div>
                                        <div className="text-sm text-red-200">{activeCut.statusMessage}</div>
                                    </div>
                                ) : (
                                    <div className="bg-black/80 backdrop-blur-md px-6 py-5 rounded-xl border border-zinc-700 shadow-2xl flex flex-col gap-3 min-w-[280px]">
                                        <div className="flex items-center justify-between border-b border-zinc-700 pb-2 mb-1">
                                            <span className="text-blue-400 font-bold flex items-center gap-2 text-base">
                                                <Loader2 className="animate-spin" size={18} /> 
                                                {activeCut.status === 'generating' ? 'Initializing' : 'Processing'}
                                            </span>
                                            {activeCut.startTime && <StatusTimer startTime={activeCut.startTime} />}
                                        </div>
                                        
                                        <div className="text-base text-zinc-200 font-semibold">
                                            {activeCut.statusMessage || "Waiting for worker..."}
                                        </div>

                                        <div className="h-2.5 w-full bg-zinc-800 rounded-full overflow-hidden">
                                            <div 
                                                className="h-full bg-gradient-to-r from-blue-600 to-purple-600 transition-all duration-300"
                                                style={{ width: `${activeCut.progress || 5}%` }}
                                            />
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                        
                        {activeAssetTab === 'character' && activeCut.composition?.character_asset && (
                            <div className="absolute top-2 left-2 bg-black/50 text-[10px] px-2 py-1 rounded text-zinc-400 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity font-semibold">
                                Drag to move • Scroll to scale
                            </div>
                        )}
                     </div>
                </div>
            ) : (
                <div className="flex-1 flex items-center justify-center text-zinc-600 font-semibold text-lg">Select a cut to edit</div>
            )}
        </div>

        {/* --- COMPACT GENERATE BUTTON --- */}
        {activeCut && (
             <div className="w-full z-10 border-t border-zinc-800">
                 {(activeCut.status === 'generating' || activeCut.status === 'polling') ? (
                     <button 
                        onClick={() => handleCancelGeneration(activeCut.cut_id)}
                        className="w-full h-12 bg-red-600 hover:bg-red-500 text-white font-bold text-base flex items-center justify-center gap-2 transition-colors"
                    >
                        <X size={20} /> Cancel Generation
                    </button>
                 ) : (
                     <button 
                        onClick={() => generateCutVideo(activeCut.cut_id)}
                        className="w-full h-12 bg-blue-600 hover:bg-blue-500 text-white font-bold text-base flex items-center justify-center gap-2 transition-colors"
                    >
                        <Play fill="currentColor" size={20} /> Generate Cut {isMockMode && "(Test Mode)"}
                    </button>
                 )}
             </div>
        )}

        {/* --- Bottom Panel --- */}
        <div className="h-64 bg-zinc-900 border-t border-zinc-800 flex flex-col">
            {activeCut ? (
                <>
                {/* Control Bar */}
                <div className="h-12 border-b border-zinc-800 flex items-center justify-between px-4 bg-zinc-900 shrink-0">
                     <div className="flex items-center gap-4">
                        <div className="flex gap-1 bg-zinc-950 p-1 rounded-lg">
                            <button onClick={() => setActiveAssetTab('background')} className={`px-4 py-1 text-xs rounded-md font-bold transition-colors ${activeAssetTab === 'background' ? 'bg-zinc-700 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}>Background</button>
                            <button onClick={() => setActiveAssetTab('character')} className={`px-4 py-1 text-xs rounded-md font-bold transition-colors ${activeAssetTab === 'character' ? 'bg-zinc-700 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}>Character</button>
                            <button onClick={() => setActiveAssetTab('history')} className={`px-4 py-1 text-xs rounded-md font-bold transition-colors flex items-center gap-1 ${activeAssetTab === 'history' ? 'bg-zinc-700 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}>
                                <HistoryIcon size={12} /> History
                            </button>
                        </div>
                        
                        {/* Preset Buttons (Only show when not in History tab) */}
                        {activeAssetTab !== 'history' && (
                            <div className="flex items-center gap-2 border-l border-zinc-800 pl-4">
                                <span className="text-xs text-zinc-500 font-bold uppercase">Layouts:</span>
                                <button onClick={handleSavePreset} className="flex items-center gap-1 px-2 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs rounded border border-zinc-700 font-semibold">
                                    <Plus size={10} /> Save
                                </button>
                                <div className="flex gap-1 max-w-[300px] overflow-x-auto no-scrollbar">
                                    {(project.compositionPresets || []).map(preset => (
                                        <div key={preset.id} className="flex items-center gap-1 bg-zinc-800 text-xs px-2 py-1 rounded border border-zinc-700 group shrink-0">
                                            <span onClick={() => handleApplyPreset(preset)} className="cursor-pointer hover:text-white text-zinc-400 font-medium">{preset.name}</span>
                                            <button onClick={(e) => handleDeletePreset(preset.id, e)} className="text-zinc-600 hover:text-red-400"><X size={10}/></button>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
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
                                <Palette size={14} className="text-zinc-500"/>
                                <select 
                                    value={activeCut.composition.chroma_key}
                                    onChange={(e) => updateCutState(activeCut.cut_id, { composition: { ...activeCut.composition!, chroma_key: e.target.value as any }})}
                                    className="bg-zinc-800 border-none text-xs font-semibold rounded px-2 py-1 text-zinc-300 focus:ring-1 focus:ring-blue-500"
                                >
                                    <option value="none">No Filter</option>
                                    <option value="white">Remove White</option>
                                    <option value="green">Remove Green</option>
                                </select>
                             </div>
                         </div>
                     )}
                </div>

                <div className="flex-1 overflow-x-auto p-4 min-h-0">
                    <div className="flex gap-3 h-full">
                        {activeAssetTab === 'history' ? (
                            activeCut.history && activeCut.history.length > 0 ? (
                                activeCut.history.map((item) => (
                                    <div 
                                        key={item.id}
                                        onClick={() => handleRestoreHistory(item)}
                                        className="min-w-[200px] bg-zinc-950 h-full rounded-lg border-2 border-zinc-800 hover:border-blue-500 overflow-hidden relative cursor-pointer group flex-shrink-0"
                                    >
                                        <img src={item.url} className="w-full h-full object-cover opacity-70 group-hover:opacity-100 transition-opacity" />
                                        <div className={`absolute top-2 left-2 px-2 py-0.5 rounded text-[10px] font-bold text-white ${item.type === 'video' ? 'bg-purple-600' : 'bg-blue-600'}`}>
                                            {item.type.toUpperCase()}
                                        </div>
                                        <div className="absolute bottom-0 inset-x-0 bg-black/80 p-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                            <div className="text-[10px] text-zinc-400">{new Date(item.timestamp).toLocaleTimeString()}</div>
                                            <div className="flex items-center gap-1 text-xs text-white font-bold mt-1">
                                                <RotateCcw size={12} /> Restore
                                            </div>
                                        </div>
                                    </div>
                                ))
                            ) : (
                                <div className="w-full flex flex-col items-center justify-center text-zinc-600 gap-2">
                                    <HistoryIcon size={24} />
                                    <span className="text-sm font-medium">No generation history for this cut yet.</span>
                                </div>
                            )
                        ) : (
                            <>
                                <div className="min-w-[160px] h-full border border-dashed border-zinc-700 rounded-lg flex flex-col items-center justify-center hover:bg-zinc-800/50 transition-colors relative">
                                    <Upload className="mb-2 text-zinc-500" size={24} />
                                    <span className="text-xs text-zinc-500 font-semibold">Upload Asset</span>
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
                            </>
                        )}
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
                      <h2 className="text-lg font-bold">Import / Export Project JSON</h2>
                      <button onClick={() => setShowImportModal(false)} className="text-zinc-500 hover:text-white"><X size={20}/></button>
                  </div>
                  <div className="p-4 flex-1 overflow-hidden flex flex-col gap-4">
                      {/* Control Bar */}
                      <div className="flex justify-between items-center bg-zinc-950 p-3 rounded-lg border border-zinc-800">
                          <span className="text-sm text-zinc-400">Edit script or manage files:</span>
                          <div className="flex gap-2">
                              <label className="flex items-center gap-2 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded text-xs font-medium cursor-pointer border border-zinc-700 transition-colors text-zinc-300 hover:text-white">
                                  <Upload size={14} /> Upload JSON
                                  <input type="file" accept=".json" className="hidden" onChange={handleJsonFileSelect} />
                              </label>
                              <button onClick={handleSaveJsonFile} className="flex items-center gap-2 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded text-xs font-medium border border-zinc-700 transition-colors text-zinc-300 hover:text-white">
                                  <Download size={14} /> Save to File
                              </button>
                          </div>
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
                       <button onClick={() => setImportJsonText('')} className="px-4 py-2 text-zinc-400 hover:text-white text-sm">Clear Text</button>
                       <button onClick={handleImportJson} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-md text-sm font-medium">Load Project</button>
                  </div>
              </div>
          </div>
      )}

      {/* --- Image Generation Modal (UPDATED) --- */}
      {showImgGenModal && (
          <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
              <div className="bg-zinc-900 w-full max-w-xl rounded-xl border border-zinc-800 shadow-2xl relative overflow-hidden flex flex-col max-h-[90vh]">
                  {isImgGenLoading && (
                      <div className="absolute inset-0 bg-black/80 z-20 flex flex-col items-center justify-center text-blue-400 gap-3 backdrop-blur-sm">
                          <Loader2 size={48} className="animate-spin" />
                          <div className="flex flex-col items-center">
                            <span className="font-bold animate-pulse text-lg">
                                {imgGenMode === 'batch' && batchImgGenProgress 
                                    ? `Generating Batch ${batchImgGenProgress.current}/${batchImgGenProgress.total}`
                                    : "Creating 4K Asset..."}
                            </span>
                            <span className="text-sm text-zinc-400 mt-2">Please wait, this can take a moment.</span>
                          </div>
                          <button 
                              onClick={handleCancelImgGen}
                              className="mt-4 px-4 py-2 bg-red-900/80 hover:bg-red-800 text-red-100 rounded-md text-sm font-bold border border-red-700 flex items-center gap-2"
                          >
                              <Square size={14} fill="currentColor" /> Stop Generation
                          </button>
                      </div>
                  )}
                  <div className="p-4 border-b border-zinc-800 flex justify-between items-center">
                      <h2 className="text-lg font-bold">Generate 4K Asset</h2>
                      <button onClick={() => setShowImgGenModal(false)} className="text-zinc-500 hover:text-white"><X size={20}/></button>
                  </div>
                  
                  {/* Mode Tabs */}
                  <div className="flex border-b border-zinc-800">
                      <button 
                        onClick={() => setImgGenMode('custom')}
                        className={`flex-1 py-3 text-sm font-medium border-b-2 transition-colors ${imgGenMode === 'custom' ? 'border-blue-500 text-white bg-zinc-800/50' : 'border-transparent text-zinc-400 hover:bg-zinc-800/30'}`}
                      >
                          Custom Prompt
                      </button>
                      <button 
                        onClick={() => setImgGenMode('batch')}
                        className={`flex-1 py-3 text-sm font-medium border-b-2 transition-colors flex items-center justify-center gap-2 ${imgGenMode === 'batch' ? 'border-blue-500 text-white bg-zinc-800/50' : 'border-transparent text-zinc-400 hover:bg-zinc-800/30'}`}
                      >
                          <ListChecks size={14} /> Batch from Cuts
                      </button>
                  </div>

                   {/* DUAL Reference Upload Area */}
                   <div className="px-4 pt-4 flex gap-4">
                        {/* Background Ref Slot */}
                        <div className="flex-1 space-y-2">
                             <div className="text-xs font-bold text-zinc-500 uppercase">Background Ref</div>
                             <div className="flex items-center gap-2">
                                <label className="flex-1 h-16 border border-dashed border-zinc-700 rounded hover:bg-zinc-800 cursor-pointer overflow-hidden relative flex items-center justify-center">
                                    {imgGenBgRef ? (
                                        <img src={imgGenBgRef} className="w-full h-full object-cover" />
                                    ) : (
                                        <div className="flex flex-col items-center">
                                            <ImageIcon size={14} className="text-zinc-500"/>
                                            <span className="text-[10px] text-zinc-600 mt-1">Upload BG</span>
                                        </div>
                                    )}
                                    <input type="file" accept="image/*" onChange={handleImgGenRefUpload('bg')} className="hidden" />
                                </label>
                                {imgGenBgRef && (
                                    <button onClick={() => setImgGenBgRef(null)} className="p-2 text-red-400 hover:bg-zinc-800 rounded"><Trash2 size={14}/></button>
                                )}
                             </div>
                        </div>

                        {/* Character Ref Slot */}
                        <div className="flex-1 space-y-2">
                             <div className="text-xs font-bold text-zinc-500 uppercase">Character Ref</div>
                             <div className="flex items-center gap-2">
                                <label className="flex-1 h-16 border border-dashed border-zinc-700 rounded hover:bg-zinc-800 cursor-pointer overflow-hidden relative flex items-center justify-center">
                                    {imgGenCharRef ? (
                                        <img src={imgGenCharRef} className="w-full h-full object-cover" />
                                    ) : (
                                        <div className="flex flex-col items-center">
                                            <MousePointer2 size={14} className="text-zinc-500"/>
                                            <span className="text-[10px] text-zinc-600 mt-1">Upload Char</span>
                                        </div>
                                    )}
                                    <input type="file" accept="image/*" onChange={handleImgGenRefUpload('char')} className="hidden" />
                                </label>
                                {imgGenCharRef && (
                                    <button onClick={() => setImgGenCharRef(null)} className="p-2 text-red-400 hover:bg-zinc-800 rounded"><Trash2 size={14}/></button>
                                )}
                             </div>
                        </div>
                   </div>
                   <div className="px-4 pb-2 text-[10px] text-zinc-500 text-center mt-2">
                       The AI will merge the style of the Background Ref with the features of the Character Ref.
                   </div>

                  {imgGenMode === 'custom' ? (
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
                      </div>
                  ) : (
                      <div className="p-4 flex flex-col gap-2 flex-1 overflow-hidden">
                          <div className="flex justify-between items-center mb-2">
                              <span className="text-sm text-zinc-400">Select cuts to generate backgrounds for:</span>
                              <button onClick={toggleSelectAllBatch} className="text-xs text-blue-400 hover:text-blue-300 font-medium">
                                  {batchSelectedCuts.length === allCuts.length ? "Deselect All" : "Select All"}
                              </button>
                          </div>
                          <div className="flex-1 overflow-y-auto border border-zinc-800 rounded-lg bg-zinc-950 p-2 space-y-1">
                              {allCuts.map(cut => (
                                  <div 
                                    key={cut.cut_id} 
                                    onClick={() => toggleBatchCut(cut.cut_id)}
                                    className={`flex items-start gap-3 p-2 rounded cursor-pointer border ${batchSelectedCuts.includes(cut.cut_id) ? 'bg-blue-900/20 border-blue-800' : 'border-transparent hover:bg-zinc-900'}`}
                                  >
                                      <div className={`mt-0.5 w-4 h-4 rounded border flex items-center justify-center shrink-0 ${batchSelectedCuts.includes(cut.cut_id) ? 'bg-blue-600 border-blue-600' : 'border-zinc-600'}`}>
                                          {batchSelectedCuts.includes(cut.cut_id) && <CheckSquare size={10} className="text-white" />}
                                      </div>
                                      <div className="flex-1 min-w-0">
                                          <div className="flex justify-between">
                                              <span className={`text-xs font-bold ${batchSelectedCuts.includes(cut.cut_id) ? 'text-blue-200' : 'text-zinc-300'}`}>{cut.cut_id}</span>
                                              <span className="text-xs text-zinc-500">{cut.time_code}</span>
                                          </div>
                                          <div className="text-[10px] text-zinc-500 truncate mt-0.5">
                                              {cut.prompts.global_anchor || cut.prompts.start_state || "No prompt"}
                                          </div>
                                      </div>
                                  </div>
                              ))}
                          </div>
                      </div>
                  )}

                  {/* Shared Footer Options */}
                  <div className="p-4 border-t border-zinc-800 flex flex-col gap-4 bg-zinc-900">
                        <div className="flex items-center gap-2 bg-zinc-950 p-3 rounded border border-zinc-800">
                            <input 
                                type="checkbox" 
                                id="greenScreen"
                                checked={imgGenGreenScreen}
                                onChange={(e) => setImgGenGreenScreen(e.target.checked)}
                                className="accent-green-500"
                            />
                            <label htmlFor="greenScreen" className="text-sm cursor-pointer select-none">
                                <span className="font-bold text-green-400">Green Screen Mode</span>
                                <span className="block text-xs text-zinc-500">Adds "solid bright green background" to prompt for chroma keying</span>
                            </label>
                        </div>

                        <div className="flex justify-end gap-3">
                            <button onClick={() => setShowImgGenModal(false)} className="px-4 py-2 text-zinc-400 hover:text-white text-sm">Cancel</button>
                            <button 
                                onClick={handleGenerateImage} 
                                disabled={imgGenMode === 'batch' && batchSelectedCuts.length === 0}
                                className={`px-6 py-2 rounded-md text-sm font-medium flex items-center gap-2 ${
                                    imgGenMode === 'batch' && batchSelectedCuts.length === 0 
                                    ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
                                    : 'bg-purple-600 hover:bg-purple-500 text-white'
                                }`}
                            >
                                <ImageIcon size={16} /> 
                                {imgGenMode === 'batch' 
                                    ? `Generate ${batchSelectedCuts.length} Images` 
                                    : `Generate ${isMockMode ? "(Test)" : ""}`}
                            </button>
                        </div>
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
                  {(() => {
                      const currentCut = allCuts[theaterCutIndex];
                      const currentVideo = currentCut?.videoUrl;
                      const isImage = currentVideo?.startsWith('data:image') || currentVideo?.startsWith('https://placehold');

                      if (!currentVideo) {
                          return <div className="text-zinc-500">Cut {theaterCutIndex + 1} not generated yet</div>;
                      }

                      if (isImage) {
                          return <img src={currentVideo} className="max-w-full max-h-full object-contain" alt="Test Playback" />;
                      }

                      return (
                           <video 
                             src={currentVideo} 
                             className="max-w-full max-h-full aspect-video" 
                             controls 
                             autoPlay 
                             onEnded={() => {
                                 if (theaterCutIndex < allCuts.length - 1) {
                                     setTheaterCutIndex(prev => prev + 1);
                                 }
                             }}
                           />
                      );
                  })()}
              </div>
              <div className="h-24 bg-zinc-900/90 border-t border-zinc-800 flex items-center gap-4 px-8 overflow-x-auto">
                   {allCuts.map((cut, i) => (
                       <div 
                         key={cut.cut_id} 
                         onClick={() => setTheaterCutIndex(i)}
                         className={`min-w-[100px] h-16 rounded border-2 cursor-pointer relative overflow-hidden ${theaterCutIndex === i ? 'border-blue-500' : 'border-zinc-700 opacity-50 hover:opacity-100'}`}
                       >
                           {cut.videoUrl ? (
                               (cut.videoUrl.startsWith('data:image') || cut.videoUrl.startsWith('https://placehold')) ? 
                               <img src={cut.videoUrl} className="w-full h-full object-cover" /> :
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
