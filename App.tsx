import React, { useState, useRef, useCallback, useEffect, ChangeEvent } from 'react';
import { GoogleGenAI } from '@google/genai';
import { Play, Download, Square, Upload, Image as ImageIcon, Film, MousePointer2, X, ChevronDown, FolderOpen, Save, Loader2, CheckCircle, AlertCircle, Clock, Link as LinkIcon, RotateCcw, ListChecks, Lock, History as HistoryIcon, ChevronRight, Monitor, User, Image as BgIcon, Key as KeyIcon, Trash2, Plus, ArrowDown, Zap, Shield, Ratio } from 'lucide-react';
import { Project, Cut, Scene, GenerationStatus, CompositionState, CompositionPreset, GeneratedAsset } from './types';

// --- Constants & Helpers ---
const DB_NAME = 'VeoDirectorDB';
const STORE_NAME = 'project_store';
const MAX_POLL_TIME = 300000; // 5 minutes timeout

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryableError = (error: any) => {
  if (!error) return false;
  const msg = (typeof error === 'string' ? error : error.message) || '';
  return msg.includes('429') || msg.includes('Quota exceeded') || msg.includes('RESOURCE_EXHAUSTED');
};

const extractLastFrameFromVideo = async (videoUrl: string): Promise<string> => {
    return new Promise((resolve, reject) => {
        const video = document.createElement('video');
        video.crossOrigin = 'anonymous';
        video.src = videoUrl;
        video.currentTime = 10000; // Seek to end (safe large number)
        
        video.onloadeddata = () => {
             // wait a bit to ensure seek
             video.currentTime = Math.max(0, video.duration - 0.1);
        };

        video.onseeked = () => {
            const canvas = document.createElement('canvas');
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const ctx = canvas.getContext('2d');
            if (ctx) {
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL('image/jpeg', 0.9));
            } else {
                reject("Canvas error");
            }
        };
        video.onerror = () => reject("Video load error");
    });
};

// --- IndexedDB ---
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
    request.onerror = () => reject("DB Error");
  });
};

const saveProjectToDB = async (project: Project) => {
    try {
        const db = await initDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.put(project, 'current_project');
    } catch (e) { console.error("Save failed", e); }
};

const loadProjectFromDB = async (): Promise<Project | null> => {
    try {
        const db = await initDB();
        return new Promise((resolve) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const req = store.get('current_project');
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
        });
    } catch (e) { return null; }
};

// --- Components ---
const StatusTimer: React.FC<{ startTime?: number, status: string }> = ({ startTime, status }) => {
    const [elapsed, setElapsed] = useState("00:00");
    useEffect(() => {
        if (!startTime || status === 'completed' || status === 'error' || status === 'idle') return;
        const interval = setInterval(() => {
            const sec = Math.floor((Date.now() - startTime) / 1000);
            const m = Math.floor(sec / 60).toString().padStart(2, '0');
            const s = (sec % 60).toString().padStart(2, '0');
            setElapsed(`${m}:${s}`);
        }, 1000);
        return () => clearInterval(interval);
    }, [startTime, status]);
    return <span className="font-mono text-xs">{elapsed}</span>;
};

// --- Main App ---
const App: React.FC = () => {
  // --- State ---
  const [project, setProject] = useState<Project>({
    project_title: 'Untitled Project',
    default_settings: { resolution: '1080p', cut_duration_seconds: 5 },
    scenes: [],
    assets: [],
    compositionPresets: [],
    global_prompts: {},
    global_bg_scale: 1, 
    global_bg_x: 0,
    global_bg_y: 0,
    global_character_scale: 1,
    global_character_x: 0,
    global_character_y: 0,
    global_chroma_key: 'none'
  });

  const [activeCutId, setActiveCutId] = useState<string | null>(null);
  
  // Modes & Settings
  const [isBatchGenerating, setIsBatchGenerating] = useState(false);
  const [qualityMode, setQualityMode] = useState(false); 
  const [isTestMode, setIsTestMode] = useState(false);
  const [isAutoLinkMode, setIsAutoLinkMode] = useState(false);
  const [strictMode, setStrictMode] = useState(true);
  const [batchModeSpeed, setBatchModeSpeed] = useState<'safe' | 'fast'>('safe');
  const [aspectRatio, setAspectRatio] = useState<'16:9' | '1:1'>('16:9'); 
  
  // Batch Selection
  const [isVideoBatchMode, setIsVideoBatchMode] = useState(false);
  const [videoBatchSelection, setVideoBatchSelection] = useState<Set<string>>(new Set());

  // UI State
  const [globalProgress, setGlobalProgress] = useState(0);
  const [collapsedScenes, setCollapsedScenes] = useState<Set<string>>(new Set()); 
  const [showImportModal, setShowImportModal] = useState(false);
  const [importJsonText, setImportJsonText] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [showImgGenModal, setShowImgGenModal] = useState(false);
  const [isImgGenLoading, setIsImgGenLoading] = useState(false);
  const [imgGenPrompt, setImgGenPrompt] = useState('');
  const [imgGenBgRef, setImgGenBgRef] = useState<string | null>(null);
  const [imgGenCharRef, setImgGenCharRef] = useState<string | null>(null);
  const [imgGenGreenScreen, setImgGenGreenScreen] = useState(false);
  const [imgGenBatchMode, setImgGenBatchMode] = useState(false);
  const [imgGenSelection, setImgGenSelection] = useState<Set<string>>(new Set());

  // Workspace
  const [activeAssetTab, setActiveAssetTab] = useState<'background' | 'character' | 'history' | 'recent'>('background');
  const [processedCharUrl, setProcessedCharUrl] = useState<string | null>(null);
  const [toasts, setToasts] = useState<{id: number, message: string, type: 'info'|'success'|'error'}[]>([]);
  const [showTheater, setShowTheater] = useState(false);
  const [theaterCutIndex, setTheaterCutIndex] = useState(0);

  // Refs
  const abortControllerRef = useRef<AbortController | null>(null);
  const imgGenAbortControllerRef = useRef<AbortController | null>(null);
  const projectRef = useRef<Project>(project);
  const charImgRef = useRef<HTMLImageElement>(null);
  const bgImgRef = useRef<HTMLImageElement>(null);
  const generatingLocks = useRef<Set<string>>(new Set());
  const monitorContainerRef = useRef<HTMLDivElement>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync & Debounced Auto-save
  useEffect(() => {
    projectRef.current = project;
    // Debounce save to prevent UI lag during rapid updates (e.g. progress polling, dragging)
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
        saveProjectToDB(project);
    }, 2000); 
    
    return () => { if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current); };
  }, [project]);

  // Load on mount
  useEffect(() => {
      loadProjectFromDB().then(p => {
          if (p) {
              // Migration for new fields
              if (!p.global_bg_scale) p.global_bg_scale = 1;
              if (p.global_bg_x === undefined) p.global_bg_x = 0;
              if (p.global_bg_y === undefined) p.global_bg_y = 0;
              if (!p.global_character_scale) p.global_character_scale = 1;
              if (p.global_character_x === undefined) p.global_character_x = 0;
              if (p.global_character_y === undefined) p.global_character_y = 0;
              if (!p.global_chroma_key) p.global_chroma_key = 'none';
              if (!p.compositionPresets) p.compositionPresets = [];
              setProject(p);
              if (p.scenes.length > 0 && p.scenes[0].cuts.length > 0) {
                  setActiveCutId(p.scenes[0].cuts[0].cut_id);
              }
          }
      });
  }, []);

  // Helpers
  const activeScene = project.scenes.find(s => s.cuts.some(c => c.cut_id === activeCutId));
  const activeCut = activeScene?.cuts.find(c => c.cut_id === activeCutId);
  const allCuts = project.scenes.flatMap(s => s.cuts);

  const addToast = useCallback((message: string, type: 'info' | 'success' | 'error' = 'info') => {
      if (message.includes("Preparing request")) return; 
      setToasts(prev => {
          if (prev.some(t => t.message === message)) return prev;
          return [...prev, { id: Date.now() + Math.random(), message, type }];
      });
      setTimeout(() => {
          setToasts(current => current.slice(1)); 
      }, 4000);
  }, []);

  const updateCutState = useCallback((cutId: string, updates: Partial<Cut>) => {
    setProject((prev) => {
      const newScenes = prev.scenes.map((scene) => ({
        ...scene,
        cuts: scene.cuts.map((cut) => {
           if (cut.cut_id === cutId) {
               let newCut = { ...cut, ...updates };
               if (updates.composition) {
                   newCut.composition = { ...cut.composition, ...updates.composition } as CompositionState;
               }
               return newCut;
           }
           return cut;
        }),
      }));
      return { ...prev, scenes: newScenes };
    });
  }, []);

  const addAsset = (assetDataUrl: string) => {
      if (!project.assets.includes(assetDataUrl)) {
          setProject(prev => ({ ...prev, assets: [assetDataUrl, ...prev.assets] }));
      }
  };

  const addToHistory = (cutId: string, asset: GeneratedAsset) => {
      const cut = projectRef.current.scenes.flatMap(s=>s.cuts).find(c=>c.cut_id===cutId);
      if (cut) {
          const newHistory = [asset, ...(cut.history || [])];
          updateCutState(cutId, { history: newHistory });
      }
  };

  // --- COMPOSITING ENGINE (Debounced for Performance) ---
  useEffect(() => {
      const targetChar = activeCut?.composition?.character_asset || project.global_character_image;
      const targetChroma = activeCut?.composition?.character_asset ? (activeCut?.composition?.chroma_key || 'none') : (project.global_chroma_key || 'none');
      
      if (!targetChar) {
          setProcessedCharUrl(null);
          return;
      }
      
      if (targetChroma === 'none') {
          setProcessedCharUrl(targetChar);
          return;
      }

      // DEBOUNCE: Wait 150ms after changes before processing heavy image logic
      const timer = setTimeout(() => {
          const img = new Image();
          img.crossOrigin = "anonymous";
          img.onload = () => {
              const canvas = document.createElement('canvas');
              // Optim: Limit preview size for performance
              const MAX_PREVIEW = 800;
              let w = img.width;
              let h = img.height;
              if (w > MAX_PREVIEW) { h = h * (MAX_PREVIEW/w); w = MAX_PREVIEW; }
              
              canvas.width = Math.floor(w);
              canvas.height = Math.floor(h);
              const ctx = canvas.getContext('2d');
              if (!ctx) return;
              
              ctx.drawImage(img, 0, 0, w, h);
              const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
              const data = imgData.data;
              
              for(let i = 0; i < data.length; i += 4) {
                 const r = data[i];
                 const g = data[i+1];
                 const b = data[i+2];
                 
                 if (targetChroma === 'white') {
                     if (r > 240 && g > 240 && b > 240) data[i+3] = 0; 
                 } else if (targetChroma === 'green') {
                     if (g > 100 && g > r + 40 && g > b + 40) data[i+3] = 0;
                 }
              }
              ctx.putImageData(imgData, 0, 0);
              setProcessedCharUrl(canvas.toDataURL());
          };
          img.src = targetChar;
      }, 150);

      return () => clearTimeout(timer);
  }, [
      activeCut?.composition?.character_asset, 
      activeCut?.composition?.chroma_key, 
      project.global_character_image, 
      project.global_chroma_key
  ]);

  const createCompositeImage = async (
      composition?: CompositionState, 
      globalBg?: string, 
      globalChar?: string, 
      globalScale?: number, 
      globalX?: number, 
      globalY?: number, 
      globalChroma?: string, 
      globalBgScale?: number, 
      globalBgX?: number,
      globalBgY?: number,
      targetAspectRatio: '16:9' | '1:1' = '16:9'
    ): Promise<string> => {
      const bg = composition?.background_asset || globalBg;
      const char = composition?.character_asset || globalChar;
      
      const scale = composition?.character_scale ?? globalScale ?? 1;
      const chroma = composition?.chroma_key || globalChroma || 'none';
      const posX = composition?.character_x ?? globalX ?? 0;
      const posY = composition?.character_y ?? globalY ?? 0;
      
      const bgScale = globalBgScale ?? 1;
      const bgPosX = composition?.background_x ?? globalBgX ?? 0;
      const bgPosY = composition?.background_y ?? globalBgY ?? 0;

      if (!char && bg && bgScale === 1 && bgPosX === 0 && bgPosY === 0 && targetAspectRatio === '16:9') return bg; 
      if (!bg) return '';

      return new Promise((resolve) => {
          const canvas = document.createElement('canvas');
          canvas.width = targetAspectRatio === '16:9' ? 1920 : 1080; 
          canvas.height = 1080;
          const ctx = canvas.getContext('2d');
          if (!ctx) { resolve(''); return; }

          const bgImg = new Image();
          bgImg.crossOrigin = "anonymous";
          bgImg.onload = () => {
              const scaledW = Math.floor(canvas.width * bgScale);
              const scaledH = Math.floor(canvas.height * bgScale);
              // BG Position: Center based + offset. 
              const bgX = Math.floor((canvas.width - scaledW) / 2) + Math.floor(bgPosX * (canvas.width / 2));
              const bgY = Math.floor((canvas.height - scaledH) / 2) + Math.floor(bgPosY * (canvas.height / 2));
              
              ctx.drawImage(bgImg, bgX, bgY, scaledW, scaledH);
              
              if (char) {
                  const charImg = new Image();
                  charImg.crossOrigin = "anonymous";
                  charImg.onload = () => {
                      const centerX = canvas.width / 2;
                      const centerY = canvas.height / 2;
                      const safeW = canvas.width * 0.8;
                      const safeH = canvas.height * 0.8;
                      const fitScale = Math.min(safeW / charImg.width, safeH / charImg.height);
                      const finalScale = fitScale * scale;
                      const finalW = Math.floor(charImg.width * finalScale);
                      const finalH = Math.floor(charImg.height * finalScale);
                      const pX = Math.floor(centerX + (posX * (canvas.width / 2)) - (finalW / 2));
                      const pY = Math.floor(centerY + (posY * (canvas.height / 2)) - (finalH / 2));

                      if (chroma !== 'none') {
                           const tempCanvas = document.createElement('canvas');
                           tempCanvas.width = finalW;
                           tempCanvas.height = finalH;
                           const tempCtx = tempCanvas.getContext('2d');
                           if (tempCtx) {
                               tempCtx.drawImage(charImg, 0, 0, finalW, finalH);
                               const imgData = tempCtx.getImageData(0, 0, finalW, finalH);
                               const d = imgData.data;
                               for(let i=0; i<d.length; i+=4) {
                                   const r=d[i], g=d[i+1], b=d[i+2];
                                   if (chroma === 'white' && r>240 && g>240 && b>240) d[i+3]=0;
                                   if (chroma === 'green' && g>100 && g>r+40 && g>b+40) d[i+3]=0;
                               }
                               tempCtx.putImageData(imgData, 0, 0); 
                               ctx.drawImage(tempCanvas, pX, pY, finalW, finalH);
                           }
                      } else {
                          ctx.drawImage(charImg, pX, pY, finalW, finalH);
                      }
                      resolve(canvas.toDataURL('image/jpeg', 0.95));
                  };
                  charImg.src = char;
              } else {
                  resolve(canvas.toDataURL('image/jpeg', 0.95));
              }
          };
          bgImg.src = bg;
      });
  };

  // --- API Functions ---
  const handleTestApiKey = async () => {
      try {
          addToast("Testing API Key...", "info");
          const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
          await ai.models.generateContent({
              model: 'gemini-2.5-flash',
              contents: 'ping',
          });
          addToast("API Key is Valid! ✅", "success");
      } catch (e: any) {
          addToast(`API Key Error: ${e.message}`, "error");
      }
  };

  const generateCutVideo = async (cutId: string) => {
    if (generatingLocks.current.has(cutId)) return;
    generatingLocks.current.add(cutId);

    try {
      if (window.aistudio && await window.aistudio.hasSelectedApiKey() === false) {
          await window.aistudio.openSelectKey();
      }

      let currentCut = projectRef.current.scenes.flatMap(s => s.cuts).find(c => c.cut_id === cutId);
      if (!currentCut) return;
      
      updateCutState(cutId, { 
          status: 'generating', error: undefined, progress: 5, startTime: Date.now(),
          statusMessage: "🎨 Compositing Assets..."
      });

      let startImageBase64 = '';
      let mimeType = '';
      
      // Explicitly pass default values to avoid undefined types for optional numbers
      const compDataUrl = await createCompositeImage(
          currentCut.composition, 
          projectRef.current.global_image,
          projectRef.current.global_character_image,
          projectRef.current.global_character_scale ?? 1,
          projectRef.current.global_character_x ?? 0,
          projectRef.current.global_character_y ?? 0,
          projectRef.current.global_chroma_key ?? 'none',
          projectRef.current.global_bg_scale ?? 1,
          projectRef.current.global_bg_x ?? 0,
          projectRef.current.global_bg_y ?? 0,
          aspectRatio 
      );

      currentCut = projectRef.current.scenes.flatMap(s => s.cuts).find(c => c.cut_id === cutId);
      if (currentCut?.status === 'idle') { generatingLocks.current.delete(cutId); return; }

      if (compDataUrl) {
           const matches = compDataUrl.match(/^data:(.+);base64,(.+)$/);
           if (matches) { mimeType = matches[1]; startImageBase64 = matches[2]; }
      }

      // Test Mode
      if (isTestMode) {
          await wait(1000); 
          updateCutState(cutId, { statusMessage: "🧪 TEST MODE: Simulating generation..." });
          await wait(1000);
          
          const mockResult = compDataUrl || "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
          updateCutState(cutId, { status: 'completed', videoUrl: mockResult, progress: 100, statusMessage: "Completed (Test Mode)" });
          addToHistory(cutId, { id: Date.now().toString(), type: 'image', url: mockResult, timestamp: Date.now(), prompt: "TEST MODE" });
          
          if (isAutoLinkMode) {
               const cuts = projectRef.current.scenes.flatMap(s=>s.cuts);
               const idx = cuts.findIndex(c=>c.cut_id === cutId);
               if (idx >= 0 && idx < cuts.length - 1) {
                   updateCutState(cuts[idx+1].cut_id, { composition: { ...cuts[idx+1].composition!, background_asset: mockResult } });
                   addToast("🔗 Auto-Linked next cut!", "success");
               }
          }
          generatingLocks.current.delete(cutId);
          return;
      }

      let prompt = currentCut.prompts.action_prompt || "A cinematic scene.";
      if (startImageBase64) {
          prompt = `Action starts from the provided reference frame: ${prompt}`;
      }
      if (strictMode && startImageBase64) {
          prompt += " VISUAL CONSISTENCY: Strictly maintain the character's appearance (species, fur, face), background details, lighting, and camera angle from the provided start frame. Do not morph the character or alter the environment.";
      }
      if (currentCut.composition?.chroma_key === 'green' || projectRef.current.global_chroma_key === 'green') {
           prompt += " IMPORTANT: Keep the background strictly SOLID NEON GREEN for chroma keying.";
      }

      const model = qualityMode ? 'veo-3.1-generate-preview' : 'veo-3.1-fast-generate-preview';
      let payload: any = {
        model, prompt,
        config: { numberOfVideos: 1, resolution: '1080p', aspectRatio: aspectRatio } 
      };
      if (startImageBase64) {
          payload.image = { imageBytes: startImageBase64, mimeType };
      }

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      updateCutState(cutId, { statusMessage: "🚀 Sending to Veo Cloud..." });

      let operation: any = null;
      let genRetries = 0;
      let success = false;

      while (!success) {
          currentCut = projectRef.current.scenes.flatMap(s => s.cuts).find(c => c.cut_id === cutId);
          if (currentCut?.status === 'idle') { generatingLocks.current.delete(cutId); return; }

          try {
              operation = await ai.models.generateVideos(payload);
              success = true; 
          } catch (err: any) {
              if (isRetryableError(err)) {
                  genRetries++;
                  if (genRetries >= 8) {
                      throw new Error("⛔ DAILY QUOTA EXCEEDED (10/day). Please switch to Test Mode.");
                  }
                  const delay = Math.min(60000, 5000 * Math.pow(1.5, genRetries));
                  updateCutState(cutId, { statusMessage: `⏳ Quota Full. Waiting... (${Math.round(delay/1000)}s)` });
                  await wait(delay);
              } else {
                  throw err;
              }
          }
      }

      updateCutState(cutId, { status: 'polling', progress: 20, statusMessage: "☁️ Processing on Google Cloud..." });
      const pollInterval = qualityMode ? 5000 : 1500;
      const pollStartTime = Date.now();

      while (!operation.done) {
        currentCut = projectRef.current.scenes.flatMap(s => s.cuts).find(c => c.cut_id === cutId);
        if (currentCut?.status === 'idle') { generatingLocks.current.delete(cutId); return; }

        if (Date.now() - pollStartTime > MAX_POLL_TIME) {
            throw new Error("⏱️ Generation Timed Out (Server stuck). Please try again.");
        }

        await wait(pollInterval);
        try {
            // FIX: Use explicit operation name to avoid stale status and prevent infinite loops
            // @ts-ignore
            operation = await ai.operations.getVideosOperation({ name: operation.name });
            
            const freshCut = projectRef.current.scenes.flatMap(s=>s.cuts).find(c=>c.cut_id===cutId);
            const cp = freshCut?.progress || 20;
            updateCutState(cutId, { progress: Math.min(95, cp + (qualityMode ? 5 : 10)) });
        } catch (e: any) {
            if (isRetryableError(e)) { await wait(5000); continue; }
            throw e;
        }
      }

      const videoUri = operation.response?.generatedVideos?.[0]?.video?.uri;
      if (videoUri) {
          updateCutState(cutId, { statusMessage: "⬇️ Downloading Video..." });
          const res = await fetch(`${videoUri}&key=${process.env.API_KEY}`);
          if (!res.ok) throw new Error("Download failed");
          const blob = await res.blob();
          const videoUrl = URL.createObjectURL(blob);
          
          if (isAutoLinkMode) {
              try {
                  const lastFrame = await extractLastFrameFromVideo(videoUrl);
                  const cuts = projectRef.current.scenes.flatMap(s=>s.cuts);
                  const idx = cuts.findIndex(c=>c.cut_id === cutId);
                  if (idx >= 0 && idx < cuts.length - 1) {
                      updateCutState(cuts[idx+1].cut_id, { composition: { ...cuts[idx+1].composition!, background_asset: lastFrame } });
                      addToast("🔗 Auto-Linked next cut!", "success");
                  }
              } catch(e) { console.error("Auto-link failed", e); }
          }
          addToHistory(cutId, { id: Date.now().toString(), type: 'video', url: videoUrl, timestamp: Date.now(), prompt });
          updateCutState(cutId, { status: 'completed', videoUrl, progress: 100, statusMessage: "Completed" });
          addToast(`${cutId} Generated!`, 'success');
      } else {
          throw new Error("No video URI");
      }

    } catch (error: any) {
       console.error(error);
       if (error.message.includes("DAILY QUOTA")) {
           updateCutState(cutId, { status: 'error', error: error.message });
           addToast("Daily Quota Exceeded.", 'error');
       } else {
           updateCutState(cutId, { status: 'error', error: error.message || 'Gen Error' });
           addToast(`Error: ${error.message}`, 'error');
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
      
      const modeText = batchModeSpeed === 'safe' ? 'ULTRA SAFE Mode (1x)' : 'FAST Mode (2x)';
      addToast(`Batch started (${modeText}) for ${cutsToGen.length} cuts.`, 'info');

      const CONCURRENCY = (isAutoLinkMode || batchModeSpeed === 'safe') ? 1 : 2;
      
      const queue = [...cutsToGen];
      const total = cutsToGen.length;
      let completedCount = 0;
      const activePromises: Promise<void>[] = [];

      while (queue.length > 0 || activePromises.length > 0) {
          if (abortControllerRef.current.signal.aborted) break;

          while (queue.length > 0 && activePromises.length < CONCURRENCY) {
              const cut = queue.shift();
              if (!cut) break;
              if (cut.status === 'completed') {
                  completedCount++;
                  continue;
              }

              const p = generateCutVideo(cut.cut_id).then(async () => {
                  completedCount++;
                  setGlobalProgress((completedCount / total) * 100);
                  activePromises.splice(activePromises.indexOf(p), 1);
                  if (batchModeSpeed === 'safe' && !isTestMode) await wait(5000); 
              });
              activePromises.push(p);
          }

          if (activePromises.length > 0) {
              await Promise.race(activePromises);
          }
      }
      
      setIsBatchGenerating(false);
      abortControllerRef.current = null;
      addToast("Batch completed!", 'success');
  };

  const handleGenerateImage = async () => {
      if (!imgGenPrompt) return;
      setIsImgGenLoading(true);
      imgGenAbortControllerRef.current = new AbortController();
      const signal = imgGenAbortControllerRef.current.signal;
      try {
          const targets = imgGenBatchMode 
              ? allCuts.filter(c => imgGenSelection.has(c.cut_id)) 
              : (activeCut ? [activeCut] : []);
          
          if (targets.length === 0 && !imgGenBatchMode) {
              await generateSingleImage(null);
          } else {
              for (const targetCut of targets) {
                  if (signal.aborted) break;
                  const promptToUse = imgGenBatchMode ? (targetCut.prompts.global_anchor || targetCut.prompts.start_state) : imgGenPrompt;
                  await generateSingleImage(targetCut.cut_id, promptToUse);
              }
          }
      } catch (e: any) { addToast(e.message, 'error'); }
      finally { setIsImgGenLoading(false); imgGenAbortControllerRef.current = null; }
  };

  const generateSingleImage = async (targetCutId: string | null, promptOverride?: string) => {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      let finalPrompt = promptOverride || imgGenPrompt;
      const parts: any[] = [];
      if (imgGenBgRef) parts.push({ inlineData: { mimeType: 'image/png', data: imgGenBgRef.split(',')[1] } });
      if (imgGenCharRef) parts.push({ inlineData: { mimeType: 'image/png', data: imgGenCharRef.split(',')[1] } });
      if (imgGenBgRef || imgGenCharRef) {
          finalPrompt += " Style & Character Consistency: Use the provided reference images as a strict visual guide. 1st image=Background style, 2nd image=Character details. Maintain exact appearance.";
      }
      if (imgGenGreenScreen) {
          finalPrompt += " IMPORTANT: The background must be a solid, flat, bright neon green color (hex #00FF00) strictly for chroma keying.";
      }
      parts.push({ text: finalPrompt });
      const res = await ai.models.generateContent({
          model: 'gemini-3-pro-image-preview',
          contents: { parts },
          config: { imageConfig: { aspectRatio: "16:9", imageSize: "4K" } }
      });
      const imgUrl = `data:image/png;base64,${res.candidates?.[0]?.content?.parts?.find((p:any)=>p.inlineData)?.inlineData.data}`;
      if (imgUrl) {
          addAsset(imgUrl);
          const historyItem: GeneratedAsset = { id: Date.now().toString(), type: 'image', url: imgUrl, timestamp: Date.now(), prompt: finalPrompt };
          if (targetCutId) {
              updateCutState(targetCutId, { composition: { ...project.scenes.flatMap(s=>s.cuts).find(c=>c.cut_id===targetCutId)?.composition!, background_asset: imgUrl } });
              addToHistory(targetCutId, historyItem);
          } else {
              setProject(prev => ({...prev, global_image: imgUrl}));
          }
          addToast("Image Generated!", 'success');
      }
  };

  const isDragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const startPos = useRef({ x: 0, y: 0 });
  const dragTarget = useRef<'char_local' | 'char_global' | 'bg_local' | 'bg_global' | null>(null);

  useEffect(() => {
      const handleWinMove = (e: MouseEvent) => {
          if (!isDragging.current || !monitorContainerRef.current || !dragTarget.current) return;
          e.preventDefault();
          const rect = monitorContainerRef.current.getBoundingClientRect();
          const dx = (e.clientX - dragStart.current.x) / (rect.width / 2);
          const dy = (e.clientY - dragStart.current.y) / (rect.height / 2);
          
          if (dragTarget.current.startsWith('char') && charImgRef.current) {
              const newX = startPos.current.x + dx;
              const newY = startPos.current.y + dy;
              const scale = dragTarget.current === 'char_local' 
                  ? (activeCut?.composition?.character_scale ?? project.global_character_scale ?? 1)
                  : (project.global_character_scale ?? 1);
              charImgRef.current.style.transform = `translate(${newX * 50}%, ${newY * 50}%) scale(${scale})`;
              (charImgRef.current as any)._tempX = newX;
              (charImgRef.current as any)._tempY = newY;
          } else if (dragTarget.current.startsWith('bg') && bgImgRef.current) {
              const newX = startPos.current.x + dx;
              const newY = startPos.current.y + dy;
              // BG uses simple scale transform logic in render, but for dragging we need to update style
              // The render style is `scale(scale)`. We need `translate(...) scale(...)` now.
              // Note: Background dragging moves it relative to center.
              const scale = project.global_bg_scale ?? 1;
              bgImgRef.current.style.transform = `translate(${newX * 50}%, ${newY * 50}%) scale(${scale})`;
              (bgImgRef.current as any)._tempX = newX;
              (bgImgRef.current as any)._tempY = newY;
          }
      };

      const handleWinUp = () => {
          if (isDragging.current) {
              isDragging.current = false;
              if (dragTarget.current?.startsWith('char') && charImgRef.current) {
                  const nx = (charImgRef.current as any)._tempX;
                  const ny = (charImgRef.current as any)._tempY;
                  if (nx !== undefined) {
                      if (dragTarget.current === 'char_global') setProject(p => ({...p, global_character_x: nx, global_character_y: ny }));
                      else if (activeCut) updateCutState(activeCut.cut_id, { composition: { ...activeCut.composition!, character_x: nx, character_y: ny } });
                  }
              } else if (dragTarget.current?.startsWith('bg') && bgImgRef.current) {
                  const nx = (bgImgRef.current as any)._tempX;
                  const ny = (bgImgRef.current as any)._tempY;
                  if (nx !== undefined) {
                      if (dragTarget.current === 'bg_global') setProject(p => ({...p, global_bg_x: nx, global_bg_y: ny }));
                      else if (activeCut) updateCutState(activeCut.cut_id, { composition: { ...activeCut.composition!, background_x: nx, background_y: ny } });
                  }
              }
              dragTarget.current = null;
          }
      };
      
      window.addEventListener('mousemove', handleWinMove);
      window.addEventListener('mouseup', handleWinUp);
      return () => { window.removeEventListener('mousemove', handleWinMove); window.removeEventListener('mouseup', handleWinUp); };
  }, [activeCut, project]);

  const isGlobalOverridden = activeCut?.composition?.background_asset !== undefined;
  const isGlobalCharOverridden = activeCut?.composition?.character_asset !== undefined;

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-200 overflow-hidden font-sans select-none">
      {/* Global Progress Bar */}
      {isBatchGenerating && <div className="absolute top-16 left-0 right-0 h-1 bg-zinc-800 z-50"><div className="h-full bg-blue-500 transition-all duration-500" style={{width: `${globalProgress}%`}}/></div>}

      {/* Sidebar */}
      <aside className="w-80 flex flex-col border-r border-zinc-800 bg-zinc-900/50">
          <div className="p-4 border-b border-zinc-800 flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center"><Film className="text-white" /></div>
            <h1 className="font-bold text-lg">Veo 3.1 <span className="text-zinc-500 font-normal">Pro</span></h1>
          </div>
          
          <div className="flex-1 overflow-y-auto">
              {/* Global BG */}
              <div className="p-4 border-b border-zinc-800 relative group">
                  <div className="flex justify-between mb-2">
                      <span className="text-xs font-bold text-zinc-500">GLOBAL BG</span>
                      <div className="flex gap-1">
                          {isGlobalOverridden && <button onClick={() => updateCutState(activeCutId!, {composition: {...activeCut?.composition!, background_asset: undefined}})} className="text-xs text-amber-400 hover:underline">Restore</button>}
                          <label className="cursor-pointer hover:text-white"><Upload size={14}/><input type="file" className="hidden" onChange={(e)=>{const f = e.target.files?.[0]; if(f) { const r = new FileReader(); r.onload=ev=>{addAsset(ev.target?.result as string); setProject(p=>({...p, global_image: ev.target?.result as string}))}; r.readAsDataURL(f); }}}/></label>
                      </div>
                  </div>
                  <div className="space-y-2">
                       <div className="aspect-video bg-zinc-950 rounded border border-zinc-800 relative overflow-hidden">
                           {project.global_image ? <img src={project.global_image} className={`w-full h-full object-cover ${isGlobalOverridden ? 'opacity-30' : ''}`} /> : <div className="flex items-center justify-center h-full text-xs">No Global BG</div>}
                           {isGlobalOverridden && <div className="absolute inset-0 flex items-center justify-center text-xs font-bold text-amber-400">Inactive (Custom Set)</div>}
                       </div>
                       <div className="flex items-center gap-2 text-xs"><span className="w-8">Scale</span><input type="range" min="0.1" max="2" step="0.1" value={project.global_bg_scale ?? 1} onChange={(e)=>setProject(p=>({...p, global_bg_scale: parseFloat(e.target.value)}))} className="w-full accent-blue-600 h-1 bg-zinc-700 rounded-full"/></div>
                  </div>
              </div>
              
              {/* Global Character */}
              <div className="p-4 border-b border-zinc-800 relative">
                  <div className="flex justify-between mb-2">
                      <span className="text-xs font-bold text-zinc-500">GLOBAL CHAR</span>
                      <label className="cursor-pointer hover:text-white"><Upload size={14}/><input type="file" className="hidden" onChange={(e)=>{const f = e.target.files?.[0]; if(f) { const r = new FileReader(); r.onload=ev=>{addAsset(ev.target?.result as string); setProject(p=>({...p, global_character_image: ev.target?.result as string}))}; r.readAsDataURL(f); }}}/></label>
                  </div>
                  <div className="flex gap-2 mb-2">
                       <div className="w-16 h-16 bg-zinc-950 rounded border border-zinc-800 relative overflow-hidden shrink-0">
                           {project.global_character_image ? <img src={project.global_character_image} className={`w-full h-full object-contain ${isGlobalCharOverridden ? 'opacity-30' : ''}`} /> : null}
                       </div>
                       <div className="flex-1 space-y-2">
                           <div className="flex items-center gap-2 text-xs"><span className="w-8">Scale</span><input type="range" min="0.1" max="3" step="0.1" value={project.global_character_scale} onChange={(e)=>setProject(p=>({...p, global_character_scale: parseFloat(e.target.value)}))} className="w-full accent-blue-600 h-1 bg-zinc-700 rounded-full"/></div>
                           <div className="flex items-center gap-2 text-xs"><span className="w-8">X</span><input type="range" min="-1" max="1" step="0.05" value={project.global_character_x} onChange={(e)=>setProject(p=>({...p, global_character_x: parseFloat(e.target.value)}))} className="w-full accent-blue-600 h-1 bg-zinc-700 rounded-full"/></div>
                           <div className="flex items-center gap-2 text-xs"><span className="w-8">Y</span><input type="range" min="-1" max="1" step="0.05" value={project.global_character_y} onChange={(e)=>setProject(p=>({...p, global_character_y: parseFloat(e.target.value)}))} className="w-full accent-blue-600 h-1 bg-zinc-700 rounded-full"/></div>
                           <select value={project.global_chroma_key} onChange={(e)=>setProject(p=>({...p, global_chroma_key: e.target.value as any}))} className="w-full bg-zinc-950 border border-zinc-800 rounded text-xs p-1"><option value="none">Normal</option><option value="white">Remove White</option><option value="green">Remove Green</option></select>
                       </div>
                  </div>
                  {isGlobalCharOverridden && <div className="text-[10px] text-amber-400 text-center">Custom Character Active</div>}
              </div>

              {/* Cuts List */}
              <div className="p-3 space-y-4">
                  {project.scenes.map((scene, sceneIndex) => {
                      const isCollapsed = collapsedScenes.has(scene.scene_id);
                      return (
                      <div key={scene.scene_id} className="bg-zinc-900/40 rounded-lg overflow-hidden border border-zinc-800 shadow-sm transition-all hover:border-zinc-700/50">
                          <div onClick={(e) => {if ((e.target as HTMLElement).closest('button') || (e.target as HTMLElement).closest('input')) return; setCollapsedScenes(prev => {const next = new Set(prev); next.has(scene.scene_id) ? next.delete(scene.scene_id) : next.add(scene.scene_id); return next;});}} className="flex items-center justify-between px-3 py-2 bg-zinc-800 cursor-pointer hover:bg-zinc-750 select-none">
                              <div className="flex items-center gap-2">
                                  <ChevronDown size={14} className={`text-zinc-500 transition-transform duration-200 ${isCollapsed ? '-rotate-90' : ''}`} />
                                  {isVideoBatchMode ? (
                                      <div className="flex items-center gap-2" onClick={(e)=>e.stopPropagation()}>
                                          <input type="checkbox" className="w-4 h-4 rounded border-zinc-600 bg-zinc-900 checked:bg-blue-600 cursor-pointer" checked={scene.cuts.length > 0 && scene.cuts.every(c => videoBatchSelection.has(c.cut_id))} onChange={() => {const ids = scene.cuts.map(c => c.cut_id); setVideoBatchSelection(prev => {const next = new Set(prev); const allIn = ids.every(id => prev.has(id)); ids.forEach(id => allIn ? next.delete(id) : next.add(id)); return next;});}}/>
                                          <span className="text-xs font-bold text-zinc-300 uppercase tracking-wide">{scene.scene_title}</span>
                                      </div>
                                  ) : <span className="text-xs font-bold text-zinc-300 uppercase tracking-wide">{scene.scene_title}</span>}
                              </div>
                              {!isVideoBatchMode && !isCollapsed && <button onClick={(e)=>{e.stopPropagation(); generateBatch(scene.cuts)}} className="text-zinc-500 hover:text-blue-400 p-1 hover:bg-zinc-700 rounded" title="Generate Scene"><Play size={12} fill="currentColor"/></button>}
                          </div>
                          {!isCollapsed && (
                              <div className="space-y-0.5 p-1 animate-in slide-in-from-top-2 duration-200">
                                  {scene.cuts.map((cut, cutIndex) => {
                                      const isSelected = videoBatchSelection.has(cut.cut_id);
                                      const isActive = activeCutId === cut.cut_id;
                                      return (
                                        <React.Fragment key={cut.cut_id}>
                                            {isAutoLinkMode && cutIndex > 0 && <div className="flex justify-center -my-1.5 relative z-10"><div className="bg-zinc-900 rounded-full p-0.5 border border-zinc-700 text-zinc-500 shadow-sm"><ArrowDown size={8} /></div></div>}
                                            <div onClick={() => isVideoBatchMode ? setVideoBatchSelection(p => {const n=new Set(p); n.has(cut.cut_id)?n.delete(cut.cut_id):n.add(cut.cut_id); return n;}) : setActiveCutId(cut.cut_id)} className={`flex items-center gap-3 px-3 py-2.5 rounded-md border cursor-pointer transition-all ${isActive && !isVideoBatchMode ? 'bg-blue-900/30 border-blue-800 shadow-sm' : 'border-transparent hover:bg-zinc-800'}`}>
                                                {isVideoBatchMode ? <div className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${isSelected ? 'bg-blue-600 border-blue-600' : 'border-zinc-600 bg-zinc-900'}`}>{isSelected && <CheckCircle size={10} className="text-white"/>}</div> : <div className={`w-2 h-2 rounded-full ring-2 ring-offset-1 ring-offset-zinc-900 ${cut.status==='completed' ? 'bg-green-500 ring-green-900' : cut.status==='generating' ? 'bg-amber-500 ring-amber-900 animate-pulse' : cut.status==='error' ? 'bg-red-500 ring-red-900' : 'bg-zinc-700 ring-zinc-800'}`}/>}
                                                <div className="min-w-0 flex-1">
                                                    <div className="flex justify-between items-center mb-0.5"><span className={`text-sm font-semibold ${isActive ? 'text-blue-100' : 'text-zinc-300'}`}>{cut.cut_id}</span><span className="text-[10px] text-zinc-600 font-mono bg-zinc-900 px-1.5 rounded">{cut.time_code}</span></div>
                                                    <div className="text-[11px] text-zinc-500 truncate">{cut.prompts.action_prompt}</div>
                                                </div>
                                                {isAutoLinkMode && <LinkIcon size={10} className="text-zinc-600" />}
                                            </div>
                                        </React.Fragment>
                                      );
                                  })}
                              </div>
                          )}
                      </div>
                  )})}
              </div>
          </div>
          <div className="p-4 border-t border-zinc-800"><button onClick={()=>{setProject({project_title:'Untitled', default_settings:{resolution:'1080p',cut_duration_seconds:5},scenes:[],assets:[],global_prompts:{},compositionPresets:[]}); setActiveCutId(null);}} className="w-full py-2 flex items-center justify-center gap-2 text-zinc-500 hover:text-red-400 text-xs"><RotateCcw size={14}/> Reset Project</button></div>
      </aside>

      {/* Main */}
      <main className="flex-1 flex flex-col min-w-0">
          <header className="h-16 border-b border-zinc-800 bg-zinc-900/50 flex items-center justify-between px-6 relative">
              <div className="flex gap-3">
                  <button onClick={()=>setShowImportModal(true)} className="flex items-center gap-2 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded text-sm font-medium"><FolderOpen size={16}/> Import</button>
                  <button onClick={()=>setShowImgGenModal(true)} className="flex items-center gap-2 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 rounded text-sm text-purple-300 font-medium"><ImageIcon size={16}/> AI Image</button>
              </div>
              <div className="flex items-center gap-4">
                  <button onClick={handleTestApiKey} className="text-zinc-500 hover:text-white" title="Check API Key"><KeyIcon size={18}/></button>
                  <button onClick={()=>setIsTestMode(!isTestMode)} className={`flex items-center gap-2 px-3 py-1 text-xs rounded border font-medium ${isTestMode ? 'bg-green-900/30 border-green-800 text-green-400' : 'border-zinc-700 text-zinc-500'}`}>🧪 Test {isTestMode ? 'ON' : 'OFF'}</button>
                  
                  <button onClick={()=>setAspectRatio(r => r === '16:9' ? '1:1' : '16:9')} className="flex items-center gap-2 px-3 py-1 text-xs rounded border font-medium border-zinc-700 text-zinc-400 hover:text-white hover:border-zinc-600">
                      <Ratio size={12}/> {aspectRatio}
                  </button>

                  <button onClick={()=>setBatchModeSpeed(s => s === 'safe' ? 'fast' : 'safe')} className={`flex items-center gap-2 px-3 py-1 text-xs rounded border font-medium ${batchModeSpeed === 'safe' ? 'bg-blue-900/30 border-blue-800 text-blue-400' : 'border-zinc-700 text-amber-500'}`}>
                      {batchModeSpeed === 'safe' ? <><Shield size={12}/> Ultra Safe (1x)</> : <><Zap size={12}/> Fast Batch (2x)</>}
                  </button>

                  <button onClick={()=>setStrictMode(!strictMode)} className={`text-xs flex items-center gap-1 font-medium ${strictMode ? 'text-blue-400' : 'text-zinc-600'}`}><Lock size={12}/> Strict Ref</button>
                  <button onClick={()=>setIsAutoLinkMode(!isAutoLinkMode)} className={`text-xs flex items-center gap-1 font-medium ${isAutoLinkMode ? 'text-blue-400' : 'text-zinc-600'}`}><LinkIcon size={12}/> Auto-Link</button>
                  <button onClick={()=>setIsVideoBatchMode(!isVideoBatchMode)} className={`p-2 rounded transition-colors ${isVideoBatchMode ? 'bg-blue-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'}`} title="Batch Select Mode"><ListChecks size={18}/></button>

                  <div className="flex bg-zinc-800 rounded p-1">
                      <button onClick={()=>setQualityMode(false)} className={`px-3 py-1 text-xs rounded font-medium transition-all ${!qualityMode?'bg-zinc-600 text-white shadow-sm':'text-zinc-400'}`}>Turbo</button>
                      <button onClick={()=>setQualityMode(true)} className={`px-3 py-1 text-xs rounded font-medium transition-all ${qualityMode?'bg-purple-600 text-white shadow-sm':'text-zinc-400'}`}>Quality</button>
                  </div>

                  <button onClick={() => {if (isBatchGenerating || activeCut?.status === 'generating') { abortControllerRef.current?.abort(); if (activeCut) { updateCutState(activeCut.cut_id, { status: 'idle', error: 'Cancelled by user' }); generatingLocks.current.delete(activeCut.cut_id); } setIsBatchGenerating(false); } else { if (isVideoBatchMode) { const targets = allCuts.filter(c => videoBatchSelection.has(c.cut_id)); generateBatch(targets); } else { generateBatch(allCuts); } }}} className={`flex items-center gap-2 px-5 py-2 rounded font-bold text-sm transition-colors shadow-lg ${ (isBatchGenerating || activeCut?.status==='generating') ? 'bg-red-600 hover:bg-red-500 text-white' : 'bg-blue-600 hover:bg-blue-500 text-white' }`} disabled={isVideoBatchMode && videoBatchSelection.size === 0}>
                      {(isBatchGenerating || activeCut?.status==='generating') ? <><Square size={16} fill="currentColor"/> Cancel</> : isVideoBatchMode ? `Generate Selected (${videoBatchSelection.size})` : `Generate All`}
                  </button>
              </div>
          </header>

          {/* Monitor */}
          <div className="flex-1 bg-zinc-950 flex flex-col items-center justify-center p-6 min-h-0 overflow-hidden">
             {activeCut || project.global_image || project.global_character_image ? (
                 <div ref={monitorContainerRef} 
                    className="relative w-full max-h-full mx-auto bg-zinc-900 shadow-2xl border border-zinc-800 group cursor-crosshair" 
                    style={{ aspectRatio: aspectRatio === '16:9' ? '16/9' : '1/1' }}
                    onMouseDown={(e)=>{ 
                        // Start Drag logic
                        isDragging.current = true; 
                        dragStart.current = { x: e.clientX, y: e.clientY }; 
                        
                        // Hit Test
                        if (e.target === charImgRef.current) {
                            const hasLocalAsset = !!activeCut?.composition?.character_asset; 
                            const hasLocalPos = activeCut?.composition?.character_x !== undefined; 
                            dragTarget.current = (hasLocalAsset || hasLocalPos) ? 'char_local' : 'char_global';
                            startPos.current = { 
                                x: (dragTarget.current === 'char_local' ? activeCut?.composition?.character_x : project.global_character_x) ?? 0, 
                                y: (dragTarget.current === 'char_local' ? activeCut?.composition?.character_y : project.global_character_y) ?? 0 
                            };
                        } else {
                            // Assume Background
                            const hasLocalAsset = !!activeCut?.composition?.background_asset;
                            const hasLocalPos = activeCut?.composition?.background_x !== undefined;
                            dragTarget.current = (hasLocalAsset || hasLocalPos) ? 'bg_local' : 'bg_global';
                            startPos.current = {
                                x: (dragTarget.current === 'bg_local' ? activeCut?.composition?.background_x : project.global_bg_x) ?? 0,
                                y: (dragTarget.current === 'bg_local' ? activeCut?.composition?.background_y : project.global_bg_y) ?? 0
                            };
                        }
                    }} 
                    onWheel={(e) => { 
                        if (activeAssetTab!=='character') return; 
                        const currentScale = activeCut?.composition?.character_scale ?? project.global_character_scale ?? 1; 
                        const newScale = Math.max(0.1, currentScale + e.deltaY * -0.001); 
                        if(activeCut) updateCutState(activeCut.cut_id, {composition:{...activeCut.composition!, character_scale: newScale}}); 
                    }}>
                     
                     {/* BG */}
                     {(activeCut?.composition?.background_asset || project.global_image) ? (
                         <div className="absolute inset-0 overflow-hidden flex items-center justify-center">
                              <img 
                                ref={bgImgRef}
                                src={activeCut?.composition?.background_asset || project.global_image} 
                                className="w-full h-full object-cover origin-center will-change-transform pointer-events-auto" 
                                style={{ transform: `translate(${(activeCut?.composition?.background_x ?? project.global_bg_x ?? 0)*50}%, ${(activeCut?.composition?.background_y ?? project.global_bg_y ?? 0)*50}%) scale(${(!activeCut?.composition?.background_asset && project.global_bg_scale) || 1})` }}
                              />
                         </div>
                     ) : (
                         <div className="absolute inset-0 flex items-center justify-center text-zinc-700">No BG</div>
                     )}

                     {/* Char */}
                     {(activeCut?.composition?.character_asset || project.global_character_image) && <img ref={charImgRef} src={processedCharUrl || activeCut?.composition?.character_asset || project.global_character_image} className="absolute origin-center will-change-transform pointer-events-auto" style={{ width: '80%', height: '80%', objectFit: 'contain', left: '10%', top: '10%', transform: `translate(${(activeCut?.composition?.character_x ?? project.global_character_x ?? 0)*50}%, ${(activeCut?.composition?.character_y ?? project.global_character_y ?? 0)*50}%) scale(${activeCut?.composition?.character_scale ?? project.global_character_scale ?? 1})` }} />}
                     
                     {/* Video */}
                     {activeCut?.videoUrl && (activeCut.videoUrl.startsWith('data:image') ? <img src={activeCut.videoUrl} className="absolute inset-0 w-full h-full object-cover z-20 pointer-events-none" /> : <video src={activeCut.videoUrl} className="absolute inset-0 w-full h-full object-cover z-20 pointer-events-none" controls autoPlay loop />)}
                     
                     {/* Badges */}
                     {!activeCut?.videoUrl && activeCut && <div className="absolute top-4 right-4 flex flex-col items-end gap-1 z-30 pointer-events-none"><span className={`text-[10px] px-2 py-0.5 rounded font-bold ${isGlobalOverridden ? 'bg-blue-600' : 'bg-zinc-800/80 border border-zinc-700'} text-white`}>BG: {isGlobalOverridden ? 'Custom' : 'Global'}</span><span className={`text-[10px] px-2 py-0.5 rounded font-bold ${isGlobalCharOverridden ? 'bg-purple-600' : 'bg-zinc-800/80 border border-zinc-700'} text-white`}>Char: {isGlobalCharOverridden ? 'Custom' : 'Global'}</span></div>}
                     
                     {/* Global Preview Badge */}
                     {!activeCut && <div className="absolute top-4 left-4 bg-purple-900/80 text-purple-200 px-3 py-1 rounded-full text-xs font-bold z-30 pointer-events-none shadow-lg border border-purple-500/50">Global Preview Mode</div>}

                     {/* Overlays */}
                     {activeCut && (activeCut.status === 'generating' || activeCut.status === 'polling') && <div className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center z-40 backdrop-blur-sm"><div className="w-64 bg-zinc-800 h-2 rounded-full mb-4 overflow-hidden"><div className="h-full bg-blue-500 transition-all duration-300" style={{width: `${activeCut.progress || 0}%`}}/></div><div className="text-xl font-bold text-white mb-2">{activeCut.statusMessage || "Processing..."}</div><div className="flex items-center gap-2 text-zinc-400 font-mono text-sm"><Clock size={14} /> <StatusTimer startTime={activeCut.startTime} status={activeCut.status} /></div></div>}
                     {activeCut && activeCut.status === 'error' && <div className="absolute inset-0 bg-red-900/90 flex flex-col items-center justify-center z-40 p-8 text-center"><AlertCircle size={48} className="text-red-300 mb-4" /><h3 className="text-xl font-bold text-white mb-2">Generation Failed</h3><p className="text-red-200 mb-6">{activeCut.error}</p>{activeCut.error?.includes("DAILY QUOTA") && <div className="flex flex-col gap-2"><button onClick={()=>{ setIsTestMode(true); generateCutVideo(activeCut.cut_id); }} className="px-4 py-2 bg-white text-red-900 rounded font-bold hover:bg-gray-200">Switch to Test Mode & Retry</button><a href="https://console.cloud.google.com/apis/api/generativelanguage.googleapis.com/quotas" target="_blank" rel="noreferrer" className="text-xs text-red-300 underline mt-2">Check Google Cloud Quotas</a></div>}</div>}
                 </div>
             ) : <div className="text-zinc-600">Select a cut or Upload Global Assets</div>}
          </div>

          {/* Generate Button Bar */}
          <div className="h-12 bg-zinc-900 border-t border-zinc-800 flex items-center justify-center px-4">
              {activeCut && (
                   <button onClick={() => activeCut.status === 'generating' ? null : generateCutVideo(activeCut.cut_id)} className={`w-full max-w-lg h-9 rounded font-bold text-sm flex items-center justify-center gap-2 shadow-lg transition-transform active:scale-95 ${activeCut.status === 'generating' ? 'bg-zinc-700 text-zinc-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-500 text-white'}`}>
                       {activeCut.status === 'generating' ? <Loader2 className="animate-spin" size={14}/> : <Play fill="currentColor" size={14}/>} {activeCut.status === 'generating' ? 'Processing...' : 'Generate This Cut'}
                   </button>
              )}
          </div>

          {/* Bottom Panel */}
          <div className="h-64 bg-zinc-900 border-t border-zinc-800 flex flex-col">
              {activeCut && (
                  <>
                  <div className="h-10 border-b border-zinc-800 flex items-center justify-between px-4 bg-zinc-950/50">
                       <div className="flex gap-1">{['background', 'character', 'history', 'recent'].map(tab => (<button key={tab} onClick={()=>setActiveAssetTab(tab as any)} className={`px-4 py-1 text-xs font-bold uppercase tracking-wider ${activeAssetTab===tab ? 'text-blue-400 border-b-2 border-blue-400' : 'text-zinc-500 hover:text-zinc-300'}`}>{tab}</button>))}</div>
                       {activeAssetTab === 'character' && (
                           <div className="flex items-center gap-4">
                               <div className="flex items-center gap-2"><span className="text-[10px] font-bold text-zinc-500">SCALE</span><input type="range" min="0.1" max="3" step="0.1" value={activeCut.composition?.character_scale ?? project.global_character_scale ?? 1} onChange={(e)=>updateCutState(activeCut.cut_id, {composition:{...activeCut.composition!, character_scale: parseFloat(e.target.value)}})} className="w-20 accent-blue-600 h-1 bg-zinc-700 rounded-full"/></div>
                               <select value={activeCut.composition?.chroma_key || project.global_chroma_key || 'none'} onChange={(e)=>updateCutState(activeCut.cut_id, {composition:{...activeCut.composition!, chroma_key: e.target.value as any}})} className="bg-zinc-800 border-zinc-700 rounded text-xs px-2 py-1 font-medium"><option value="none">Normal</option><option value="white">Remove White</option><option value="green">Remove Green</option></select>
                           </div>
                       )}
                       <div className="flex items-center gap-2"><span className="text-[10px] font-bold text-zinc-500">LAYOUTS</span><button onClick={()=>{const name = prompt("Preset Name?"); if(name && activeCut.composition) {const preset = { id: Date.now().toString(), name, data: activeCut.composition }; setProject(p => ({...p, compositionPresets: [...p.compositionPresets, preset]}));}}} className="p-1 hover:text-white bg-zinc-800 rounded"><Plus size={12}/></button>{project.compositionPresets.map(p => (<button key={p.id} onClick={()=>updateCutState(activeCut.cut_id, {composition: p.data})} className="px-2 py-0.5 bg-zinc-800 rounded text-[10px] hover:bg-zinc-700 font-medium">{p.name}</button>))}</div>
                  </div>
                  <div className="flex-1 overflow-x-auto p-4 bg-zinc-900">
                       <div className="flex gap-3 h-full">
                           {activeAssetTab !== 'history' && activeAssetTab !== 'recent' && <label className="min-w-[140px] border border-dashed border-zinc-700 rounded-lg flex flex-col items-center justify-center hover:bg-zinc-800 cursor-pointer transition-colors group"><Upload className="mb-2 text-zinc-600 group-hover:text-zinc-400" size={24}/><span className="text-xs font-bold text-zinc-600 group-hover:text-zinc-400">Upload Asset</span><input type="file" className="hidden" onChange={(e)=>{const f=e.target.files?.[0]; if(f){const r=new FileReader(); r.onload=ev=>addAsset(ev.target?.result as string); r.readAsDataURL(f);}}}/></label>}
                           {activeAssetTab === 'character' && <div onClick={()=>updateCutState(activeCut.cut_id, {composition:{...activeCut.composition!, character_asset: undefined}})} className="min-w-[140px] border border-blue-900/50 bg-blue-900/10 rounded-lg flex flex-col items-center justify-center cursor-pointer hover:bg-blue-900/20 text-blue-400 transition-colors"><User size={24} className="mb-2"/><span className="text-xs font-bold">Use Global</span></div>}
                           
                           {(activeAssetTab === 'background' || activeAssetTab === 'character') && project.assets.map((asset, i) => { const isSel = activeAssetTab === 'background' ? activeCut.composition?.background_asset === asset : activeCut.composition?.character_asset === asset; return (<div key={i} onClick={()=>{if(activeAssetTab==='background') updateCutState(activeCut.cut_id, {composition:{...activeCut.composition!, background_asset: asset}}); else updateCutState(activeCut.cut_id, {composition:{...activeCut.composition!, character_asset: asset}});}} className={`min-w-[200px] h-full rounded-lg bg-zinc-950 border-2 overflow-hidden relative cursor-pointer transition-all ${isSel ? 'border-blue-500 shadow-md shadow-blue-900/20' : 'border-zinc-800 hover:border-zinc-600'}`}><img src={asset} className="w-full h-full object-contain" />{isSel && <div className="absolute top-2 right-2 bg-blue-500 text-white rounded-full p-0.5 shadow-sm"><CheckCircle size={14}/></div>}</div>)})}
                           
                           {activeAssetTab === 'history' && activeCut.history?.map(h => (<div key={h.id} onClick={()=>{if(h.type==='video') updateCutState(activeCut.cut_id, {videoUrl: h.url, status: 'completed'}); else updateCutState(activeCut.cut_id, {composition:{...activeCut.composition!, background_asset: h.url}});}} className="min-w-[200px] h-full rounded-lg bg-zinc-950 border border-zinc-800 relative group cursor-pointer overflow-hidden hover:border-zinc-600 transition-colors">{h.type==='video' ? <video src={h.url} className="w-full h-full object-cover"/> : <img src={h.url} className="w-full h-full object-cover"/>}<div className="absolute bottom-0 left-0 right-0 bg-black/70 p-1.5 text-[10px] text-zinc-300 truncate font-mono">{new Date(h.timestamp).toLocaleTimeString()}</div><div className={`absolute top-2 right-2 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${h.type==='video'?'bg-purple-900 text-purple-200':'bg-blue-900 text-blue-200'}`}>{h.type}</div></div>))}

                           {activeAssetTab === 'recent' && allCuts.flatMap(c => (c.history || []).map(h => ({...h, cutId: c.cut_id}))).sort((a,b) => b.timestamp - a.timestamp).map((h: any) => (<div key={h.id} className="min-w-[200px] h-full rounded-lg bg-zinc-950 border border-zinc-800 relative group overflow-hidden"><span className="absolute top-2 left-2 bg-black/70 text-white text-[10px] px-1.5 py-0.5 rounded z-10">{h.cutId}</span>{h.type==='video' ? <video src={h.url} className="w-full h-full object-cover" controls/> : <img src={h.url} className="w-full h-full object-cover"/>}<div className="absolute bottom-0 left-0 right-0 bg-black/70 p-1.5 text-[10px] text-zinc-300 truncate font-mono">{new Date(h.timestamp).toLocaleTimeString()}</div></div>))}
                       </div>
                  </div>
                  </>
              )}
          </div>
      </main>

      {/* Modals and Toasts */}
      {showImportModal && (
          <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
              <div className="bg-zinc-900 w-full max-w-2xl rounded-xl border border-zinc-800 shadow-2xl flex flex-col h-[80vh]">
                  <div className="p-4 border-b border-zinc-800 flex justify-between"><h2 className="font-bold">Import JSON</h2><button onClick={()=>setShowImportModal(false)}><X/></button></div>
                  <div className="flex-1 p-4 flex flex-col gap-4">
                      <div className="flex gap-2">
                         <label className="px-3 py-1.5 bg-zinc-800 rounded text-xs cursor-pointer hover:bg-zinc-700 font-medium">Upload JSON File <input type="file" className="hidden" accept=".json" onChange={(e)=>{
                             const f=e.target.files?.[0]; if(f){const r=new FileReader(); r.onload=ev=>setImportJsonText(ev.target?.result as string); r.readAsText(f);}
                         }}/></label>
                         <button onClick={()=>{const b=new Blob([importJsonText],{type:'application/json'}); const u=URL.createObjectURL(b); const a=document.createElement('a'); a.href=u; a.download='project.json'; a.click();}} className="px-3 py-1.5 bg-zinc-800 rounded text-xs hover:bg-zinc-700 font-medium">Save JSON</button>
                      </div>
                      <textarea className="flex-1 bg-zinc-950 border border-zinc-800 rounded p-3 text-xs font-mono text-zinc-300" value={importJsonText} onChange={e=>setImportJsonText(e.target.value)} placeholder="Paste JSON..."/>
                  </div>
                  <div className="p-4 border-t border-zinc-800 flex justify-end"><button onClick={()=>{
                      try {
                          const d = JSON.parse(importJsonText.replace(/```json/g, '').replace(/```/g, ''));
                          let scenes: Scene[] = [];
                          if (d.video_sequence_data) {
                              const groups: {[key:string]: any[]} = {};
                              d.video_sequence_data.forEach((c:any) => {
                                  const sTitle = c.scene_title || 'Scene 1';
                                  if(!groups[sTitle]) groups[sTitle] = [];
                                  groups[sTitle].push(c);
                              });
                              
                              Object.keys(groups).forEach((title, idx) => {
                                  scenes.push({
                                      scene_id: `s_${idx}`,
                                      scene_title: title,
                                      cuts: groups[title].map((c:any) => ({
                                          cut_id: `cut_${c.cut_id}`, time_code: c.time_code, 
                                          prompts: { global_anchor: c.full_combined_prompt||"", start_state: c.pre_roll_context||"", action_prompt: c.action_instruction||c.action_only_prompt||""},
                                          status:'idle', composition: {}
                                      }))
                                  });
                              });
                              if (scenes.length === 0) {
                                   scenes = [{ scene_id: 's1', scene_title: 'Scene 1', cuts: d.video_sequence_data.map((c:any)=>({
                                      cut_id: `cut_${c.cut_id}`, time_code: c.time_code, 
                                      prompts: { global_anchor: c.full_combined_prompt||"", start_state: c.pre_roll_context||"", action_prompt: c.action_instruction||c.action_only_prompt||""},
                                      status:'idle', composition: {} 
                                  }))}];
                              }
                          } else if (d.scenes) {
                              scenes = d.scenes;
                          }
                          setProject(p=>({...p, scenes, global_prompts: d.reference_image_generation || {}}));
                          setShowImportModal(false); addToast("Imported!", 'success');
                      } catch(e){ setImportError("Invalid JSON"); }
                  }} className="px-4 py-2 bg-blue-600 text-white rounded font-bold hover:bg-blue-500">Import Project</button></div>
              </div>
          </div>
      )}

      {showImgGenModal && (
          <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
              <div className="bg-zinc-900 w-full max-w-2xl rounded-xl border border-zinc-800 shadow-2xl relative overflow-hidden flex flex-col max-h-[90vh]">
                  {isImgGenLoading && <div className="absolute inset-0 bg-black/80 z-20 flex flex-col items-center justify-center gap-4"><Loader2 size={48} className="animate-spin text-purple-500"/><button onClick={()=>imgGenAbortControllerRef.current?.abort()} className="px-4 py-2 bg-red-600 rounded text-white font-bold hover:bg-red-500">Stop Generation</button></div>}
                  <div className="p-4 border-b border-zinc-800 flex justify-between"><h2 className="font-bold">AI Image Gen</h2><button onClick={()=>setShowImgGenModal(false)}><X/></button></div>
                  <div className="p-4 overflow-y-auto flex-1 space-y-4">
                       <div className="flex gap-4 p-2 bg-zinc-800/30 rounded border border-zinc-800">
                           <label className="flex items-center gap-2 font-medium cursor-pointer"><input type="checkbox" checked={imgGenBatchMode} onChange={e=>setImgGenBatchMode(e.target.checked)}/> Batch Mode (From Cuts)</label>
                           <label className="flex items-center gap-2 font-medium cursor-pointer"><input type="checkbox" checked={imgGenGreenScreen} onChange={e=>setImgGenGreenScreen(e.target.checked)}/> Green Screen Mode</label>
                       </div>
                       
                       {imgGenBatchMode && (
                           <div className="h-40 border border-zinc-800 rounded bg-zinc-950 p-2 overflow-y-auto grid grid-cols-2 gap-2">
                               {project.scenes.map(s => (
                                   <div key={s.scene_id} className="col-span-2">
                                       <div className="text-xs font-bold text-zinc-500 mb-1 px-1 uppercase">{s.scene_title}</div>
                                       <div className="grid grid-cols-2 gap-2">
                                           {s.cuts.map(c => (
                                               <label key={c.cut_id} className="flex items-center gap-2 text-xs p-2 bg-zinc-900 hover:bg-zinc-800 rounded cursor-pointer border border-zinc-800">
                                                   <input type="checkbox" checked={imgGenSelection.has(c.cut_id)} onChange={()=>{setImgGenSelection(p=>{const n=new Set(p); n.has(c.cut_id)?n.delete(c.cut_id):n.add(c.cut_id); return n;})}}/> 
                                                   <span className="truncate">{c.cut_id}</span>
                                               </label>
                                           ))}
                                       </div>
                                   </div>
                               ))}
                           </div>
                       )}

                       <div className="flex gap-4">
                           <div className="flex-1 space-y-2">
                               <span className="text-xs font-bold text-zinc-500">BACKGROUND REF</span>
                               <div className="h-24 border border-dashed border-zinc-700 rounded flex items-center justify-center relative hover:bg-zinc-800 cursor-pointer">
                                   {imgGenBgRef ? <img src={imgGenBgRef} className="w-full h-full object-contain"/> : <span className="text-xs text-zinc-500 font-bold">Drop Image</span>}
                                   <input type="file" className="absolute inset-0 opacity-0 cursor-pointer" onChange={e=>{const f=e.target.files?.[0]; if(f){const r=new FileReader(); r.onload=ev=>setImgGenBgRef(ev.target?.result as string); r.readAsDataURL(f);}}}/>
                               </div>
                           </div>
                           <div className="flex-1 space-y-2">
                               <span className="text-xs font-bold text-zinc-500">CHARACTER REF</span>
                               <div className="h-24 border border-dashed border-zinc-700 rounded flex items-center justify-center relative hover:bg-zinc-800 cursor-pointer">
                                   {imgGenCharRef ? <img src={imgGenCharRef} className="w-full h-full object-contain"/> : <span className="text-xs text-zinc-500 font-bold">Drop Image</span>}
                                   <input type="file" className="absolute inset-0 opacity-0 cursor-pointer" onChange={e=>{const f=e.target.files?.[0]; if(f){const r=new FileReader(); r.onload=ev=>setImgGenCharRef(ev.target?.result as string); r.readAsDataURL(f);}}}/>
                               </div>
                           </div>
                       </div>

                       <textarea className="w-full h-24 bg-zinc-950 border border-zinc-800 rounded p-3 text-sm focus:border-purple-500 outline-none transition-colors" placeholder="Enter Prompt..." value={imgGenPrompt} onChange={e=>setImgGenPrompt(e.target.value)}/>
                  </div>
                  <div className="p-4 border-t border-zinc-800 flex justify-end"><button onClick={handleGenerateImage} className="px-6 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded font-bold shadow-lg shadow-purple-900/20">Generate Image</button></div>
              </div>
          </div>
      )}

      {showTheater && (
          <div className="fixed inset-0 bg-black z-[100] flex flex-col">
              <div className="h-16 flex items-center justify-between px-8 absolute top-0 w-full z-10 bg-gradient-to-b from-black/80 to-transparent">
                   <h2 className="text-xl font-bold text-white tracking-widest">THEATER MODE</h2>
                   <button onClick={() => setShowTheater(false)} className="text-white/70 hover:text-white"><X size={32}/></button>
              </div>
              <div className="flex-1 flex items-center justify-center bg-black">
                  {allCuts[theaterCutIndex]?.videoUrl ? (
                       allCuts[theaterCutIndex].videoUrl!.startsWith('data:image') ? (
                           <img 
                               src={allCuts[theaterCutIndex].videoUrl} 
                               className="max-w-full max-h-full aspect-video object-contain" 
                               onLoad={() => { setTimeout(() => { if (theaterCutIndex < allCuts.length - 1) setTheaterCutIndex(prev => prev + 1); }, 3000); }}
                           />
                       ) : (
                           <video 
                             src={allCuts[theaterCutIndex].videoUrl} 
                             className="max-w-full max-h-full aspect-video" 
                             controls 
                             autoPlay 
                             onEnded={() => { if (theaterCutIndex < allCuts.length - 1) { setTheaterCutIndex(prev => prev + 1); } }}
                           />
                       )
                  ) : <div className="text-zinc-500">Cut {theaterCutIndex + 1} not generated yet</div>}
              </div>
              <div className="h-24 bg-zinc-900/90 border-t border-zinc-800 flex items-center gap-4 px-8 overflow-x-auto">
                   {allCuts.map((cut, i) => (
                       <div key={cut.cut_id} onClick={() => setTheaterCutIndex(i)} className={`min-w-[100px] h-16 rounded border-2 cursor-pointer relative overflow-hidden ${theaterCutIndex === i ? 'border-blue-500' : 'border-zinc-700 opacity-50 hover:opacity-100'}`}>
                           {cut.videoUrl ? (cut.videoUrl.startsWith('data:image') ? <img src={cut.videoUrl} className="w-full h-full object-cover" /> : <video src={cut.videoUrl} className="w-full h-full object-cover" />) : <div className="w-full h-full bg-zinc-800 flex items-center justify-center text-xs text-zinc-500">Pending</div>}
                           <div className="absolute bottom-0 left-0 bg-black/60 px-1 text-[10px] text-white">{cut.cut_id}</div>
                       </div>
                   ))}
              </div>
          </div>
      )}

      {/* Toasts */}
      <div className="fixed bottom-6 right-6 flex flex-col gap-2 z-[100]">
          {toasts.map(t => (
              <div key={t.id} className={`px-4 py-3 rounded shadow-xl border flex items-center gap-2 animate-in slide-in-from-right-10 ${t.type==='error'?'bg-red-900 border-red-700':t.type==='success'?'bg-green-900 border-green-700':'bg-zinc-800 border-zinc-700'}`}>
                  {t.type==='error'?<AlertCircle size={16}/>:<CheckCircle size={16}/>} <span className="text-sm font-medium">{t.message}</span>
              </div>
          ))}
      </div>
    </div>
  );
};

export default App;