
export type GenerationStatus = 'idle' | 'queued' | 'generating' | 'polling' | 'downloading' | 'completed' | 'error';

export interface Prompts {
  global_anchor: string;
  start_state: string;
  action_prompt: string;
}

export interface CompositionState {
  background_asset?: string;
  character_asset?: string;
  character_scale?: number;
  character_x?: number;
  character_y?: number;
  background_x?: number;
  background_y?: number;
  chroma_key?: 'none' | 'white' | 'green';
}

export interface CompositionPreset {
  id: string;
  name: string;
  data: CompositionState;
}

export interface GeneratedAsset {
  id: string;
  type: 'image' | 'video';
  url: string;
  timestamp: number;
  prompt?: string;
}

export interface Cut {
  cut_id: string;
  time_code: string;
  prompts: Prompts;
  status: GenerationStatus;
  videoUrl?: string;
  error?: string;
  progress?: number; 
  statusMessage?: string; 
  startTime?: number; 
  composition?: CompositionState;
  history?: GeneratedAsset[]; // Log of generated content
}

export interface Scene {
  scene_id: string;
  scene_title: string;
  cuts: Cut[];
}

export interface ProjectSettings {
  resolution: string;
  cut_duration_seconds: number;
}

export interface Project {
  project_title: string;
  default_settings: ProjectSettings;
  scenes: Scene[];
  global_image?: string; 
  global_bg_scale?: number; 
  global_bg_x?: number;
  global_bg_y?: number;
  global_character_image?: string; 
  global_character_scale?: number; 
  global_character_x?: number;     
  global_character_y?: number;     
  global_chroma_key?: 'none' | 'white' | 'green'; 
  global_prompts?: { [key: string]: string }; 
  assets: string[]; 
  compositionPresets: CompositionPreset[]; 
}

export interface GeneratedVideo {
  url: string;
  prompt: string;
}
