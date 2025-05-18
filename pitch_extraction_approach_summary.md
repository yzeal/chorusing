# Two-Part Pitch Extraction Approach for Long Videos

## Overview

The Japanese pitch accent web application needs to handle both short and long audio/video files. For long videos, extracting pitch data from the entire file at once causes browser crashes, particularly on mobile devices. To solve this problem, we've developed a two-part approach:

1. **Direct File Processing**: For content positions within the configurable threshold
   - Processes audio directly from the file for segments in the first portion of the video
   - More accurate and reliable
   - Avoids buffer size limitations by only processing the necessary segment

2. **Media Element Extraction**: For content positions beyond the threshold
   - Captures audio in real-time from the media element for later portions of the video
   - Better memory management for segments deep into long videos
   - Prevents browser crashes caused by large buffer sizes

## Implementation Details

### Configuration

- **Threshold**: Default of 30 minutes (1800 seconds)
  - Segments within the first 30 minutes use direct file processing
  - Segments beyond the 30-minute position use the media element approach
  - Made configurable to adjust based on device capabilities

### Direct File Processing

When processing segments within the threshold position:
1. Load the relevant segment of the file
2. Decode audio data using Web Audio API
3. Process frames using pitch detection algorithm
4. Apply filtering and smoothing
5. Normalize time values to display in 0-20s range

### Media Element Extraction

When processing segments beyond the threshold position:
1. Create audio context and analyzer nodes
2. Connect to the active media element
3. Temporarily mute playback to avoid disturbing the user
4. Seek to the target segment
5. Collect pitch data in real-time during playback
6. Apply filtering and normalization
7. Restore original media state when complete

### Key Improvements

1. **Position-Based Processing**: Choose the appropriate method based on the segment's position in the video
2. **Time Normalization**: Display extracted segments in the 0-20s range regardless of their position in the video
3. **Error Handling**: Robust recovery from processing errors
4. **State Restoration**: Properly restore media element state after extraction
5. **Safety Timeouts**: Prevent infinite loops during extraction
6. **Audio Node Cleanup**: Ensure proper disconnection of audio nodes

## Advantages

1. **Mobile Compatibility**: Can handle long videos without crashing mobile browsers
2. **Resource Efficiency**: Only processes the currently needed segment
3. **User Experience**: No interruption to normal playback when viewing pitch data
4. **Flexibility**: Configurable threshold to adapt to different devices and browsers
5. **Buffer Size Management**: Avoids memory issues when accessing later portions of large files

## Implementation Status

The two-part approach needs to be implemented in the `PitchDataManager.ts` file, including:
- Adding the configurable threshold property (default: 30 minutes)
- Implementing the decision logic to choose the appropriate method based on segment position
- Ensuring proper time normalization
- Adding comprehensive error handling
- Implementing proper cleanup of audio resources 