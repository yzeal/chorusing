# Long Video Handling Improvements

## Current Issues
- Mobile browsers may reload when loading large video files due to memory constraints
- Multiple copies of video file may be held in memory

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
