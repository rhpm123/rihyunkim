
export type GenerationStatus = 'idle' | 'queued' | 'generating' | 'polling' | 'downloading' | 'completed' | 'error';

export interface Prompts {
  global_anchor: string;
  start_state: string;
  action_prompt: string;
}

export interface CompositionState {
  background_asset?: string;
  character_asset?: string;
  character_scale: number;
  character_x: number;
  character_y: number;
  remove_background: boolean;
}

export interface Cut {
  cut_id: string;
  time_code: string;
  prompts: Prompts;
  status: GenerationStatus;
  videoUrl?: string;
  error?: string;
  progress?: number; // For polling visuals
  statusMessage?: string; // Detailed logs (e.g. "Uploading...", "Cooling down...")
  startTime?: number; // Timestamp when generation started
  composition?: CompositionState; // Layered composition state
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
  global_image?: string; // Data URL for the default background
  global_prompts?: { [key: string]: string }; // Store separate master prompts
  assets: string[]; // Library of all available image assets
}

export interface GeneratedVideo {
  url: string;
  prompt: string;
}
