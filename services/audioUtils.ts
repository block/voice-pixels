/**
 * Audio processing utilities for Gemini Live API
 * Handles conversions between Float32 Web Audio and Int16 PCM 16kHz
 */

export const PCM_SAMPLE_RATE = 16000;

// Convert Float32Array (Web Audio) to Int16Array (PCM) and downsample if needed
export function floatTo16BitPCM(float32Array: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

// Base64 encode ArrayBuffer
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Base64 decode to ArrayBuffer
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

// Resample audio buffer to target sample rate
export function resampleAudioBuffer(
  audioBuffer: AudioBuffer,
  targetSampleRate: number,
  audioContext: AudioContext
): Promise<AudioBuffer> {
  return new Promise(async (resolve) => {
    const numChannels = audioBuffer.numberOfChannels;
    const offlineContext = new OfflineAudioContext(
      numChannels,
      (audioBuffer.length * targetSampleRate) / audioBuffer.sampleRate,
      targetSampleRate
    );

    const bufferSource = offlineContext.createBufferSource();
    bufferSource.buffer = audioBuffer;
    bufferSource.connect(offlineContext.destination);
    bufferSource.start(0);
    const renderedBuffer = await offlineContext.startRendering();
    resolve(renderedBuffer);
  });
}

// Create a blob from raw PCM data for transmission
export function createPcmBlob(data: Float32Array): { data: string; mimeType: string } {
  // Simple downsampling if input is not 16k is hard to do synchronously efficiently 
  // without a proper resampler algorithm. 
  // For this demo, we assume the input context is close to compatible or rely on the 
  // processor to just grab chunks. Ideally, we use a resampler.
  
  // Simple decimation if context is 48k or 44.1k to 16k is often done, 
  // but for the Live API, providing 16k source is best.
  
  // We will just convert whatever we get to Int16. 
  // If the source is 48k, the model receives 48k PCM but expects 16k, which slows down audio.
  // *CRITICAL*: The AudioContext in `useLiveSession` MUST be initialized at 16000Hz.
  
  const pcmBuffer = floatTo16BitPCM(data);
  return {
    data: arrayBufferToBase64(pcmBuffer),
    mimeType: 'audio/pcm;rate=16000',
  };
}

export async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number = 24000,
  numChannels: number = 1,
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}
