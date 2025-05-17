# Long Video Handling Improvements

## Current Issues
- Mobile browsers may reload when loading large video files due to memory constraints
- Lazy loading of pitch data segments adds instability
- Multiple copies of video file may be held in memory
- Current lazy loading approach:
  - Makes navigation through pitch curve graph cumbersome
  - Requires workarounds for seeking that defeat the purpose
  - Creates unpredictable loading states during zoom/pan
  - Degrades user experience for practice sessions

## Planned Improvements

### Approach 1: Release File Object After Video Load
This approach focuses on reducing memory usage by releasing the original file after the video element has loaded it.

**Implementation Notes:**
- Need to implement a workaround for file input reselection
  - Option 1: Clear input before each file selection
  - Option 2: Keep file input value but clear File object reference
  - Option 3: Implement a custom file picker UX
- Need to verify if pitch analysis can still work with:
  - Only the loaded video element
  - Or if we need to keep the file for analysis but release it after processing
- Consider implementing a size threshold (e.g., 100MB) to only apply this to long videos

**Pitch Analysis Options:**
1. Process Before Release:
   ```typescript
   const handleLongVideo = async (file: File) => {
     // First load the video
     const url = URL.createObjectURL(file);
     await loadVideoElement(url);
     
     // Process pitch data before releasing
     await pitchManager.current.initialize(file);
     
     // Now we can release the file
     if (fileInputRef.current) {
       fileInputRef.current.value = '';
     }
   };
   ```

2. Process from Video Element:
   ```typescript
   const processFromVideo = async (video: HTMLVideoElement) => {
     // Create temporary canvas to extract audio data
     const canvas = document.createElement('canvas');
     const ctx = canvas.getContext('2d');
     
     // Extract audio data from video element
     const audioContext = new AudioContext();
     const source = audioContext.createMediaElementSource(video);
     
     // Process pitch data from audio stream
     // ... pitch processing logic ...
   };
   ```

3. Hybrid Approach:
   ```typescript
   const handleLongVideo = async (file: File) => {
     const isAudioOnly = file.type.startsWith('audio/');
     
     if (isAudioOnly) {
       // For audio, we need the file for processing
       await processAudioFile(file);
       // Release after processing
       if (fileInputRef.current) {
         fileInputRef.current.value = '';
       }
     } else {
       // For video, we can use the video element
       const url = URL.createObjectURL(file);
       await loadVideoElement(url);
       // Release file early
       if (fileInputRef.current) {
         fileInputRef.current.value = '';
       }
       // Process from video element
       await processFromVideo(nativeVideoRef.current!);
     }
   };
   ```

### Approach 2: Streaming with MediaSource API
More complex but potentially more powerful solution for very large files.

**Considerations:**
- Requires specific codec support
- More complex implementation
- May need to handle buffering states
- Could complicate pitch analysis process
- Better memory usage on mobile

### Approach 3: Aggressive URL Management
Focus on careful management of object URLs to free memory quickly.

**Implementation Notes:**
- Need careful timing to not break video playback
- Consider implementing along with Approach 1
- May need special handling for seeking/buffering

## Next Steps
1. Test if file size or processing is the primary issue:
   - Try loading video without immediate pitch processing
   - Measure memory usage in different scenarios
   
2. Implement size threshold detection:
   ```typescript
   const LONG_VIDEO_THRESHOLD = 100 * 1024 * 1024; // 100MB
   const isLongVideo = (file: File) => file.size > LONG_VIDEO_THRESHOLD;
   ```

3. Start with Approach 1 as it's simplest to implement and test
   - Implement file reselection workaround first
   - Test pitch analysis compatibility
   - Measure memory improvements

## New Approach for Long Videos

### Replace Lazy Loading with On-Demand Extraction
Instead of lazy loading segments, implement a more user-friendly approach:

**Key Features:**
- Initially show no pitch curve data for long videos
- Add "Extract Pitch Curve" button near video controls
- When clicked, extract 20 seconds of pitch data:
  - 2 seconds before current playback position
  - 18 seconds after current playback position
- Clear previous pitch data when extracting new segment

**Implementation Considerations:**
1. Playback Control:
   - Need to distinguish between practice loop playback and seeking new segments
   - Consider adding separate controls or modes:
     - "Practice Mode": Enable looping, use current pitch data
     - "Browse Mode": Disable looping, for finding new segments

2. UI/UX Improvements:
   - Clear visual indication of extracted segment bounds
   - Show extraction button only when video is loaded
   - Add loading indicator during extraction
   - Display current segment time range

3. Technical Implementation:
   - Buffer handling for segment boundaries
   - Error handling for near-start and near-end positions
   - Memory management for extracted segments
   - Smooth transition between segments

4. Data Management:
   - Store only current segment in memory
   - Clear old segment data before extracting new
   - Handle audio/video format differences

**Next Steps:**
1. Implement basic extraction functionality
2. Design UI for segment extraction
3. Add playback mode controls
4. Test memory usage and performance
5. Optimize extraction process

## Questions to Answer
- [ ] Can pitch analysis work directly from video element?
- [ ] What's the optimal size threshold for "long" videos?
- [ ] Should mobile devices get a different threshold?
- [ ] How to handle pitch analysis if file is released?
- [ ] How to handle transition between practice/browse modes?
- [ ] Should we cache recently extracted segments?
- [ ] What's the optimal segment duration for practice?
- [ ] How to handle extraction near video boundaries?

## Future Considerations
- May want to implement different strategies for mobile vs desktop
- Consider adding progress indicators for large file processing
- May need to adjust UI to better communicate processing states
- Consider adding file size warnings on mobile
- Consider adding segment bookmarking
- Add keyboard shortcuts for extraction
- Visualize full video timeline with markers for extracted segments
- Allow adjustable segment duration

## Related Code Areas
- `handleNativeFileChange` function
- `PitchDataManager` class
- Video element handling
- File input component 

### Mode Toggle Implementation

#### Core Concept
Instead of showing all controls simultaneously, use a mode-based UI that clearly indicates the current task and shows only relevant controls.

```typescript
type VideoMode = 'browse' | 'practice';

interface VideoState {
  mode: VideoMode;
  extractedSegment: {
    startTime: number;
    endTime: number;
    pitchData: PitchData | null;
  } | null;
}
```

#### UI Components

1. **Mode Selector:**
```tsx
const ModeToggle: React.FC<{
  mode: VideoMode;
  onModeChange: (mode: VideoMode) => void;
  hasExtractedSegment: boolean;
}> = ({ mode, onModeChange, hasExtractedSegment }) => (
  <div className="mode-toggle">
    <button 
      className={`mode-button ${mode === 'browse' ? 'active' : ''}`}
      onClick={() => onModeChange('browse')}
    >
      Browse Mode
    </button>
    <button 
      className={`mode-button ${mode === 'practice' ? 'active' : ''}`}
      onClick={() => onModeChange('practice')}
      disabled={!hasExtractedSegment}
    >
      Practice Mode
    </button>
  </div>
);
```

2. **Mode-Specific Controls:**
```tsx
const VideoControls: React.FC<{
  mode: VideoMode;
  onExtract: () => void;
  onStartPractice: () => void;
  isLooping: boolean;
}> = ({ mode, onExtract, onStartPractice, isLooping }) => (
  <div className="video-controls">
    {mode === 'browse' && (
      <div className="browse-controls">
        <button onClick={onExtract} className="extract-button">
          Extract Pitch Data (±10s)
        </button>
        <div className="browse-hint">
          Find a segment you want to practice
        </div>
      </div>
    )}
    {mode === 'practice' && (
      <div className="practice-controls">
        <button 
          onClick={onStartPractice}
          className={`practice-button ${isLooping ? 'active' : ''}`}
        >
          {isLooping ? 'Stop Practice' : 'Start Practice'}
        </button>
        <div className="segment-info">
          Practicing segment: {formatTime(extractedSegment.startTime)} - {formatTime(extractedSegment.endTime)}
        </div>
      </div>
    )}
  </div>
);
```

#### Mode Behaviors

1. **Browse Mode:**
- Purpose: Find interesting segments in the video
- Controls shown:
  - Video player with standard controls
  - Extract button
  - Current position indicator
- Behaviors:
  - Free seeking throughout video
  - Autoplay disabled
  - No looping
  - Pitch graph hidden or shows placeholder
  - Clear visual hint to extract segment

2. **Practice Mode:**
- Purpose: Practice the extracted segment
- Controls shown:
  - Loop control
  - Segment time range
  - Pitch graph for extracted segment
  - Recording controls
- Behaviors:
  - Playback restricted to extracted segment
  - Automatic looping when enabled
  - Full pitch analysis features available
  - Clear visual connection between video and pitch graph

#### Mode Transitions

```typescript
const handleModeChange = (newMode: VideoMode) => {
  if (newMode === 'practice' && !extractedSegment) {
    // Can't enter practice mode without extracted segment
    return;
  }

  if (newMode === 'practice') {
    // Entering practice mode
    setMode('practice');
    // Jump to start of extracted segment
    if (videoRef.current && extractedSegment) {
      videoRef.current.currentTime = extractedSegment.startTime;
    }
    // Enable practice features
    setAutoLoopEnabled(true);
  } else {
    // Entering browse mode
    setMode('browse');
    // Disable practice features
    setAutoLoopEnabled(false);
    // Keep extracted segment data but don't enforce its bounds
  }
};
```

#### Styling Considerations

```css
.mode-toggle {
  display: flex;
  gap: 1px;
  background: #444;
  padding: 2px;
  border-radius: 6px;
  margin-bottom: 1rem;
}

.mode-button {
  flex: 1;
  padding: 8px 16px;
  border: none;
  background: transparent;
  color: #fff;
  opacity: 0.7;
  transition: all 0.2s;
}

.mode-button.active {
  background: #666;
  opacity: 1;
  border-radius: 4px;
}

.mode-button:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

/* Mode-specific control styling */
.browse-controls,
.practice-controls {
  padding: 1rem;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.05);
  margin-top: 1rem;
}

.extract-button {
  background: #1976d2;
  color: white;
  /* ... */
}

.practice-button {
  background: #388e3c;
  color: white;
  /* ... */
}

.practice-button.active {
  background: #d32f2f;
}
``` 