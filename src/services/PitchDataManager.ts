import { PitchDetector } from 'pitchy';

export interface ProgressiveLoadingConfig {
  // If file duration is below this, load everything at once
  thresholdDuration: number;  // e.g., 30 seconds
  
  // Size of segments when loading progressively
  segmentDuration: number;    // e.g., 10 seconds
  
  // How many segments to load ahead of current view
  preloadSegments: number;    // e.g., 1 segment ahead
  
  // Keep this many segments in memory
  maxCachedSegments: number;  // e.g., 6 segments
}

export interface PitchSegment {
  startTime: number;
  endTime: number;
  times: number[];
  pitches: (number | null)[];
  isProcessed: boolean;
}

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
  private segments: Map<number, PitchSegment> = new Map();
  private config: ProgressiveLoadingConfig;
  private totalDuration: number = 0;
  private isProgressiveMode: boolean = false;
  private audioContext: AudioContext;
  private currentFile: File | null = null;

  constructor(config: ProgressiveLoadingConfig) {
    this.config = config;
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
    this.segments.clear();
    this.totalDuration = 0;
    this.isProgressiveMode = false;
    this.currentFile = null;

    // Now initialize with the new file
    this.currentFile = file;
    this.totalDuration = await this.getFileDuration(file);
    console.log('[PitchDataManager] File duration:', this.totalDuration, 'seconds');
    console.log('[PitchDataManager] Threshold duration:', this.config.thresholdDuration, 'seconds');
    
    this.isProgressiveMode = this.totalDuration > this.config.thresholdDuration;
    console.log('[PitchDataManager] Using progressive mode:', this.isProgressiveMode);

    if (!this.isProgressiveMode) {
      // Process entire file at once
      console.log('[PitchDataManager] Processing entire file at once');
      const fullPitchData = await this.processEntireFile(file);
      this.segments.set(0, {
        startTime: 0,
        endTime: this.totalDuration,
        times: fullPitchData.times,
        pitches: fullPitchData.pitches,
        isProcessed: true
      });
    } else {
      // Initialize segment map
      console.log('[PitchDataManager] Initializing segments for progressive loading');
      this.initializeSegments();
      
      // Load initial segments (first visible segment plus preload)
      console.log('[PitchDataManager] Loading initial segments');
      const initialEndSegment = Math.min(
        this.config.preloadSegments,
        Math.ceil(this.totalDuration / this.config.segmentDuration) - 1
      );
      for (let i = 0; i <= initialEndSegment; i++) {
        console.log(`[PitchDataManager] Processing initial segment ${i}`);
        await this.processSegment(i);
      }
    }
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

  private initializeSegments() {
    const numSegments = Math.ceil(this.totalDuration / this.config.segmentDuration);
    for (let i = 0; i < numSegments; i++) {
      const startTime = i * this.config.segmentDuration;
      this.segments.set(i, {
        startTime,
        endTime: Math.min(startTime + this.config.segmentDuration, this.totalDuration),
        times: [],
        pitches: [],
        isProcessed: false
      });
    }
  }

  async loadSegmentsForTimeRange(startTime: number, endTime: number) {
    if (!this.isProgressiveMode) {
      console.log('[PitchDataManager] Skipping segment load - not in progressive mode');
      return;
    }

    const startSegment = Math.floor(startTime / this.config.segmentDuration);
    const endSegment = Math.floor(endTime / this.config.segmentDuration);
    
    console.log(`[PitchDataManager] Loading segments ${startSegment} to ${endSegment} (${startTime}s to ${endTime}s)`);
    
    // Load visible segments plus preload
    for (let i = startSegment; i <= endSegment + this.config.preloadSegments; i++) {
      if (this.segments.has(i) && !this.segments.get(i)!.isProcessed) {
        console.log(`[PitchDataManager] Processing segment ${i}`);
        try {
          await this.processSegment(i);
        } catch (error: unknown) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.error(`[PitchDataManager] Error loading segment ${i}:`, errorMessage);
          
          // Mark as processed with empty data to prevent repeated errors
          const segment = this.segments.get(i);
          if (segment) {
            this.segments.set(i, {
              ...segment,
              times: [],
              pitches: [],
              isProcessed: true
            });
          }
        }
      }
    }

    // Cleanup old segments if needed
    this.cleanupOldSegments(startSegment);
  }

  private async processSegment(segmentIndex: number) {
    const segment = this.segments.get(segmentIndex);
    if (!segment || segment.isProcessed) return;

    const file = this.currentFile;
    if (!file) throw new Error('No file loaded');

    console.log(`[PitchDataManager] Processing segment ${segmentIndex} (${segment.startTime}s to ${segment.endTime}s)`);

    try {
      const arrayBuffer = await file.arrayBuffer();
      const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
      const channelData = audioBuffer.getChannelData(0);
      const sampleRate = audioBuffer.sampleRate;
      
      // Calculate sample indices for this segment
      const startSample = Math.floor(segment.startTime * sampleRate);
      const endSample = Math.floor(segment.endTime * sampleRate);
      
      console.log(`[PitchDataManager] Segment ${segmentIndex} samples: ${startSample} to ${endSample}`);
      
      const frameSize = 2048;
      const hopSize = 256;
      const detector = PitchDetector.forFloat32Array(frameSize);
      const pitches: (number | null)[] = [];
      const times: number[] = [];

      // Process all samples in this segment, including handling the end correctly
      for (let i = startSample; i < endSample; i += hopSize) {
        try {
          let frame: Float32Array;
          
          // Check if there are enough samples left in this segment for a full frame
          if (i + frameSize > endSample) {
            // If this is the last segment of the file and we're near the end
            if (segmentIndex === this.segments.size - 1 && i + frameSize > channelData.length) {
              // Create a padded frame for the end of the file
              const remainingSamples = channelData.length - i;
              frame = new Float32Array(frameSize);
              
              // Copy the remaining samples
              frame.set(channelData.slice(i, channelData.length));
              
              // Pad with zeros or last value
              const lastValue = channelData[channelData.length - 1] || 0;
              for (let j = remainingSamples; j < frameSize; j++) {
                frame[j] = lastValue;
              }
              
              console.log(`[PitchDataManager] Created padded frame at end of segment ${segmentIndex}: ${remainingSamples}/${frameSize} samples`);
            } else {
              // For non-final segments or if we still have enough samples in the buffer,
              // just read ahead into the next segment
              frame = channelData.slice(i, i + frameSize);
            }
          } else {
            // Regular frame, no special handling needed
            frame = channelData.slice(i, i + frameSize);
          }
          
          // Ensure we have a full frame
          if (frame.length === frameSize) {
            const [pitch, clarity] = detector.findPitch(frame, sampleRate);
            if (pitch >= MIN_PITCH && pitch <= MAX_PITCH && clarity >= MIN_CLARITY) {
              pitches.push(pitch);
            } else {
              pitches.push(null);
            }
            times.push(i / sampleRate);
          } else {
            console.warn(`[PitchDataManager] Skipping frame with unexpected length: ${frame.length}`);
          }
          
          // If we're processing a frame that extends beyond this segment's endSample,
          // or we've reached the end of the file, break after this iteration
          if (i + hopSize >= endSample || 
             (segmentIndex === this.segments.size - 1 && i + frameSize > channelData.length)) {
            break;
          }
        } catch (frameError: unknown) {
          const errorMessage = frameError instanceof Error ? frameError.message : String(frameError);
          console.warn(`[PitchDataManager] Error processing frame at position ${i}: ${errorMessage}`);
          // Add a null pitch for this position to maintain time alignment
          if (i / sampleRate >= segment.startTime && i / sampleRate <= segment.endTime) {
            times.push(i / sampleRate);
            pitches.push(null);
          }
        }
      }

      // Apply standard median filter first
      const medianSmoothed = medianFilter(pitches, MEDIAN_FILTER_SIZE);
      
      // Then apply enhanced smoothing for more simplified curves
      const enhancedSmooth = smoothPitch(medianSmoothed, 25);
      
      console.log(`[PitchDataManager] Segment ${segmentIndex} processed: ${pitches.length} points`);
      
      // Update the segment with processed data
      this.segments.set(segmentIndex, {
        ...segment,
        times,
        pitches: enhancedSmooth,
        isProcessed: true
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[PitchDataManager] Error processing segment ${segmentIndex}:`, errorMessage);
      
      // Mark segment as processed but with empty data to prevent repeated errors
      this.segments.set(segmentIndex, {
        ...segment,
        times: [],
        pitches: [],
        isProcessed: true
      });
    }
  }

  private cleanupOldSegments(currentSegment: number) {
    const segmentsToKeep = new Set(
      Array.from({ length: this.config.maxCachedSegments }, 
        (_, i) => currentSegment + i - Math.floor(this.config.maxCachedSegments / 2)
      )
    );

    for (const [index, segment] of this.segments.entries()) {
      if (!segmentsToKeep.has(index) && segment.isProcessed) {
        // Keep segment metadata but clear processed data
        this.segments.set(index, {
          ...segment,
          times: [],
          pitches: [],
          isProcessed: false
        });
      }
    }
  }

  getPitchDataForTimeRange(startTime: number, endTime: number): PitchData {
    let times: number[] = [];
    let pitches: (number | null)[] = [];

    for (const segment of this.segments.values()) {
      if (segment.isProcessed && 
          segment.endTime >= startTime && 
          segment.startTime <= endTime) {
        const startIdx = segment.times.findIndex(t => t >= startTime);
        const endIdx = segment.times.findIndex(t => t > endTime);
        times = times.concat(segment.times.slice(startIdx, endIdx));
        pitches = pitches.concat(segment.pitches.slice(startIdx, endIdx));
      }
    }

    return { times, pitches };
  }

  // Add method to get total duration
  getTotalDuration(): number {
    return this.totalDuration;
  }

  // Add method to check if we're in progressive mode
  isInProgressiveMode(): boolean {
    return this.isProgressiveMode;
  }
} 