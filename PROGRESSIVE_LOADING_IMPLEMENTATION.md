# Progressive Loading Implementation for Large Audio/Video Files

## Overview
For files longer than a threshold duration (e.g., 30 seconds), implement progressive loading of pitch data to improve performance and mobile usability. Shorter files will continue to be processed entirely as before.

## Implementation Details

### Core Configuration Interface
```typescript
interface ProgressiveLoadingConfig {
  // If file duration is below this, load everything at once
  thresholdDuration: number;  // e.g., 30 seconds
  
  // Size of segments when loading progressively
  segmentDuration: number;    // e.g., 10 seconds
  
  // How many segments to load ahead of current view
  preloadSegments: number;    // e.g., 1 segment ahead
  
  // Keep this many segments in memory
  maxCachedSegments: number;  // e.g., 6 segments
}
```

### Data Structure
```typescript
interface PitchSegment {
  startTime: number;
  endTime: number;
  times: number[];
  pitches: (number | null)[];
  isProcessed: boolean;
}
```

### Main Manager Class
```typescript
class PitchDataManager {
  private segments: Map<number, PitchSegment> = new Map();
  private config: ProgressiveLoadingConfig;
  private totalDuration: number = 0;
  private isProgressiveMode: boolean = false;

  constructor(config: ProgressiveLoadingConfig) {
    this.config = config;
  }

  async initialize(file: File) {
    this.totalDuration = await this.getFileDuration(file);
    this.isProgressiveMode = this.totalDuration > this.config.thresholdDuration;

    if (!this.isProgressiveMode) {
      // Process entire file at once
      const fullPitchData = await this.processEntireFile(file);
      this.segments.set(0, {
        startTime: 0,
        endTime: this.totalDuration,
        times: fullPitchData.times,
        pitches: fullPitchData.pitches,
        isProcessed: true
      });
    } else {
      // Just initialize segment map
      this.initializeSegments();
    }
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
    if (!this.isProgressiveMode) return;

    const startSegment = Math.floor(startTime / this.config.segmentDuration);
    const endSegment = Math.floor(endTime / this.config.segmentDuration);
    
    // Load visible segments plus preload
    for (let i = startSegment; i <= endSegment + this.config.preloadSegments; i++) {
      if (this.segments.has(i) && !this.segments.get(i)!.isProcessed) {
        await this.processSegment(i);
      }
    }

    // Cleanup old segments if needed
    this.cleanupOldSegments(startSegment);
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

  getPitchDataForTimeRange(startTime: number, endTime: number) {
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
}
```

## Integration Steps

1. Create new PitchDataManager instance with configuration:
```typescript
const pitchManager = new PitchDataManager({
  thresholdDuration: 30, // 30 seconds
  segmentDuration: 10,   // 10 second segments
  preloadSegments: 1,    // Load one segment ahead
  maxCachedSegments: 6   // Keep 6 segments in memory
});
```

2. Modify file loading logic:
```typescript
// When loading a file
await pitchManager.initialize(file);

// When zooming/panning
const handleViewChange = async (startTime: number, endTime: number) => {
  await pitchManager.loadSegmentsForTimeRange(startTime, endTime);
  const visibleData = pitchManager.getPitchDataForTimeRange(startTime, endTime);
  updateGraph(visibleData);
};
```

3. Add loading indicators:
```typescript
// In PitchGraph component
const [isLoading, setIsLoading] = useState(false);

const renderLoadingIndicator = () => (
  <div style={{
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 2,
    background: 'linear-gradient(90deg, transparent 0%, #1976d2 50%, transparent 100%)',
    animation: 'slide 1s infinite linear'
  }} />
);
```

## Benefits
1. Small files (< 30s) work exactly as before
2. Larger files become manageable
3. Constant memory usage regardless of file size
4. Smooth user experience with preloading
5. Mobile-friendly (only process what's needed)
6. Adjustable thresholds based on device/performance

## Next Steps
1. Implement PitchDataManager class
2. Modify file loading logic in App.tsx
3. Add loading indicators to PitchGraph component
4. Test with various file sizes
5. Fine-tune thresholds based on performance testing
6. Add error handling and recovery mechanisms

## Future Considerations
- Add progress reporting for segment processing
- Implement segment caching in IndexedDB
- Add quality settings for different devices
- Consider server-side processing for very large files 