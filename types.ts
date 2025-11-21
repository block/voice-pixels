export enum AppState {
  IDLE = 'IDLE',
  LISTENING = 'LISTENING',
  PROCESSING = 'PROCESSING',
  SPEAKING = 'SPEAKING',
  ERROR = 'ERROR'
}

export interface LogMessage {
  role: 'user' | 'model' | 'system';
  text: string;
  timestamp: number;
}

export interface HistoryItem {
  id: string;
  data: string; // Base64 string
  mimeType: string;
  timestamp: number;
  source: 'upload' | 'generated' | 'edited';
  sessionId: string;
  prompt?: string;
}

export interface Session {
  sessionId: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

// Kept for compatibility if needed, but App.tsx will switch to HistoryItem
export interface ImageState {
  data: string | null; 
  mimeType: string;
  loading: boolean;
}

// Audio types for Live API
export interface AudioWorkletMessage {
  type: 'data';
  buffer: Float32Array;
}