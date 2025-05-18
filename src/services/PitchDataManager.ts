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

    try {
      // Calculate segment bounds with 1s buffer on each side
      let startTime = Math.max(0, currentTime - 0.5 - 1); // 0.5s offset + 1s buffer
      let endTime = Math.min(this.totalDuration, currentTime + 19.5 + 1); // + 1s buffer

      // Adjust for edge cases
      if (startTime === 0) {
        // Near start: extend forward
        endTime = Math.min(this.totalDuration, 22); // 20s + 2s buffer
      } else if (endTime === this.totalDuration) {
        // Near end: extend backward
        startTime = Math.max(0, this.totalDuration - 22); // 20s + 2s buffer
      }

      // Always log segment boundaries
      console.log('[PitchDataManager] Extracting segment:', {
        currentTime,
        startTime,
        endTime,
        duration: endTime - startTime
      });

      // Store current segment boundaries (excluding the 1s buffers for display purposes)
      const displayStartTime = startTime + 1;
      const displayEndTime = endTime - 1;
      this.currentSegment = { 
        startTime: displayStartTime > 0 ? displayStartTime : 0, 
        endTime: displayEndTime < this.totalDuration ? displayEndTime : this.totalDuration 
      };

      // Clear previous data
      this.pitchData = { times: [], pitches: [] };

      // Process the segment - we'll use the original file for this
      // This is more reliable than trying to capture from the media element
      const file = this.currentFile;
      const arrayBuffer = await file.arrayBuffer();
      const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer.slice(0, 2000000000)); // Stay under 2GB limit
      const channelData = audioBuffer.getChannelData(0);
      const sampleRate = audioBuffer.sampleRate;

      // Calculate sample indices for this segment
      // If we can't fit the entire segment in memory, we'll just process what we can
      const maxSampleIndex = channelData.length - 1;
      const startSample = Math.min(Math.floor(startTime * sampleRate), maxSampleIndex);
      const endSample = Math.min(Math.floor(endTime * sampleRate), maxSampleIndex);
      
      console.log('[PitchDataManager] Processing samples:', {
        sampleRate,
        startSample,
        endSample,
        maxIndex: maxSampleIndex,
        expectedDuration: (endSample - startSample) / sampleRate
      });

      // Use a larger hop size to process faster
      const frameSize = 2048;
      const hopSize = 2048; // Larger hop size = faster processing, fewer data points
      const detector = PitchDetector.forFloat32Array(frameSize);
      const pitches: (number | null)[] = [];
      const times: number[] = [];

      // Process samples at regular intervals
      for (let i = startSample; i < endSample; i += hopSize) {
        // Create a frame for analysis
        let frame: Float32Array;
        
        if (i + frameSize > endSample) {
          // Create padded frame for end of segment
          frame = new Float32Array(frameSize);
          const remainingSamples = endSample - i;
          if (remainingSamples > 0) {
            frame.set(channelData.slice(i, endSample));
            // Pad with last value
            const lastValue = channelData[endSample - 1] || 0;
            for (let j = remainingSamples; j < frameSize; j++) {
              frame[j] = lastValue;
            }
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
        
        // Normalize time values for display - make them relative to segment start
        // This makes the graph show a 0-20s range instead of the actual video times
        const normalizedTime = (i - startSample) / sampleRate;
        times.push(normalizedTime);
      }
      
      console.log('[PitchDataManager] Extraction complete:', {
        frames: times.length,
        duration: times.length > 0 ? times[times.length - 1] : 0
      });

      // If no data was collected, throw an error
      if (times.length === 0) {
        throw new Error('No pitch data collected during extraction');
      }
      
      // Scale the time values to match the 0-20s range exactly
      const normalizedTimes = times.map(t => {
        return t * (20 / (endTime - startTime));
      });
      
      // Apply standard median filter first
      const medianSmoothed = medianFilter(pitches, MEDIAN_FILTER_SIZE);
      
      // Then apply enhanced smoothing for more simplified curves
      const enhancedSmooth = smoothPitch(medianSmoothed, 25);
      
      // Log the final time range
      console.log('[PitchDataManager] Processed segment data:', {
        timePoints: normalizedTimes.length,
        timeRange: normalizedTimes.length > 0 ? {
          first: normalizedTimes[0],
          last: normalizedTimes[normalizedTimes.length - 1],
          span: normalizedTimes[normalizedTimes.length - 1] - normalizedTimes[0]
        } : 'no data',
        actualVideoRange: {
          start: startTime,
          end: endTime,
          displayStart: this.currentSegment.startTime,
          displayEnd: this.currentSegment.endTime
        }
      });
      
      // Update the segment data
      this.pitchData = {
        times: normalizedTimes,
        pitches: enhancedSmooth
      };
      
    } catch (error) {
      console.error('[PitchDataManager] Error extracting segment:', error);
      // Reset segment if there was an error
      this.currentSegment = null;
      // Re-throw so the UI can show an error
      throw error;
    }
  }

  // Add method to check if this is a long video
  isLongVideoFile(): boolean {
    return this.isLongVideo;
  }

  // Method to convert a normalized time (0-20s display time) to actual video time
  normalizedToVideoTime(normalizedTime: number): number {
    if (!this.isLongVideo || !this.currentSegment) return normalizedTime;
    return this.currentSegment.startTime + normalizedTime;
  }

  // Method to convert actual video time to normalized display time
  videoToNormalizedTime(videoTime: number): number {
    if (!this.isLongVideo || !this.currentSegment) return videoTime;
    return Math.max(0, videoTime - this.currentSegment.startTime);
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

  // Get segment duration for pitch graph display
  getSegmentDuration(): number {
    if (!this.isLongVideo || !this.currentSegment) return this.totalDuration;
    return this.currentSegment.endTime - this.currentSegment.startTime;
  }
} 