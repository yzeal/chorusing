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
  private isLongVideo: boolean = false;
  private currentSegment: { startTime: number; endTime: number } | null = null;

  constructor() {
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }

  // Add getter for current segment boundaries
  getCurrentSegment(): { startTime: number; endTime: number } | null {
    return this.currentSegment;
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
    this.currentSegment = null;

    // Now initialize with the new file
    this.currentFile = file;
    this.totalDuration = await this.getFileDuration(file);
    this.isLongVideo = this.totalDuration > 30;
    
    // For short videos, process the entire file
    if (!this.isLongVideo) {
      const fullPitchData = await this.processEntireFile(file);
      this.pitchData = fullPitchData;
    }
    // For long videos, don't process anything initially
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

  async extractSegment(currentTime: number): Promise<void> {
    if (!this.currentFile || !this.isLongVideo) return;

    // Calculate segment bounds
    let startTime = Math.max(0, currentTime - 2);
    let endTime = Math.min(this.totalDuration, currentTime + 18);

    // Adjust for edge cases
    if (startTime === 0) {
      // Near start: extend forward
      endTime = Math.min(this.totalDuration, 20);
    } else if (endTime === this.totalDuration) {
      // Near end: extend backward
      startTime = Math.max(0, this.totalDuration - 20);
    }

    // Always log segment boundaries
    console.log('[PitchDataManager] Extracting segment:', {
      currentTime,
      startTime,
      endTime,
      duration: endTime - startTime
    });

    // Store current segment boundaries
    this.currentSegment = { startTime, endTime };

    // Clear previous data
    this.pitchData = { times: [], pitches: [] };

    // Process the segment
    const file = this.currentFile;
    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
    const channelData = audioBuffer.getChannelData(0);
    const sampleRate = audioBuffer.sampleRate;

    // Calculate sample indices for this segment
    const startSample = Math.floor(startTime * sampleRate);
    const endSample = Math.floor(endTime * sampleRate);
    
    console.log('[PitchDataManager] Processing samples:', {
      sampleRate,
      startSample,
      endSample,
      expectedDuration: (endSample - startSample) / sampleRate
    });

    const frameSize = 2048;
    const hopSize = 256;
    const detector = PitchDetector.forFloat32Array(frameSize);
    const pitches: (number | null)[] = [];
    const times: number[] = [];

    // Process all samples in this segment
    for (let i = startSample; i < endSample; i += hopSize) {
      let frame: Float32Array;
      
      if (i + frameSize > endSample) {
        // Create padded frame for end of segment
        frame = new Float32Array(frameSize);
        const remainingSamples = endSample - i;
        frame.set(channelData.slice(i, endSample));
        const lastValue = channelData[endSample - 1] || 0;
        for (let j = remainingSamples; j < frameSize; j++) {
          frame[j] = lastValue;
        }
      } else {
        frame = channelData.slice(i, i + frameSize);
      }

      const [pitch, clarity] = detector.findPitch(frame, sampleRate);
      if (pitch >= MIN_PITCH && pitch <= MAX_PITCH && clarity >= MIN_CLARITY) {
        pitches.push(pitch);
      } else {
        pitches.push(null);
      }
      // Store actual time relative to video start
      times.push(startTime + (i - startSample) / sampleRate);
    }

    // Apply standard median filter first
    const medianSmoothed = medianFilter(pitches, MEDIAN_FILTER_SIZE);
    
    // Then apply enhanced smoothing for more simplified curves
    const enhancedSmooth = smoothPitch(medianSmoothed, 25);
    
    // Log the final time range
    console.log('[PitchDataManager] Processed segment data:', {
      timePoints: times.length,
      timeRange: times.length > 0 ? {
        first: times[0],
        last: times[times.length - 1],
        span: times[times.length - 1] - times[0]
      } : 'no data'
    });

    // Update the segment data
    this.pitchData = {
      times,
      pitches: enhancedSmooth
    };
  }

  // Add method to check if this is a long video
  isLongVideoFile(): boolean {
    return this.isLongVideo;
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