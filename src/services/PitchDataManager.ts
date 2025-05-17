import { PitchDetector } from 'pitchy';

export interface PitchData {
  times: number[];
  pitches: (number | null)[];
}

const MIN_PITCH = 60;
const MAX_PITCH = 500;
const MIN_CLARITY = 0.6;
const MEDIAN_FILTER_SIZE = 10;

// Median filter for smoothing
function medianFilter(arr: (number | null)[], windowSize: number): (number | null)[] {
  const result: (number | null)[] = [];
  for (let i = 0; i < arr.length; i++) {
    const window: number[] = [];
    for (let j = Math.max(0, i - Math.floor(windowSize / 2)); j <= Math.min(arr.length - 1, i + Math.floor(windowSize / 2)); j++) {
      if (arr[j] !== null && !isNaN(arr[j]!)) window.push(arr[j]!);
    }
    if (window.length > 0) {
      window.sort((a, b) => a - b);
      result.push(window[Math.floor(window.length / 2)]);
    } else {
      result.push(null);
    }
  }
  return result;
}

// Enhanced smoothing for pitch data to create more simplified curves
function smoothPitch(pitches: (number | null)[], windowSize = 25): (number | null)[] {
  // First apply a strong median filter to remove outliers and noise
  const medianSmoothed = medianFilter(pitches, windowSize);
  
  // Then apply a moving average to create smoother transitions
  const result: (number | null)[] = [];
  const halfWindow = Math.floor(windowSize / 2);
  
  for (let i = 0; i < medianSmoothed.length; i++) {
    if (medianSmoothed[i] === null) {
      result.push(null);
      continue;
    }
    
    let sum = 0;
    let count = 0;
    
    // Calculate weighted moving average
    for (let j = Math.max(0, i - halfWindow); j <= Math.min(medianSmoothed.length - 1, i + halfWindow); j++) {
      if (medianSmoothed[j] !== null) {
        // Apply weight based on distance from center point (gaussian-like)
        const weight = 1 - Math.abs(i - j) / (halfWindow + 1);
        sum += (medianSmoothed[j] as number) * weight;
        count += weight;
      }
    }
    
    if (count > 0) {
      result.push(sum / count);
    } else {
      result.push(medianSmoothed[i]);
    }
  }
  
  return result;
}

export class PitchDataManager {
  private pitchData: PitchData = { times: [], pitches: [] };
  private audioContext: AudioContext;
  private currentFile: File | null = null;
  private totalDuration: number = 0;

  constructor() {
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }

  private async getFileDuration(file: File): Promise<number> {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const audio = new Audio(url);
      audio.addEventListener('loadedmetadata', () => {
        const duration = audio.duration;
        URL.revokeObjectURL(url);
        console.log('[PitchDataManager] Detected file duration:', duration, 'seconds');
        resolve(duration);
      });
      audio.addEventListener('error', () => {
        URL.revokeObjectURL(url);
        reject(new Error('Could not load audio file'));
      });
    });
  }

  async initialize(file: File) {
    // Reset all state when initializing with a new file
    this.pitchData = { times: [], pitches: [] };
    this.totalDuration = 0;
    this.currentFile = null;

    // Now initialize with the new file
    this.currentFile = file;
    this.totalDuration = await this.getFileDuration(file);
    
    // Process the entire file
    const fullPitchData = await this.processEntireFile(this.currentFile);
    this.pitchData = fullPitchData;
  }

  private async processEntireFile(file: File): Promise<PitchData> {
    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
    const channelData = audioBuffer.getChannelData(0);
    const sampleRate = audioBuffer.sampleRate;
    const frameSize = 2048;
    const hopSize = 256;
    const detector = PitchDetector.forFloat32Array(frameSize);
    const pitches: (number | null)[] = [];
    const times: number[] = [];

    // Process all frames, including the last one
    for (let i = 0; i <= channelData.length - 1; i += hopSize) {
      try {
        let frame: Float32Array;
        
        // Check if we need to pad the frame
        if (i + frameSize > channelData.length) {
          // We're at the end, create a padded frame
          const remainingSamples = channelData.length - i;
          frame = new Float32Array(frameSize);
          
          // Copy the remaining samples
          frame.set(channelData.slice(i, channelData.length));
          
          // Pad with zeros (or last value if we want to avoid discontinuities)
          const lastValue = channelData[channelData.length - 1] || 0;
          for (let j = remainingSamples; j < frameSize; j++) {
            frame[j] = lastValue; // Alternatively, use 0 here
          }
          
          console.log(`[PitchDataManager] Created padded frame at end of file: ${remainingSamples}/${frameSize} samples`);
        } else {
          // Regular frame, no padding needed
          frame = channelData.slice(i, i + frameSize);
        }
        
        const [pitch, clarity] = detector.findPitch(frame, sampleRate);
        if (pitch >= MIN_PITCH && pitch <= MAX_PITCH && clarity >= MIN_CLARITY) {
          pitches.push(pitch);
        } else {
          pitches.push(null);
        }
        times.push(i / sampleRate);
        
        // If we're processing a padded frame at the end, stop after this iteration
        if (i + frameSize > channelData.length) {
          break;
        }
      } catch (frameError: unknown) {
        const errorMessage = frameError instanceof Error ? frameError.message : String(frameError);
        console.warn(`[PitchDataManager] Error processing frame at position ${i}: ${errorMessage}`);
        // Add a null pitch for this position to maintain time alignment
        times.push(i / sampleRate);
        pitches.push(null);
      }
    }

    // Apply standard median filter first
    const medianSmoothed = medianFilter(pitches, MEDIAN_FILTER_SIZE);
    
    // Then apply enhanced smoothing for more simplified curves
    const enhancedSmooth = smoothPitch(medianSmoothed, 25);
    
    return { times, pitches: enhancedSmooth };
  }

  getPitchDataForTimeRange(startTime: number, endTime: number): PitchData {
    const startIdx = this.pitchData.times.findIndex(t => t >= startTime);
    const endIdx = this.pitchData.times.findIndex(t => t > endTime);
    return {
      times: this.pitchData.times.slice(startIdx, endIdx),
      pitches: this.pitchData.pitches.slice(startIdx, endIdx)
    };
  }

  getTotalDuration(): number {
    return this.totalDuration;
  }

} 