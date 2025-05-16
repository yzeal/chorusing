// IMPORTANT: Modified by user to test Git detection - delete this line later
import React, { useState, useRef, useCallback } from 'react'
import Footer from './components/Footer'
import Recorder from './components/Recorder'
import PitchGraphWithControls from './components/PitchGraph'
import type { Chart } from 'chart.js';
import './App.css'
import { PitchDetector } from 'pitchy'
import { PitchDataManager } from './services/PitchDataManager'

// Initialize mobile debug console if needed
if (typeof window !== 'undefined' && window.location.search.includes('debug=true')) {
  console.log('Initializing mobile debug console with Eruda');
  
  // Add Eruda script
  const script = document.createElement('script');
  script.src = 'https://cdn.jsdelivr.net/npm/eruda';
  document.body.appendChild(script);
  
  script.onload = function() {
    // Eruda is now properly typed in types.d.ts
    window.eruda?.init({
      tool: ['console', 'elements', 'network', 'resources', 'info'],
      useShadowDom: false,  // This helps with some mobile browsers
      autoScale: true,
      defaults: {
        displaySize: 60,  // Make the initial size larger
        transparency: 0.9,
        theme: 'Material Oceanic' // Use a nice theme
      }
    });
    
    
    // Add an initialization message to confirm it's working
    console.log('Mobile debug console ready!', {
      userAgent: navigator.userAgent,
      screenSize: `${window.innerWidth}x${window.innerHeight}`,
      time: new Date().toISOString()
    });
    
    // Add a custom "Export Logs" button to Eruda
    const addExportButton = () => {
      try {
        // Create a global export function - use the standard name consistently
        window.exportLogs = () => {
          try {
            // Use alert to show message until we can download logs
            alert('To see all console logs, take a screenshot of the console tab in Eruda.');
          } catch (err) {
            console.error('Error in export:', err);
            alert('Export failed: ' + String(err));
          }
        };
        
        // Add instructions to console
        console.log('To see more detailed instructions, run:');
        console.log('window.exportLogs()');
      } catch (err) {
        console.error('Error setting up log function:', err);
      }
    };
    
    // Add the export function after a short delay to ensure Eruda is fully initialized
    setTimeout(addExportButton, 1000);
  };

  // Enhance console.log to show timestamp
  const originalConsoleLog = console.log;
  console.log = function(...args) {
    const time = new Date().toISOString().split('T')[1].split('.')[0]; // HH:MM:SS
    originalConsoleLog.apply(console, [`[${time}]`, ...args]);
  };
}

// Median filter for smoothing
function medianFilter(arr: (number | null)[], windowSize: number): (number | null)[] {
  const result: (number | null)[] = []
  for (let i = 0; i < arr.length; i++) {
    const window: number[] = []
    for (let j = Math.max(0, i - Math.floor(windowSize / 2)); j <= Math.min(arr.length - 1, i + Math.floor(windowSize / 2)); j++) {
      if (arr[j] !== null && !isNaN(arr[j]!)) window.push(arr[j]!)
    }
    if (window.length > 0) {
      window.sort((a, b) => a - b)
      result.push(window[Math.floor(window.length / 2)])
    } else {
      result.push(null)
    }
  }
  return result
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

const MIN_PITCH = 60
const MAX_PITCH = 500
const MIN_CLARITY = 0.8
const MEDIAN_FILTER_SIZE = 5

// Constants for default y-axis bounds (update to more visually pleasing round numbers)
const DEFAULT_MIN_PITCH = 50;
const DEFAULT_MAX_PITCH = 500;

// Type definitions
interface AudioContextType extends AudioContext {
  decodeAudioData: (arrayBuffer: ArrayBuffer) => Promise<AudioBuffer>;
}

declare global {
  interface Window {
    webkitAudioContext: typeof AudioContext;
  }
}

// Add extended chart type with our custom methods
interface ExtendedChart extends Chart<'line', (number | null)[], number> {
  setViewRange?: (range: { min: number; max: number }) => void;
  zoomStateRef?: React.RefObject<{ min: number; max: number }>;
}

const App: React.FC = () => {
  // User pitch data
  const [userPitchData, setUserPitchData] = useState<{ times: number[]; pitches: (number | null)[] }>({ times: [], pitches: [] })
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null)
  const [userAudioUrl, setUserAudioUrl] = useState<string | undefined>(undefined)

  // Native pitch data
  const [nativePitchData, setNativePitchData] = useState<{ times: number[]; pitches: (number | null)[] }>({ times: [], pitches: [] })
  const [nativeMediaUrl, setNativeMediaUrl] = useState<string | null>(null)
  const [nativeMediaType, setNativeMediaType] = useState<'audio' | 'video' | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const nativeVideoRef = useRef<HTMLVideoElement>(null)
  const nativeAudioRef = useRef<HTMLAudioElement>(null)

  // Loop selection and delay state
  const [loopStart, setLoopStart] = useState(0)
  const [loopEnd, setLoopEnd] = useState(0)
  const [loopDelay, setLoopDelay] = useState(0)
  const [loopYFit, setLoopYFit] = useState<[number, number] | null>(null)

  // Native playback time tracking
  const [nativePlaybackTime, setNativePlaybackTime] = useState(0);
  const [userPlaybackTime, setUserPlaybackTime] = useState(0);
  const userAudioRef = useRef<HTMLAudioElement>(null);
  const userAudioPlayingRef = useRef(false);

  const [nativeChartInstance, setNativeChartInstance] = useState<ExtendedChart | null>(null);

  // Add drag state
  const [isDragging, setIsDragging] = useState(false);

  // Add PitchDataManager
  const pitchManager = useRef(new PitchDataManager({
    thresholdDuration: 30, // 30 seconds
    segmentDuration: 10,   // 10 second segments
    preloadSegments: 1,    // Load one segment ahead
    maxCachedSegments: 6   // Keep 6 segments in memory
  }));

  // Add a ref to track last valid user-set loop region
  const userSetLoopRef = useRef<{start: number, end: number} | null>(null);
  
  // Add a ref to track when a new file is being loaded
  const isLoadingNewFileRef = useRef<boolean>(false);

  // Add loading state for pitch data
  const [isLoadingPitchData, setIsLoadingPitchData] = useState(false);

  // Add auto-loop state
  const [autoLoopEnabled, setAutoLoopEnabled] = useState(false);

  // Add state to track if user is actively seeking
  const [isUserSeeking, setIsUserSeeking] = useState(false);
  const seekingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Add a flag to indicate if the recording is a user recording
  const [isUserRecording, setIsUserRecording] = useState(false);

  // Get the chart instance reference for the user recording
  const [userChartInstance, setUserChartInstance] = useState<ExtendedChart | null>(null);

  // Add state for overlay pages
  const [showGuide, setShowGuide] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  
  // Add keyboard event listener for Escape key
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showGuide) setShowGuide(false);
        if (showSettings) setShowSettings(false);
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    
    // Add body class to prevent scrolling when overlay is open
    if (showGuide || showSettings) {
      document.body.classList.add('overlay-open');
    } else {
      document.body.classList.remove('overlay-open');
    }
    
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.body.classList.remove('overlay-open');
    };
  }, [showGuide, showSettings]);

  // Add effect to reset user chart view on new recording
  React.useEffect(() => {
    if (userChartInstance && isUserRecording && userPitchData.times.length > 0) {
      const duration = userPitchData.times[userPitchData.times.length - 1];
      console.log('[App] Directly setting user recording view range:', { min: 0, max: duration });
      
      if (userChartInstance.setViewRange) {
        userChartInstance.setViewRange({ min: 0, max: duration });
      } else if (userChartInstance.options.scales?.x) {
        userChartInstance.options.scales.x.min = 0;
        userChartInstance.options.scales.x.max = duration;
        userChartInstance.update();
      }
    }
  }, [userChartInstance, isUserRecording, userPitchData.times.length]);

  // Add drag and drop handlers
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const file = e.dataTransfer.files[0];
    if (!file) return;

    // Set flag to indicate we're loading a completely new file
    isLoadingNewFileRef.current = true;
    console.log('[App] Loading new file via drop, setting isLoadingNewFile flag:', isLoadingNewFileRef.current);

    // Reset user-set loop region when loading a new file
    userSetLoopRef.current = null;
    console.log('[App] New file loaded, clearing user-set loop region');

    // Use the existing file handling logic
    const url = URL.createObjectURL(file);
    setNativeMediaUrl(url);
    
    if (file.type.startsWith('audio/')) {
      setNativeMediaType('audio');
      try {
        console.log('[App] Initializing PitchDataManager with audio file:', file.name);
        await pitchManager.current.initialize(file);
        
        // Get initial pitch data
        const initialData = pitchManager.current.getPitchDataForTimeRange(0, 30);
        
        // Apply enhanced smoothing for a more simplified curve
        const enhancedData = {
          times: initialData.times,
          pitches: smoothPitch(initialData.pitches, 25)
        };
        
        console.log('[App] Initial pitch data loaded and smoothed');
        setNativePitchData(enhancedData);
      } catch (error) {
        console.error('Error processing audio:', error);
        setNativePitchData({ times: [], pitches: [] });
      }
    } else if (file.type.startsWith('video/')) {
      setNativeMediaType('video');
      try {
        console.log('[App] Initializing PitchDataManager with video file:', file.name);
        await pitchManager.current.initialize(file);
        
        // Get initial pitch data
        const initialData = pitchManager.current.getPitchDataForTimeRange(0, 30);
        
        // Apply enhanced smoothing for a more simplified curve
        const enhancedData = {
          times: initialData.times,
          pitches: smoothPitch(initialData.pitches, 25)
        };
        
        console.log('[App] Initial pitch data loaded and smoothed');
        setNativePitchData(enhancedData);
      } catch (error) {
        console.error('Error processing video:', error);
        setNativePitchData({ times: [], pitches: [] });
      }
    } else {
      setNativeMediaType(null);
      setNativePitchData({ times: [], pitches: [] });
    }
    
    // Don't reset the flag here - it will be reset by a useEffect
    console.log('[App] File loading complete, isLoadingNewFile still set:', isLoadingNewFileRef.current);
  };

  // Extract pitch from user recording when audioBlob changes
  React.useEffect(() => {
    if (!audioBlob) return;
    
    // This is a user recording
    setIsUserRecording(true);
    
    const extract = async () => {
      try {
        const arrayBuffer = await audioBlob.arrayBuffer();
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)() as AudioContextType;
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        const channelData = audioBuffer.getChannelData(0);
        const sampleRate = audioBuffer.sampleRate;
        const frameSize = 2048;
        const hopSize = 256;
        const detector = PitchDetector.forFloat32Array(frameSize);
        const pitches: (number | null)[] = [];
        const times: number[] = [];
        for (let i = 0; i + frameSize < channelData.length; i += hopSize) {
          const frame = channelData.slice(i, i + frameSize);
          const [pitch, clarity] = detector.findPitch(frame, sampleRate);
          if (pitch >= MIN_PITCH && pitch <= MAX_PITCH && clarity >= MIN_CLARITY) {
            pitches.push(pitch);
          } else {
            pitches.push(null);
          }
          times.push(i / sampleRate);
        }
        
        // First apply basic median filter
        const basicSmoothed = medianFilter(pitches, MEDIAN_FILTER_SIZE);
        
        // Then apply enhanced smoothing for simplified curves
        const enhancedSmooth = smoothPitch(basicSmoothed, 25);
        
        setUserPitchData({ times, pitches: enhancedSmooth });
        
        // Calculate the initial range for user pitch data when extracted
        const [minPitch, maxPitch] = calculateInitialPitchRange(enhancedSmooth);
        
        // Use the same y-axis range for user data as we do for native data
        // This makes it easier to compare the two
        const currentYFit = loopYFit || [DEFAULT_MIN_PITCH, DEFAULT_MAX_PITCH];
        const newYFit: [number, number] = [
          Math.min(minPitch, currentYFit[0]),
          Math.max(maxPitch, currentYFit[1])
        ];
        
        // Only update if the range has changed
        if (newYFit[0] !== currentYFit[0] || newYFit[1] !== currentYFit[1]) {
          console.log('[App] Adjusting y-axis range to include user pitch data:', {
            current: currentYFit,
            new: newYFit
          });
          setLoopYFit(newYFit);
        }
      } catch (error) {
        console.error('Error extracting pitch:', error);
        setUserPitchData({ times: [], pitches: [] });
      }
    };
    extract();
  }, [audioBlob]);

  // Add a helper effect to force redraw of user recording when data changes
  React.useEffect(() => {
    // Only run this for user recordings that have data
    if (isUserRecording && userPitchData.times.length > 0) {
      console.log('[App] User recording data updated, length:', userPitchData.times.length);
    }
  }, [isUserRecording, userPitchData.times.length]);

  // Reset isUserRecording when a native file is loaded
  React.useEffect(() => {
    if (nativeMediaUrl) {
      setIsUserRecording(false);
    }
  }, [nativeMediaUrl]);

  // Modify handleNativeFileChange
  const handleNativeFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    // Set flag to indicate we're loading a completely new file
    isLoadingNewFileRef.current = true;
    console.log('[App] Loading new file via input, setting isLoadingNewFile flag:', isLoadingNewFileRef.current);
    
    // Reset user-set loop region when loading a new file
    userSetLoopRef.current = null;
    console.log('[App] New file loaded, clearing user-set loop region');
    
    const url = URL.createObjectURL(file);
    setNativeMediaUrl(url);
    
    if (file.type.startsWith('audio/')) {
      setNativeMediaType('audio');
      try {
        console.log('[App] Initializing PitchDataManager with audio file:', file.name);
        await pitchManager.current.initialize(file);
        
        // Get initial pitch data
        const initialData = pitchManager.current.getPitchDataForTimeRange(0, 30);
        
        // Apply enhanced smoothing for a more simplified curve
        const enhancedData = {
          times: initialData.times,
          pitches: smoothPitch(initialData.pitches, 25)
        };
        
        console.log('[App] Initial pitch data loaded and smoothed');
        setNativePitchData(enhancedData);
      } catch (error) {
        console.error('Error processing audio:', error);
        setNativePitchData({ times: [], pitches: [] });
      }
    } else if (file.type.startsWith('video/')) {
      setNativeMediaType('video');
      try {
        console.log('[App] Initializing PitchDataManager with video file:', file.name);
        await pitchManager.current.initialize(file);
        
        // Get initial pitch data
        const initialData = pitchManager.current.getPitchDataForTimeRange(0, 30);
        
        // Apply enhanced smoothing for a more simplified curve
        const enhancedData = {
          times: initialData.times,
          pitches: smoothPitch(initialData.pitches, 25)
        };
        
        console.log('[App] Initial pitch data loaded and smoothed');
        setNativePitchData(enhancedData);
      } catch (error) {
        console.error('Error processing video:', error);
        setNativePitchData({ times: [], pitches: [] });
      }
    } else {
      setNativeMediaType(null);
      setNativePitchData({ times: [], pitches: [] });
    }
    
    // Don't reset the flag here - it will be reset by a useEffect
    console.log('[App] File loading complete, isLoadingNewFile still set:', isLoadingNewFileRef.current);
  };

  // Ensure video is seeked to 0.01 and loaded when a new video is loaded (robust for short files)
  React.useEffect(() => {
    if (nativeMediaType === 'video' && nativeVideoRef.current) {
      const video = nativeVideoRef.current;
      const onLoaded = () => {
        video.currentTime = 0.01;
      };
      video.addEventListener('loadedmetadata', onLoaded);
      video.load();
      return () => video.removeEventListener('loadedmetadata', onLoaded);
    }
  }, [nativeMediaUrl, nativeMediaType]);

  // Update loop end when native media is loaded - only if no user-set region exists
  React.useEffect(() => {
    // Only proceed with reset if we're loading a completely new file
    if (!isLoadingNewFileRef.current) {
      console.log('[App] Pitch data changed, but not loading a new file. Preserving loop region.', {
        isLoadingNewFile: isLoadingNewFileRef.current,
        pitchDataLength: nativePitchData.times.length,
        loopStart,
        loopEnd
      });
      
      // Just update the y-axis without changing the loop region
      if (nativePitchData.times.length > 0) {
        fitYAxisToLoop();
      }
      return;
    }
    
    console.log('[App] Setting loop region for newly loaded file', {
      isLoadingNewFile: isLoadingNewFileRef.current,
      pitchDataLength: nativePitchData.times.length
    });
    
    // We always want to reset the loop region when loading a new file,
    // regardless of whether the user had set a custom loop before
    // since this is a completely new file with potentially different length
    
    const duration = nativePitchData.times.length > 0 ? nativePitchData.times[nativePitchData.times.length - 1] : 0;
    
    // For long videos (>30s), set initial loop and view to first 10 seconds
    // For short videos, show the entire duration
    if (duration > 30) {
      const initialViewDuration = 10;
      setLoopStartWithLogging(0);
      setLoopEndWithLogging(initialViewDuration);
      
      // Set the user-set loop to this region, as if the user created this loop
      userSetLoopRef.current = { start: 0, end: initialViewDuration };
      console.log('[App] New file loaded (long), setting loop region to first 10 seconds:', {
        duration,
        loop: userSetLoopRef.current
      });
      
      // Update chart view range if chart is ready
      if (nativeChartInstance) {
        console.log('[App] Long video detected, setting initial view to first 10 seconds:', {
          duration,
          initialViewDuration,
          chartInstance: !!nativeChartInstance
        });
        
        // Update zoom state ref directly
        if (nativeChartInstance.options.scales?.x) {
          nativeChartInstance.options.scales.x.min = 0;
          nativeChartInstance.options.scales.x.max = initialViewDuration;
          
          // Also update the zoom state ref in the PitchGraph component
          const chartWithZoomState = nativeChartInstance as unknown as { zoomStateRef: { current: { min: number; max: number } } };
          if (chartWithZoomState.zoomStateRef) {
            chartWithZoomState.zoomStateRef.current = { min: 0, max: initialViewDuration };
          }
          
          // Force the chart to update its layout
          nativeChartInstance.update('none');
          
          // Notify parent of view change
          handleViewChange(0, initialViewDuration);
        }
      }
    } else {
      // For short videos, set loop to entire duration
      setLoopStartWithLogging(0);
      setLoopEndWithLogging(duration);
      
      // Set the user-set loop to this region, as if the user created this loop
      userSetLoopRef.current = { start: 0, end: duration };
      console.log('[App] New file loaded (short), setting loop region to entire duration:', {
        duration,
        loop: userSetLoopRef.current
      });
    }
    
    fitYAxisToLoop();
  }, [nativePitchData.times, nativeChartInstance]);

  // Add a guard to protect loop region changes from events other than user interaction
  React.useEffect(() => {
    // Always run fitYAxisToLoop when loop region changes to update visuals
    if (nativePitchData.times.length > 0) {
      console.log('[App] Loop region changed, fitting Y axis:', { 
        loopStart, 
        loopEnd, 
        source: 'loop change effect',
        userSetLoop: userSetLoopRef.current
      });
      
      // If user has set a custom loop region, but current values don't match,
      // restore the user values (this is a safety check)
      const userSetLoop = userSetLoopRef.current;
      if (userSetLoop && 
          (Math.abs(loopStart - userSetLoop.start) > 0.001 || 
           Math.abs(loopEnd - userSetLoop.end) > 0.001)) {
        
        console.log('[App] Loop region overwritten detected, restoring user values:', {
          current: {start: loopStart, end: loopEnd},
          userSet: userSetLoop
        });
        
        // Restore user values 
        setLoopStartWithLogging(userSetLoop.start);
        setLoopEndWithLogging(userSetLoop.end);
        return;
      }
      
      fitYAxisToLoop();
    }
  }, [loopStart, loopEnd]);

  // Add ref to track initial setup
  const initialSetupDoneRef = useRef(false);

  // Add a ref to track if we're currently executing a jump to playback action
  const isJumpingToPlaybackRef = useRef(false);

  // Update handleViewChange to show loading indicator and be more careful with playback jumps
  const handleViewChange = useCallback(async (startTime: number, endTime: number, preservedLoopStart?: number, preservedLoopEnd?: number) => {
    // Clear any pending timeout
    if (viewChangeTimeoutRef.current) {
      clearTimeout(viewChangeTimeoutRef.current);
    }

    // Determine which loop region to restore
    // First check if user has manually set a loop region
    const userSetLoop = userSetLoopRef.current;
    // Then check if we have preserved values from the event
    const hasPreservedValues = preservedLoopStart !== undefined && preservedLoopEnd !== undefined;
    
    // Create a local copy of loop values to restore
    const loopRegionToRestore = userSetLoop ? 
      { start: userSetLoop.start, end: userSetLoop.end } : 
      hasPreservedValues ? 
        { start: preservedLoopStart!, end: preservedLoopEnd! } : 
        { start: loopStart, end: loopEnd };
    
    console.log('[App] View change requested with loop region:', {
      startTime,
      endTime,
      loopRegionToRestore,
      currentLoopStart: loopStart,
      currentLoopEnd: loopEnd,
      userSetLoop,
      isLoadingNewFile: isLoadingNewFileRef.current,
      isJumpingToPlayback: isJumpingToPlaybackRef.current,
      stack: new Error().stack?.split('\n').slice(1, 3).join('\n')
    });

    // Only preserve loop region if we're not loading a new file
    // If we're loading a new file, let the file loading effect handle setting the loop region
    if (!isLoadingNewFileRef.current) {
      // Immediately preserve loop region
      const currentLoopStart = loopRegionToRestore.start;
      const currentLoopEnd = loopRegionToRestore.end;
      
      // Only update if values have changed and we're not jumping to playback
      // (during jump-to-playback, the loop region is managed separately)
      if (!isJumpingToPlaybackRef.current && 
          (Math.abs(loopStart - currentLoopStart) > 0.001 || 
           Math.abs(loopEnd - currentLoopEnd) > 0.001)) {
        setLoopStartWithLogging(currentLoopStart);
        setLoopEndWithLogging(currentLoopEnd);
      }
    } else {
      console.log('[App] Skipping loop region preservation in handleViewChange - loading new file');
    }

    // Set loading state
    setIsLoadingPitchData(true);

    // Set new timeout for data loading (separated from loop region handling)
    viewChangeTimeoutRef.current = setTimeout(async () => {
      try {
        // Only load segments if we're in progressive mode
        if (pitchManager.current.isInProgressiveMode()) {
          const duration = pitchManager.current.getTotalDuration();
          const isLongVideo = duration > 30;
          
          // Only consider it an initial load if we haven't done setup and have no data
          const isInitialLoad = !initialSetupDoneRef.current && nativePitchData.times.length === 0;
          
          console.log('[App] View change triggered:', { 
            startTime, 
            endTime,
            isInitialLoad,
            isLongVideo,
            duration,
            preservedLoopRegion: loopRegionToRestore,
            currentLoopStart: loopStart,
            currentLoopEnd: loopEnd,
            userSetLoop,
            isLoadingNewFile: isLoadingNewFileRef.current,
            isJumpingToPlayback: isJumpingToPlaybackRef.current
          });
          
          // For initial load of long videos, force loading only first segment
          if (isInitialLoad && isLongVideo) {
            console.log('[App] Initial load of long video, forcing first segment only');
            await pitchManager.current.loadSegmentsForTimeRange(0, 10);
            const visibleData = pitchManager.current.getPitchDataForTimeRange(0, 10);
            
            // Set initial loop region for first load only if no user-set region
            // and we're not in the middle of loading a new file
            if (!userSetLoop && !isLoadingNewFileRef.current) {
              setLoopStartWithLogging(0);
              setLoopEndWithLogging(10);
            } else if (userSetLoop && !isLoadingNewFileRef.current) {
              // Restore user-set values
              setLoopStartWithLogging(userSetLoop.start);
              setLoopEndWithLogging(userSetLoop.end);
            }
            
            // Update pitch data
            setNativePitchData(visibleData);
            
            initialSetupDoneRef.current = true;
          } else if (!isInitialLoad) {
            // Only load new segments if this is not the initial setup
            await pitchManager.current.loadSegmentsForTimeRange(startTime, endTime);
            
            // Get data for the current view
            const visibleData = pitchManager.current.getPitchDataForTimeRange(startTime, endTime);
            
            // Update pitch data without modifying loop region
            setNativePitchData(visibleData);
            
            // Only check and restore loop region if we're not loading a new file
            // and we're not doing a jump to playback operation
            if (!isLoadingNewFileRef.current && !isJumpingToPlaybackRef.current) {
              // Ensure loop region is still correct after data loading
              // First check for userSetLoop, which takes highest priority
              if (userSetLoop) {
                if (loopStart !== userSetLoop.start || loopEnd !== userSetLoop.end) {
                  console.log('[App] Re-applying user-set loop region after data loading:', {
                    current: { start: loopStart, end: loopEnd },
                    userSet: userSetLoop
                  });
                  setLoopStartWithLogging(userSetLoop.start);
                  setLoopEndWithLogging(userSetLoop.end);
                }
              }
              // Then check for preserved values
              else if (Math.abs(loopStart - loopRegionToRestore.start) > 0.001 || 
                      Math.abs(loopEnd - loopRegionToRestore.end) > 0.001) {
                console.log('[App] Re-applying preserved loop region after data loading:', {
                  current: { start: loopStart, end: loopEnd },
                  preserved: loopRegionToRestore
                });
                setLoopStartWithLogging(loopRegionToRestore.start);
                setLoopEndWithLogging(loopRegionToRestore.end);
              }
            } else if (isJumpingToPlaybackRef.current) {
              console.log('[App] Skipping loop region restoration - jump to playback in progress');
            } else {
              console.log('[App] Skipping loop region restoration - loading new file');
            }
          }
        }
      } catch (error) {
        console.error('Error loading pitch data for time range:', error);
      } finally {
        // Clear loading state
        setIsLoadingPitchData(false);
      }
    }, 100); // 100ms debounce
  }, [nativePitchData.times, loopStart, loopEnd]);

  // Consolidate initial view setup into a single effect
  React.useEffect(() => {
    // Skip this logic completely if we're in the middle of a jump-to-playback operation
    if (isJumpingToPlaybackRef.current) {
      console.log('[App] Skipping initial view setup while jump-to-playback is in progress');
      return;
    }

    if (nativeChartInstance && nativePitchData.times.length > 0 && !initialSetupDoneRef.current) {
      const duration = nativePitchData.times[nativePitchData.times.length - 1];
      
      if (duration > 30) {
        const initialViewDuration = 10;
        console.log('[App] Setting initial view range for long video:', {
          duration,
          initialViewDuration,
          isInitialSetup: !initialSetupDoneRef.current,
          isJumpingToPlayback: isJumpingToPlaybackRef.current
        });
        
        // Don't reset the view if we're in the middle of a jump-to-playback operation
        if (!isJumpingToPlaybackRef.current) {
          // Update zoom state ref directly
          if (nativeChartInstance.options.scales?.x) {
            nativeChartInstance.options.scales.x.min = 0;
            nativeChartInstance.options.scales.x.max = initialViewDuration;
            
            // Also update the zoom state ref in the PitchGraph component
            const chartWithZoomState = nativeChartInstance as unknown as { zoomStateRef: { current: { min: number; max: number } } };
            if (chartWithZoomState.zoomStateRef) {
              chartWithZoomState.zoomStateRef.current = { min: 0, max: initialViewDuration };
            }
            
            // Force the chart to update its layout
            nativeChartInstance.update('none');
            
            // Notify parent of view change
            handleViewChange(0, initialViewDuration);
          }
        }
        
        // Always mark setup as done to prevent future resets
        initialSetupDoneRef.current = true;
      }
    }
  }, [nativeChartInstance, nativePitchData.times, handleViewChange]);

  // Modify onLoopChange to store the user-set values in the ref
  const onLoopChangeHandler = (start: number, end: number) => {
    console.log('[App] Loop region changed by user interaction:', { start, end });
    
    // Store these values as the last valid user-set values
    userSetLoopRef.current = { start, end };
    
    setLoopStartWithLogging(start);
    setLoopEndWithLogging(end);
    if (getActiveMediaElement()) {
      getActiveMediaElement()!.currentTime = start;
    }
    fitYAxisToLoop();
  };

  // --- Add function to calculate initial pitch range ---
  const calculateInitialPitchRange = (pitches: (number | null)[]): [number, number] => {
    // Filter out nulls
    const validPitches = pitches.filter(p => p !== null) as number[];
    
    if (validPitches.length === 0) {
      return [DEFAULT_MIN_PITCH, DEFAULT_MAX_PITCH];
    }
    
    // Find min and max values
    let minPitch = Math.min(...validPitches);
    let maxPitch = Math.max(...validPitches);
    
    // Apply default lower bound if actual data doesn't go below it
    if (minPitch > DEFAULT_MIN_PITCH) {
      minPitch = DEFAULT_MIN_PITCH;
    } else {
      // Round down to nearest 10 and ensure it's not higher than DEFAULT_MIN_PITCH
      minPitch = Math.min(DEFAULT_MIN_PITCH, Math.floor(minPitch / 10) * 10);
    }
    
    // Apply default upper bound if actual data doesn't go above it
    if (maxPitch < DEFAULT_MAX_PITCH) {
      maxPitch = DEFAULT_MAX_PITCH;
    } else {
      // Round up to nearest 10 and ensure nice round numbers
      maxPitch = Math.ceil(maxPitch / 10) * 10;
      // If we're close to 500, just use 500 exactly
      if (maxPitch > 490 && maxPitch < 510) {
        maxPitch = 500;
      }
    }
    
    console.log('[App] Calculated initial pitch range:', {
      minPitch,
      maxPitch,
      dataMin: Math.min(...validPitches),
      dataMax: Math.max(...validPitches),
      DEFAULT_MIN_PITCH,
      DEFAULT_MAX_PITCH
    });
    
    return [minPitch, maxPitch] as [number, number];
  };

  // --- Update the useEffect hook that sets the y-axis range to only do it once per file ---
  React.useEffect(() => {
    if (!nativePitchData.pitches.length) return;
    
    // Only calculate the y-axis range once when loading a new file
    if (isLoadingNewFileRef.current) {
      console.log('[App] Setting initial y-axis range for new file');
      
      // Calculate the initial range based on the pitch data
      const [minPitch, maxPitch] = calculateInitialPitchRange(nativePitchData.pitches);
      
      // Set the y-axis range
      setLoopYFit([minPitch, maxPitch]);
    }
  }, [nativePitchData.pitches]);
  
  // --- Replace or modify the fitYAxisToLoop function ---
  function fitYAxisToLoop() {
    if (!nativePitchData.times.length) return;

    // Make sure we're using the last valid user-set loop region if available
    const currentLoopStart = loopStart;
    const currentLoopEnd = loopEnd;
    const userSetLoop = userSetLoopRef.current;

    // If we detect that the loop region doesn't match the user-set values, restore them
    if (userSetLoop && 
        (Math.abs(currentLoopStart - userSetLoop.start) > 0.001 || 
         Math.abs(currentLoopEnd - userSetLoop.end) > 0.001)) {
      console.log('[App] Loop region mismatch detected, restoring user-set values:', {
        current: { start: currentLoopStart, end: currentLoopEnd },
        userSet: userSetLoop
      });
      
      // Restore the user-set values
      setLoopStartWithLogging(userSetLoop.start);
      setLoopEndWithLogging(userSetLoop.end);
      
      // Skip further processing since we're just restoring loop regions, not modifying the y-axis
      return;
    }

    console.log('[App] fitYAxisToLoop called but not changing y-axis range, keeping it consistent');
    // We no longer modify the y-axis range in this function
    // The y-axis range is set once when loading a new file and remains constant
  }

  // Update the view change handler
  const onViewChangeHandler = (startTime: number, endTime: number, preservedLoopStart?: number, preservedLoopEnd?: number) => {
    console.log('[App] View change from PitchGraph:', { 
      startTime, 
      endTime, 
      preservedLoopStart, 
      preservedLoopEnd,
      currentLoopStart: loopStart,
      currentLoopEnd: loopEnd,
      userSetLoop: userSetLoopRef.current,
      autoLoopEnabled,
      isJumpingToPlayback: isJumpingToPlaybackRef.current
    });
    
    // If we're in the middle of a jump-to-playback operation and this is an unexpected reset to 0-10,
    // ignore this view change to prevent losing our position
    if (isJumpingToPlaybackRef.current && 
        startTime === 0 && 
        endTime <= 10 && 
        userSetLoopRef.current && 
        userSetLoopRef.current.start > 20) { // Arbitrary threshold to detect unintended resets
      console.log('[App] Ignoring view reset during jump-to-playback operation');
      return;
    }
    
    // If auto-loop is enabled, set the loop region to match the view
    if (autoLoopEnabled) {
      console.log('[App] Auto-loop enabled, setting loop region to match view:', { start: startTime, end: endTime });
      // Update userSetLoopRef since this is effectively a user action
      userSetLoopRef.current = { start: startTime, end: endTime };
      setLoopStartWithLogging(startTime);
      setLoopEndWithLogging(endTime);
      
      // Call handleViewChange with the new loop region
      handleViewChange(startTime, endTime, startTime, endTime);
    } else {
      // Prefer user-set values if available, otherwise use preserved values
      const loopToPreserve = userSetLoopRef.current || 
        (preservedLoopStart !== undefined && preservedLoopEnd !== undefined ? 
          { start: preservedLoopStart, end: preservedLoopEnd } : 
          { start: loopStart, end: loopEnd });
        
      // Call handleViewChange with the preferred loop values
      handleViewChange(startTime, endTime, loopToPreserve.start, loopToPreserve.end);
    }
  };

  // Add the enhanced media end detection to the playback time tracking effect
  React.useEffect(() => {
    const media = getActiveMediaElement();
    if (!media) return;
    let raf: number | null = null;
    let lastTimeValue = -1;
    let stuckFrameCount = 0;
    let lastCheckTime = Date.now();
    
    const update = () => {
      // Track current time
      const currentTime = media.currentTime || 0;
      setNativePlaybackTime(currentTime);
      
      const now = Date.now();
      const timeSinceLastCheck = now - lastCheckTime;
      
      // Detect if playback is stuck at the end of media
      // This can happen when the browser hasn't properly triggered 'ended'
      if (!media.paused) {
        // Check if time hasn't changed between frames
        if (Math.abs(currentTime - lastTimeValue) < 0.001) {
          stuckFrameCount++;
          
          // Additional check for very long videos - if we've been at the same position for over 1 second
          const isStuckLongTime = timeSinceLastCheck > 1000 && Math.abs(currentTime - lastTimeValue) < 0.05;
          
          // If stuck for multiple frames at the very end of the media
          // OR if we're in the last 5% of any long video and not advancing
          const totalDuration = pitchManager.current.getTotalDuration() || media.duration;
          const isNearEnd = totalDuration > 0 && (totalDuration - currentTime < 0.1);
          const isInLastSection = totalDuration > 30 && currentTime > (totalDuration * 0.95);
          
          if ((stuckFrameCount > 10 && isNearEnd) || 
              (isStuckLongTime && isInLastSection) ||
              (stuckFrameCount > 30 && !media.paused)) {
            
            console.log('[App] Detected stuck playback:', {
              currentTime,
              lastTimeValue,
              duration: media.duration,
              stuckFrames: stuckFrameCount,
              timeSinceLastCheck,
              isNearEnd,
              isInLastSection,
              isStuckLongTime
            });
            
            // Manually trigger a loop if we have a loop region set
            if (loopEnd > loopStart) {
              console.log('[App] Manually triggering loop for stuck media');
              media.pause();
              // Use a small timeout to avoid race conditions
              setTimeout(() => {
                if (media) {
                  media.currentTime = loopStart;
                  try {
                    media.play().catch(err => {
                      console.log('[App] Error playing after manual loop:', err);
                    });
                  } catch (e) {
                    console.log('[App] Error during manual loop play:', e);
                  }
                }
              }, loopDelay);
            }
            
            // Reset stuck detection
            stuckFrameCount = 0;
            lastCheckTime = now;
          }
        } else {
          // Reset stuck frame counter when time advances
          stuckFrameCount = 0;
          lastCheckTime = now;
        }
        lastTimeValue = currentTime;
      }
      
      raf = requestAnimationFrame(update);
    };
    
    if (!media.paused) {
      raf = requestAnimationFrame(update);
    }
    
    const onPlay = () => {
      lastTimeValue = media.currentTime || 0;
      stuckFrameCount = 0;
      lastCheckTime = Date.now();
      raf = requestAnimationFrame(update);
    };
    
    const onPause = () => {
      if (raf) cancelAnimationFrame(raf);
    };
    
    media.addEventListener('play', onPlay);
    media.addEventListener('pause', onPause);
    
    return () => {
      media.removeEventListener('play', onPlay);
      media.removeEventListener('pause', onPause);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [nativeMediaUrl, nativeMediaType, loopStart, loopEnd, loopDelay]);

  // --- Native media loop segment logic ---
  React.useEffect(() => {
    const media = getActiveMediaElement();
    if (!media) return;
    let timeout: NodeJS.Timeout | null = null;
    
    // Only consider seeking state when auto-loop is enabled
    // When auto-loop is disabled, we should maintain normal looping behavior regardless of seeking
    const shouldConsiderSeekingState = autoLoopEnabled;
    const shouldApplyLoop = shouldConsiderSeekingState ? !isUserSeeking : true;
    
    // Get the true max duration from various sources to ensure accuracy
    const totalDuration = pitchManager.current.getTotalDuration() || 
      (media.seekable && media.seekable.length > 0 ? media.seekable.end(0) : media.duration);
    
    // Make end detection slightly more aggressive - trigger loop a bit before the actual end
    // This helps avoid the "stuck at end" issue by ensuring we loop before reaching the problematic end state
    const safetyMargin = 0.05; // 50ms safety margin
    
    // Check if we're at or beyond the loop end point OR very close to the end of the file
    const isAtLoopEnd = loopEnd > loopStart && nativePlaybackTime >= (loopEnd - safetyMargin);
    const isNearFileEnd = totalDuration > 0 && (totalDuration - nativePlaybackTime < 0.1);
    
    // Handle both cases where we need to reset playback
    if (shouldApplyLoop && !media.paused && (isAtLoopEnd || isNearFileEnd)) {
      console.log('[App] Loop trigger detected:', {
        nativePlaybackTime,
        loopStart,
        loopEnd,
        totalDuration,
        isAtLoopEnd,
        isNearFileEnd
      });
      
      // Pause playback immediately
      media.pause();
      
      // Clear any existing timeout to avoid multiple resets
      if (timeout) clearTimeout(timeout);
      
      // Set up the loop with delay
      timeout = setTimeout(() => {
        // Double-check media element still exists before manipulating it
        if (!media) return;
        
        console.log('[App] Resetting playback to loop start:', loopStart);
        
        // Enhanced robust playback for mobile devices
        const isOnMobile = isMobileDevice();
        console.log('[App] Device type:', isOnMobile ? 'mobile' : 'desktop');
        
        // Different handling for mobile vs desktop
        if (isOnMobile) {
          // Mobile-specific implementation with additional safeguards
          // First, set the currentTime to loop start
          media.currentTime = loopStart;
          
          // Use a robust play mechanism with canplaythrough event and retries
          const playWithRetries = (retriesLeft = 3) => {
            // Remove any existing event listeners to avoid duplicates
            const existingHandler = media.oncanplaythrough;
            media.oncanplaythrough = null;
            
            // Set up a one-time canplaythrough handler
            media.oncanplaythrough = () => {
              console.log('[App] Media canplaythrough event fired, attempting playback');
              media.oncanplaythrough = existingHandler; // Restore original handler
              
              try {
                const playPromise = media.play();
                if (playPromise !== undefined) {
                  playPromise.catch(error => {
                    console.log('[App] Playback error:', error);
                    if (retriesLeft > 0) {
                      console.log(`[App] Retrying playback, ${retriesLeft} attempts left`);
                      setTimeout(() => playWithRetries(retriesLeft - 1), 300);
                    }
                  });
                }
              } catch (e) {
                console.log('[App] Play error:', e);
                if (retriesLeft > 0) {
                  console.log(`[App] Retrying after error, ${retriesLeft} attempts left`);
                  setTimeout(() => playWithRetries(retriesLeft - 1), 300);
                }
              }
            };
            
            // Set a safety timeout in case canplaythrough doesn't fire
            setTimeout(() => {
              if (media.paused && retriesLeft > 0) {
                console.log('[App] canplaythrough timeout, forcing play attempt');
                media.oncanplaythrough = existingHandler; // Restore original handler
                
                try {
                  media.play().catch(error => {
                    console.log('[App] Forced play error:', error);
                    if (retriesLeft > 0) {
                      setTimeout(() => playWithRetries(retriesLeft - 1), 300);
                    }
                  });
                } catch (e) {
                  console.log('[App] Forced play error:', e);
                  if (retriesLeft > 0) {
                    setTimeout(() => playWithRetries(retriesLeft - 1), 300);
                  }
                }
              }
            }, 500);
          };
          
          // Start the robust play sequence after a small delay
          setTimeout(() => playWithRetries(), 100);
        } else {
          // Desktop implementation - simpler and more direct
          media.currentTime = loopStart;
          
          // Wait a short time to ensure the seek has completed
          const playWithRetry = () => {
            try {
              const playPromise = media.play();
              if (playPromise !== undefined) {
                playPromise.catch(error => {
                  console.log('[App] Autoplay prevented by browser:', error);
                  // The play request was interrupted by browser policy
                  // Show a play button or notify the user
                });
              }
            } catch (e) {
              console.log('[App] Error during play attempt:', e);
              // If play fails, try again after a short delay
              setTimeout(playWithRetry, 100);
            }
          };
          
          // Start playback with retry logic
          playWithRetry();
        }
      }, loopDelay);
    }
    
    return () => {
      if (timeout) clearTimeout(timeout);
    };
  }, [nativePlaybackTime, loopStart, loopEnd, loopDelay, isUserSeeking, autoLoopEnabled]);

  // Add event listeners to detect when user is seeking
  React.useEffect(() => {
    const media = getActiveMediaElement();
    if (!media) return;
    
    // Only add seeking detection when auto-loop is enabled
    if (!autoLoopEnabled) {
      // Clean up any existing timeouts to avoid memory leaks
      if (seekingTimeoutRef.current) {
        clearTimeout(seekingTimeoutRef.current);
      }
      return;
    }
    
    const onSeeking = () => {
      console.log('[App] User is seeking');
      setIsUserSeeking(true);
      
      // Clear any existing timeout
      if (seekingTimeoutRef.current) {
        clearTimeout(seekingTimeoutRef.current);
      }
    };
    
    const onSeeked = () => {
      // Delay resetting the seeking state to prevent immediate loop activation
      seekingTimeoutRef.current = setTimeout(() => {
        console.log('[App] User finished seeking');
        setIsUserSeeking(false);
      }, 500); // 500ms delay to ensure the user has finished seeking
    };
    
    // Add event listeners
    media.addEventListener('seeking', onSeeking);
    media.addEventListener('seeked', onSeeked);
    
    // Support manual timeline clicking as well
    const onTimeUpdate = () => {
      // Get media duration - use the more reliable pitchManager duration if available
      const totalDuration = pitchManager.current.getTotalDuration() || 
        (media.seekable && media.seekable.length > 0 ? media.seekable.end(0) : media.duration);
      
      // Reset seeking state when we're near the end of the media to prevent errors
      const isNearEndOfMedia = totalDuration > 0 && 
        (totalDuration - media.currentTime < 0.5 || media.ended);
        
      if (isNearEndOfMedia && isUserSeeking) {
        console.log('[App] Near end of media, resetting seeking state to restore loop behavior');
        setIsUserSeeking(false);
        
        // Clear any existing timeout
        if (seekingTimeoutRef.current) {
          clearTimeout(seekingTimeoutRef.current);
        }
        return;
      }
      
      // If there's a large gap between current time and last known playback time
      // and the media is not paused, it might be a manual seeking operation
      const timeDifference = Math.abs(media.currentTime - nativePlaybackTime);
      if (timeDifference > 1.0 && !media.paused) {
        console.log('[App] Detected manual timeline seek:', { 
          currentTime: media.currentTime, 
          lastKnownTime: nativePlaybackTime,
          difference: timeDifference
        });
        setIsUserSeeking(true);
        
        // Clear any existing timeout
        if (seekingTimeoutRef.current) {
          clearTimeout(seekingTimeoutRef.current);
        }
        
        // Reset after a short delay
        seekingTimeoutRef.current = setTimeout(() => {
          setIsUserSeeking(false);
        }, 500);
      }
    };
    
    media.addEventListener('timeupdate', onTimeUpdate);
    
    // Add specific error handling for end of media errors
    const onError = () => {
      console.log('[App] Media error detected, resetting seeking state:', media.error);
      setIsUserSeeking(false);
      
      // Clear any existing timeout
      if (seekingTimeoutRef.current) {
        clearTimeout(seekingTimeoutRef.current);
      }
    };
    
    // Enhanced ended event listener to handle "stuck at end" issues
    const onEnded = () => {
      console.log('[App] Media playback ended, resetting seeking state and looping');
      setIsUserSeeking(false);
      
      // Clear any existing timeout
      if (seekingTimeoutRef.current) {
        clearTimeout(seekingTimeoutRef.current);
      }
      
      // Explicitly handle looping on ended event
      if (loopEnd > loopStart) {
        setTimeout(() => {
          if (media) {
            console.log('[App] Explicit loop to start after ended event');
            media.currentTime = loopStart;
            
            // Attempt to play with error handling
            try {
              const playPromise = media.play();
              if (playPromise !== undefined) {
                playPromise.catch(error => {
                  console.log('[App] Autoplay prevented by browser after loop:', error);
                });
              }
            } catch (e) {
              console.log('[App] Error during play attempt after loop:', e);
            }
          }
        }, loopDelay);
      }
    };
    
    media.addEventListener('ended', onEnded);
    media.addEventListener('error', onError);
    
    return () => {
      media.removeEventListener('seeking', onSeeking);
      media.removeEventListener('seeked', onSeeked);
      media.removeEventListener('timeupdate', onTimeUpdate);
      media.removeEventListener('ended', onEnded);
      media.removeEventListener('error', onError);
      
      if (seekingTimeoutRef.current) {
        clearTimeout(seekingTimeoutRef.current);
      }
    };
  }, [nativePlaybackTime, autoLoopEnabled, isUserSeeking, loopStart, loopEnd, loopDelay]);

  // --- User recording playback time tracking ---
  React.useEffect(() => {
    const audio = userAudioRef.current;
    if (!audio) return;
    let raf: number | null = null;
    const update = () => {
      setUserPlaybackTime(audio.currentTime || 0);
      if (!audio.paused) {
        raf = requestAnimationFrame(update);
      }
    };
    const onPlay = () => {
      userAudioPlayingRef.current = true;
      raf = requestAnimationFrame(update);
    };
    const onPause = () => {
      userAudioPlayingRef.current = false;
      if (raf) cancelAnimationFrame(raf);
    };
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    return () => {
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [userPitchData.times, audioBlob]);

  // On initial load or when nativePitchData changes, fit y axis to full pitch curve
  React.useEffect(() => {
    if (!nativePitchData.pitches.length) return;
    
    console.log('[App] nativePitchData.pitches changed, current loop region:', {
      loopStart,
      loopEnd
    });
    
    // We'll only adjust the Y-axis range but not change the loop region
    const pitches = nativePitchData.pitches.filter(p => p !== null) as number[];
    if (pitches.length > 0) {
      let minPitch = Math.min(...pitches);
      let maxPitch = Math.max(...pitches);
      minPitch = Math.floor(minPitch - 20);
      maxPitch = Math.ceil(maxPitch + 20);
      minPitch = Math.max(0, minPitch);
      maxPitch = Math.min(600, maxPitch);
      if (maxPitch - minPitch < 200) {
        const center = (maxPitch + minPitch) / 2;
        minPitch = Math.max(0, Math.floor(center - 100));
        maxPitch = Math.min(600, Math.ceil(center + 100));
      }
      if (maxPitch - minPitch > 600) {
        const center = (maxPitch + minPitch) / 2;
        minPitch = Math.max(0, Math.floor(center - 300));
        maxPitch = Math.min(600, Math.ceil(center + 300));
      }
      
      // Just update the Y-axis range, don't modify the loop region
      setLoopYFit([minPitch, maxPitch]);
    }
  }, [nativePitchData.pitches]);

  React.useEffect(() => {
    if (!audioBlob) {
      setUserAudioUrl(undefined);
      return;
    }
    const url = URL.createObjectURL(audioBlob);
    setUserAudioUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [audioBlob]);

  React.useEffect(() => {
    if (nativeChartInstance) {
      console.log('Chart ref is now set:', nativeChartInstance);
    }
  }, [nativeChartInstance]);

  // Get the active media element (either video or audio)
  const getActiveMediaElement = () => {
    if (nativeMediaType === 'video') return nativeVideoRef.current;
    if (nativeMediaType === 'audio') return nativeAudioRef.current;
    return null;
  };

  // Add handler for view changes (zooming/panning)
  const viewChangeTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  // Add state for media duration
  const [nativeMediaDuration, setNativeMediaDuration] = useState<number>(0);

  // Update duration when media is loaded
  React.useEffect(() => {
    const media = getActiveMediaElement();
    if (!media) return;
    
    const onLoadedMetadata = () => {
      // Use the maximum of all available duration sources to ensure accuracy
      // This is particularly important for long videos where duration might be initially reported incorrectly
      let detectedDuration = 0;
      
      // Check all possible sources of duration information
      if (pitchManager.current.getTotalDuration() && !isNaN(pitchManager.current.getTotalDuration())) {
        const pmDuration = pitchManager.current.getTotalDuration();
        // Set initial duration if not set yet
        if (detectedDuration === 0) {
          detectedDuration = pmDuration;
        } else {
          // Use the minimum of the two durations to avoid overestimating
          detectedDuration = Math.min(detectedDuration, pmDuration);
        }
      }
      
      if (media.duration && !isNaN(media.duration) && isFinite(media.duration)) {
        if (detectedDuration === 0) {
          detectedDuration = media.duration;
        } else {
          // Use the minimum to avoid overestimating
          detectedDuration = Math.min(detectedDuration, media.duration);
        }
      }
      
      if (media.seekable && media.seekable.length > 0) {
        const seekableEnd = media.seekable.end(media.seekable.length - 1);
        if (detectedDuration === 0) {
          detectedDuration = seekableEnd;
        } else {
          // Use the minimum to avoid overestimating
          detectedDuration = Math.min(detectedDuration, seekableEnd);
        }
      }
      
      // Only update if we have a valid duration
      if (detectedDuration > 0 && !isNaN(detectedDuration) && isFinite(detectedDuration)) {
        console.log('[App] Setting media duration from multiple sources:', {
          pitchManagerDuration: pitchManager.current.getTotalDuration(),
          mediaDuration: media.duration,
          seekableEnd: media.seekable && media.seekable.length > 0 ? media.seekable.end(media.seekable.length - 1) : 'N/A',
          finalDuration: detectedDuration,
          isFinite: isFinite(detectedDuration)
        });
        
        setNativeMediaDuration(detectedDuration);
        
        // Handle specific behaviors based on duration
        if (detectedDuration <= 30 && isLoadingNewFileRef.current) {
          console.log('[App] Short video detected, updating loop region to match duration:', detectedDuration);
          setLoopStartWithLogging(0);
          setLoopEndWithLogging(detectedDuration);
          
          // Set the user-set loop to this region
          userSetLoopRef.current = { start: 0, end: detectedDuration };
        } else if (detectedDuration > 30 && isLoadingNewFileRef.current) {
          // For long videos, ensure the initial loop is correctly set to the first 10 seconds
          console.log('[App] Long video detected, setting initial loop to first 10 seconds');
          const initialViewDuration = 10;
          setLoopStartWithLogging(0);
          setLoopEndWithLogging(initialViewDuration);
          
          // Set the user-set loop to this region
          userSetLoopRef.current = { start: 0, end: initialViewDuration };
        }
      } else {
        console.warn('[App] Invalid duration detected, sources:', {
          pitchManagerDuration: pitchManager.current.getTotalDuration(), 
          mediaDuration: media.duration,
          detected: detectedDuration
        });
      }
    };
    
    media.addEventListener('loadedmetadata', onLoadedMetadata);
    
    // Also try setting initial duration if already loaded
    if (media.readyState >= 1) {
      onLoadedMetadata();
    }
    
    // Also listen for duration changes which can happen as more of the file loads
    const onDurationChange = () => {
      // Re-check all sources when duration changes
      let updatedDuration = 0;
      
      if (pitchManager.current.getTotalDuration() && !isNaN(pitchManager.current.getTotalDuration())) {
        const pmDuration = pitchManager.current.getTotalDuration();
        if (updatedDuration === 0) {
          updatedDuration = pmDuration;
        } else {
          // Use the minimum to avoid overestimating
          updatedDuration = Math.min(updatedDuration, pmDuration);
        }
      }
      
      if (media.duration && !isNaN(media.duration) && isFinite(media.duration)) {
        if (updatedDuration === 0) {
          updatedDuration = media.duration;
        } else {
          // Use the minimum to avoid overestimating
          updatedDuration = Math.min(updatedDuration, media.duration);
        }
      }
      
      if (media.seekable && media.seekable.length > 0) {
        const seekableEnd = media.seekable.end(media.seekable.length - 1);
        if (updatedDuration === 0) {
          updatedDuration = seekableEnd;
        } else {
          // Use the minimum to avoid overestimating
          updatedDuration = Math.min(updatedDuration, seekableEnd);
        }
      }
      
      if (updatedDuration > 0 && !isNaN(updatedDuration) && isFinite(updatedDuration)) {
        // Only update if it's significantly different
        if (Math.abs(updatedDuration - nativeMediaDuration) > 0.1) {
          console.log('[App] Duration changed significantly:', {
            oldDuration: nativeMediaDuration,
            newDuration: updatedDuration
          });
          setNativeMediaDuration(updatedDuration);
          
          // If this is a duration correction event and we're still loading the file
          if (isLoadingNewFileRef.current) {
            if (updatedDuration <= 30) {
              console.log('[App] Duration updated for short video, correcting loop region:', updatedDuration);
              setLoopStartWithLogging(0);
              setLoopEndWithLogging(updatedDuration);
              
              // Set the user-set loop to this region
              userSetLoopRef.current = { start: 0, end: updatedDuration };
            } else {
              // Long video - keep the default 10-second initial view
              console.log('[App] Duration updated for long video, maintaining initial loop region');
            }
          }
        }
      }
    };
    
    media.addEventListener('durationchange', onDurationChange);
    
    // Add canplaythrough event to have one final check of duration
    const onCanPlayThrough = () => {
      if (isLoadingNewFileRef.current) {
        onDurationChange(); // One final duration check
      }
    };
    
    media.addEventListener('canplaythrough', onCanPlayThrough);
    
    return () => {
      media.removeEventListener('loadedmetadata', onLoadedMetadata);
      media.removeEventListener('durationchange', onDurationChange);
      media.removeEventListener('canplaythrough', onCanPlayThrough);
    };
  }, [nativeMediaUrl, nativeMediaType, nativeMediaDuration]);

  // Add wrapped setState functions with logging
  const setLoopStartWithLogging = (value: number) => {
    console.log('[App] setLoopStart called with:', { 
      value, 
      previousValue: loopStart,
      stack: new Error().stack?.split('\n').slice(1, 4).join('\n')
    });
    setLoopStart(value);
  };
  
  const setLoopEndWithLogging = (value: number) => {
    console.log('[App] setLoopEnd called with:', { 
      value, 
      previousValue: loopEnd,
      stack: new Error().stack?.split('\n').slice(1, 4).join('\n') 
    });
    setLoopEnd(value);
  };

  // Add a new useEffect to reset the loading flag after data is processed
  React.useEffect(() => {
    // If we had the loading flag set, and now we have pitch data
    if (isLoadingNewFileRef.current && nativePitchData.times.length > 0) {
      // Wait for the next render cycle to make sure other effects have run
      // This gives the useEffect that sets the loop region time to run
      const timerId = setTimeout(() => {
        console.log('[App] Resetting isLoadingNewFile flag after data loaded, delay complete');
        isLoadingNewFileRef.current = false;
      }, 100); // Give some time for other effects to process
      
      return () => clearTimeout(timerId);
    }
  }, [nativePitchData]);

  // Function to jump to current playback position
  const jumpToPlaybackPosition = () => {
    const media = getActiveMediaElement();
    if (!media || !nativeChartInstance) return;

    const currentTime = media.currentTime;
    const viewDuration = 10; // Show 10 seconds around current position
    
    // Calculate new view window centered around current time
    let startTime = Math.max(0, currentTime - viewDuration * 0.3); // Position current time at 30% of view
    let endTime = startTime + viewDuration;
    
    // If we're near the end of the video, adjust the window
    const totalDuration = pitchManager.current.getTotalDuration();
    if (endTime > totalDuration) {
      endTime = totalDuration;
      startTime = Math.max(0, endTime - viewDuration);
    }
    
    console.log('[App] Jumping to playback position:', {
      currentTime,
      newView: { startTime, endTime },
      autoLoopEnabled
    });
    
    try {
      // Set flag to indicate we're initiating a jump to playback action
      isJumpingToPlaybackRef.current = true;
      
      // First, set loading state to indicate we're changing view
      setIsLoadingPitchData(true);
      
      // If auto-loop is enabled, update the loop region immediately
      if (autoLoopEnabled) {
        console.log('[App] Auto-loop enabled, setting loop region to match view:', { start: startTime, end: endTime });
        // Update userSetLoopRef since this is effectively a user action
        userSetLoopRef.current = { start: startTime, end: endTime };
        setLoopStartWithLogging(startTime);
        setLoopEndWithLogging(endTime);
        
        // Set playback position to start of loop
        if (media) {
          media.currentTime = startTime;
        }
      }
      
      // Trigger data loading first
      handleViewChange(startTime, endTime);
      
      // Wait a short time for data to load before updating the chart view
      setTimeout(() => {
        try {
          // Update chart view after data is loaded
          if (nativeChartInstance && nativeChartInstance.setViewRange) {
            console.log('[App] Updating chart view range to:', { min: startTime, max: endTime });
            nativeChartInstance.setViewRange({ min: startTime, max: endTime });
          } else if (nativeChartInstance && nativeChartInstance.options?.scales?.x) {
            // Fallback if setViewRange not available
            console.log('[App] Fallback: Updating chart scales directly');
            nativeChartInstance.options.scales.x.min = startTime;
            nativeChartInstance.options.scales.x.max = endTime;
            nativeChartInstance.update();
          }
          
          // Clear loading state
          setIsLoadingPitchData(false);
          
          // After a delay, set up a verification check to ensure our view didn't get reset
          setTimeout(() => {
            try {
              // Check if chart view is still at the expected range
              if (nativeChartInstance && nativeChartInstance.scales?.x) {
                const currentMin = nativeChartInstance.scales.x.min;
                const currentMax = nativeChartInstance.scales.x.max;
                
                // If the view got reset, fix it
                if (Math.abs(currentMin - startTime) > 0.1 || Math.abs(currentMax - endTime) > 0.1) {
                  console.log('[App] Jump target lost, restoring view to:', { min: startTime, max: endTime });
                  
                  if (nativeChartInstance.setViewRange) {
                    nativeChartInstance.setViewRange({ min: startTime, max: endTime });
                  } else if (nativeChartInstance.options?.scales?.x) {
                    nativeChartInstance.options.scales.x.min = startTime;
                    nativeChartInstance.options.scales.x.max = endTime;
                    nativeChartInstance.update();
                  }
                  
                  // Also restore the loop region if auto-loop is enabled
                  if (autoLoopEnabled) {
                    console.log('[App] Restoring loop region after view change reset');
                    // Update userSetLoopRef again
                    userSetLoopRef.current = { start: startTime, end: endTime };
                    setLoopStartWithLogging(startTime);
                    setLoopEndWithLogging(endTime);
                  }
                }
              }
            } catch (error) {
              console.error('[App] Error in view restoration check:', error);
            } finally {
              // Always clear the jump to playback flag
              isJumpingToPlaybackRef.current = false;
            }
          }, 500); // Short delay to check after processing
        } catch (error) {
          console.error('[App] Error updating chart view:', error);
          isJumpingToPlaybackRef.current = false;
          setIsLoadingPitchData(false);
        }
      }, 500); // Delay to allow data loading
    } catch (error) {
      console.error('[App] Error initiating jump to playback:', error);
      // Reset flags
      isJumpingToPlaybackRef.current = false;
      setIsLoadingPitchData(false);
    }
  };

  // Add a utility function to detect mobile devices
  const isMobileDevice = () => {
    return /Mobi|Android|iPhone|iPad|iPod|Opera Mini|IEMobile|WPDesktop/i.test(navigator.userAgent);
  };

  return (
    <div 
      className="app-container"
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{
        position: 'relative',
        minHeight: '100vh',
      }}
    >
      {isDragging && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(25, 118, 210, 0.1)',
            border: '2px dashed #1976d2',
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}
        >
          <div
            style={{
              backgroundColor: 'white',
              padding: '20px 40px',
              borderRadius: '8px',
              boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
              fontSize: '1.2em',
              color: '#1976d2',
            }}
          >
            Drop audio/video file here
          </div>
        </div>
      )}
      <div className="container">
        <div className="app-header">
          <button 
            className="icon-button help-button" 
            onClick={() => setShowGuide(true)}
            title="User Guide"
          >
            ?
          </button>
          <h1 className="chorusing-title">Chorusing Drill</h1>
          <button 
            className="icon-button settings-button" 
            onClick={() => setShowSettings(true)}
            title="Settings"
          >
            ⚙️
          </button>
        </div>
        <main style={{ flex: 1, padding: '1rem 0', width: '100%' }}>
          {/* Native Recording Section */}
          <section style={{ marginBottom: '0.25rem' }}>
            <input
              type="file"
              accept="audio/*,video/*"
              style={{ display: 'none' }}
              ref={fileInputRef}
              onChange={handleNativeFileChange}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              style={{
                padding: '8px 20px',
                borderRadius: 4,
                border: 'none',
                background: '#388e3c',
                color: '#fff',
                fontWeight: 500,
                cursor: 'pointer',
                marginBottom: '0.75rem',
                fontSize: '1rem'
              }}
            >
              Load Native Recording
            </button>
            {nativeMediaUrl && nativeMediaType === 'audio' && (
              <audio
                src={nativeMediaUrl}
                controls
                style={{
                  width: '100%',
                  marginBottom: '0.75rem',
                  maxWidth: '100%'
                }}
                ref={nativeAudioRef}
              />
            )}
            {nativeMediaUrl && nativeMediaType === 'video' && (
              <video
                ref={nativeVideoRef}
                src={nativeMediaUrl}
                controls
                playsInline
                loop
                style={{
                  width: '100%',
                  maxHeight: '180px',
                  marginBottom: '0.75rem',
                  maxWidth: '100%'
                }}
              />
            )}
            {/* Loop selection and delay controls (moved above the curve) */}
            {nativePitchData.times.length > 0 && (
              <div className="loop-controls-wrapper">
                <div className="loop-region-display">
                  <span>Loop region: {loopStart.toFixed(2)}s - {loopEnd.toFixed(2)}s</span>
                  <button
                    onClick={() => {
                      // Get accurate duration from PitchDataManager, otherwise fall back to pitch data
                      const duration = pitchManager.current.getTotalDuration() || 
                        (nativePitchData.times.length > 0 ? nativePitchData.times[nativePitchData.times.length - 1] : 0);
                      userSetLoopRef.current = null;
                      console.log('[App] Clearing user-set loop region');
                      setLoopStartWithLogging(0);
                      setLoopEndWithLogging(duration);
                      const media = getActiveMediaElement();
                      if (media) {
                        media.currentTime = 0;
                      }
                    }}
                    title="Reset Loop Region"
                    className="reset-button"
                  >
                    ↺
                  </button>
                </div>
                
                <div className="loop-controls-row">
                  <span>Loop delay (ms):</span>
                  <input
                    type="number"
                    min={0}
                    max={2000}
                    step={50}
                    value={loopDelay}
                    onChange={e => setLoopDelay(Number(e.target.value))}
                    className="loop-delay-input"
                  />
                  <button
                    className="loop-visible-button"
                    title="Set loop to visible region"
                    disabled={!nativeChartInstance}
                    onClick={() => {
                      const chart = nativeChartInstance;
                      console.log('Loop visible button clicked. Chart ref:', chart);
                      if (chart && chart.scales && chart.scales.x) {
                        const xMin = chart.scales.x.min;
                        const xMax = chart.scales.x.max;
                        console.log('Setting loop to visible region:', xMin, xMax);
                        
                        // Update userSetLoopRef since this is a user action
                        userSetLoopRef.current = { start: xMin, end: xMax };
                        
                        setLoopStartWithLogging(xMin);
                        setLoopEndWithLogging(xMax);
                        const media = getActiveMediaElement();
                        if (media) {
                          media.currentTime = xMin;
                        }
                      } else {
                        console.log('Chart or x scale not available');
                      }
                    }}
                  >
                    Loop visible
                  </button>
                </div>
                
                <div className="loop-controls-row">
                  <label className="auto-loop-label">
                    <input
                      type="checkbox"
                      checked={autoLoopEnabled}
                      onChange={(e) => setAutoLoopEnabled(e.target.checked)}
                    />
                    Auto-loop visible area
                  </label>
                  
                  {/* Jump to playback position button - only for long videos */}
                  {nativeMediaDuration > 30 && (
                    <button
                      className="jump-button"
                      title="Jump to current playback position"
                      disabled={!nativeChartInstance || !getActiveMediaElement()}
                      onClick={jumpToPlaybackPosition}
                    >
                      Jump to playback
                    </button>
                  )}
                </div>
              </div>
            )}
            
            {/* Loading indicator */}
            <div style={{ position: 'relative' }}>
              {isLoadingPitchData && (
                <div style={{
                  position: 'absolute',
                  top: 10,
                  right: 10,
                  zIndex: 10,
                  background: 'rgba(25, 118, 210, 0.2)',
                  padding: '4px 8px',
                  borderRadius: 4,
                  fontSize: 12,
                  color: '#1976d2',
                  fontWeight: 'bold',
                  pointerEvents: 'none',
                }}>
                  Loading...
                </div>
              )}
              
              <PitchGraphWithControls
                onChartReady={setNativeChartInstance}
                times={nativePitchData.times}
                pitches={nativePitchData.pitches}
                label="Native Pitch (Hz)"
                color="#388e3c"
                loopStart={loopStart}
                loopEnd={loopEnd}
                yFit={loopYFit}
                playbackTime={nativePlaybackTime}
                onLoopChange={onLoopChangeHandler}
                onViewChange={onViewChangeHandler}
                totalDuration={nativeMediaDuration}
                initialViewDuration={nativeMediaDuration > 30 ? 10 : undefined}
                isJumpingToPlayback={isJumpingToPlaybackRef.current}
                yAxisConfig={{
                  beginAtZero: false,
                  suggestedMin: loopYFit ? loopYFit[0] : DEFAULT_MIN_PITCH,
                  suggestedMax: loopYFit ? loopYFit[1] : DEFAULT_MAX_PITCH,
                  ticks: {
                    stepSize: 50,
                    precision: 0
                  }
                }}
              />
            </div>
          </section>

          {/* User Recording Section */}
          <section>
            <PitchGraphWithControls
              times={userPitchData.times}
              pitches={userPitchData.pitches}
              label="Your Pitch (Hz)"
              color="#1976d2"
              playbackTime={userPlaybackTime}
              totalDuration={userPitchData.times.length > 0 ? userPitchData.times[userPitchData.times.length - 1] : 0}
              yFit={loopYFit}
              isUserRecording={isUserRecording}
              onChartReady={setUserChartInstance}
              yAxisConfig={{
                beginAtZero: false,
                suggestedMin: loopYFit ? loopYFit[0] : DEFAULT_MIN_PITCH,
                suggestedMax: loopYFit ? loopYFit[1] : DEFAULT_MAX_PITCH,
                ticks: {
                  stepSize: 50,
                  precision: 0
                }
              }}
            />
            <Recorder
              onRecordingComplete={(_, blob: Blob) => setAudioBlob(blob)}
              audioUrl={userAudioUrl}
              audioRef={userAudioRef}
              showPlayer={true}
            />
          </section>
        </main>
        <Footer />
      </div>

      {/* User Guide Overlay */}
      {showGuide && (
        <div className="overlay">
          <div className="overlay-content guide-content">
            <div className="overlay-header">
              <h2>User Guide</h2>
              <button 
                className="icon-button close-button" 
                onClick={() => setShowGuide(false)}
                title="Close"
              >
                ×
              </button>
            </div>
            <div className="overlay-body">
              <div className="guide-section">
                <h3>Purpose of the Chorusing Trainer</h3>
                <p>
                  This tool provides an easy way to do high repetition chorusing practice.
                  Chorusing in language learning is the practice of learners repeating words or phrases in unison with a native speaker or instructor.
                  It's especially effective for developing fluency and natural speech in early stages of language acquisition, but will be helpful at any stage.
                </p>
                
                <h4>Benefits</h4>
                <ul>
                  <li>Reinforces correct pronunciation, rhythm, and intonation</li>
                  <li>Builds muscle memory for speech patterns</li>
                  <li>Reduces anxiety about speaking</li>
                  <li>Aids listening and imitation skills through synchronized repetition</li>
                </ul>
                
                <h4>The Method</h4>
                <ol>
                  <li>Play a word, phrase or short sentence spoken by a native speaker in a loop</li>
                  <li>Just listen a few times, really focus on what you hear (sounds, rhythm, pitch)</li>
                  <li>Then say it out loud at exactly the same time as the native speaker</li>
                  <li>Repeat this 10, 50, 100 times until you can match their rhythm perfectly</li>
                  <li>Record yourself and see if your pitch curve shape matches that of the native speaker</li>
                  <li>Repeat, repeat, repeat until you get it as perfect as you feel you can for that day</li>
                  <li>Only then move on to another word, phrase or short sentence</li>
                  <li>Do this daily for a few weeks and see</li>
                </ol>
              </div>
              
              <div className="guide-section">
                <h3>Recording Length Recommendations</h3>
                <h4>Optimal Recording Length</h4>
                <ul>
                  <li><strong>Ideal Length</strong>: 5-30 seconds</li>
                  <li><strong>Maximum Recommended</strong>: 2 minutes</li>
                </ul>
                
                <h4>Why Short Recordings Work Better</h4>
                <ol>
                  <li><strong>Better Focus</strong>: Short recordings help you focus on specific pitch patterns or problem areas</li>
                  <li><strong>Easier Comparison</strong>: Comparing your recording with the native sample is more effective with shorter segments</li>
                  <li><strong>Clearer Visualization</strong>: The pitch graph is more readable and detailed with shorter recordings</li>
                  <li><strong>Faster Feedback</strong>: You can iterate and improve more quickly with shorter practice segments</li>
                  <li><strong>Performance</strong>: Browser performance remains smooth with shorter recordings</li>
                </ol>
                
                <h4>Tips for Effective Practice</h4>
                <ul>
                  <li>Record individual words or short phrases when starting out</li>
                  <li>Progress to full sentences as you improve</li>
                  <li>For longer content, break it into 15-30 second segments</li>
                  <li>Use the loop region feature to practice specific parts of longer recordings</li>
                  <li>Practice the same segment multiple times rather than recording longer passages</li>
                </ul>
              </div>
              
              <div className="guide-section">
                <h3>Technical Considerations</h3>
                <p>
                  While there is no hard limit on recording length, browser performance may degrade with very long recordings, especially on mobile devices. 
                  The app has been optimized for recordings in the 5-30 second range, which is ideal for focused practice. 
                  Loading large video files on mobile devices can likewise be problematic. Consider editing large files or making short screen recordings of segments you want to practice.
                </p>
                
                <h4>Caution for iPhone Users</h4>
                <p>
                  On the iPhone, starting a recording inside a web browser will cause all audio output to use the ringer's audio level. This can by default be very loud!
                </p>
                <p>
                  To gain control over the ringer level on iPhone, you can:
                </p>
                <ol>
                  <li><strong>Open Settings</strong>: Find and tap the Settings app on your iPhone's home screen</li>
                  <li><strong>Go to Sounds & Haptics</strong>: Scroll down and tap on "Sounds & Haptics"</li>
                  <li><strong>Adjust Ringer Volume</strong>: In the "Ringer and Alerts" section, you'll see a slider. Drag the slider left or right to adjust the ringer volume to your desired level</li>
                  <li><strong>Change with Buttons (Optional)</strong>: If you prefer to use the volume buttons, you can enable "Change with Buttons" by toggling the switch to the right</li>
                </ol>
                
                <h4>Supported File Formats</h4>
                <p>Different browsers support different audio and video formats:</p>
                <ul>
                  <li><strong>Audio</strong>: MP3, WAV, OGG, AAC (M4A) are widely supported across browsers</li>
                  <li><strong>Video</strong>: MP4 (H.264), WebM, and OGG (Theora) are most compatible</li>
                  <li>For best compatibility, use MP3 for audio and MP4 (H.264) for video</li>
                  <li>Some mobile browsers may have limitations with certain file formats</li>
                </ul>
              </div>
              
              <div className="guide-section">
                <h3>Navigation and Zoom Controls</h3>
                
                <h4>Desktop Controls</h4>
                <ul>
                  <li><strong>Mouse wheel</strong>: Zoom in/out on the pitch curve</li>
                  <li><strong>Click and drag</strong>: Pan the view horizontally when zoomed in</li>
                  <li><strong>↺ button</strong>: Reset zoom to show the full content</li>
                  <li><strong>Loop visible button</strong>: Set the playback loop to match the visible area</li>
                </ul>
                
                <h4>Mobile Controls</h4>
                <ul>
                  <li><strong>Pinch gesture</strong>: Zoom in/out on the pitch curve</li>
                  <li><strong>Single finger drag</strong>: Pan the view horizontally when zoomed in</li>
                  <li><strong>↺ button</strong>: Reset zoom to show the full content</li>
                  <li><strong>Loop visible button</strong>: Set the playback loop to match the visible area</li>
                </ul>
                
                <h4>Additional Features</h4>
                <ul>
                  <li><strong>Drag loop selection edges</strong>: Drag the blue edges of the loop selection area on the graph to select the segment you want to practice</li>
                  <li><strong>Drag graph edges</strong>: Drag from the margins of the graph to bring the loop selection edges into your current view any time</li>
                  <li><strong>Auto-loop checkbox</strong>: When enabled, the loop region will automatically match the visible area when you pan</li>
                  <li><strong>Loop delay</strong>: Adjusts the pause time (in milliseconds) between loop repetitions</li>
                  <li><strong>Jump to playback</strong>: Jumps the view to center around the current playback position (only available for long videos)</li>
                </ul>
              </div>
              
              <div className="guide-section">
                <h3>Tips for Effective Practice</h3>
                <ol>
                  <li>
                    <strong>Compare native and your recordings</strong>:
                    <ul>
                      <li>Load a native recording using the "Load Native Recording" button</li>
                      <li>Record your own voice using the microphone button</li>
                      <li>Visually compare your pitch pattern with the native speaker</li>
                      <li>The overall shape of the curve is important. Its position on the y-axis can differ depending on the natural pitch of your voice</li>
                    </ul>
                  </li>
                  <li>
                    <strong>Focus on specific segments</strong>:
                    <ul>
                      <li>Zoom in on challenging parts of the utterance</li>
                      <li>Set a tight loop region around difficult pitch patterns</li>
                      <li>Adjust the loop delay if needed to give yourself time to breathe between repetitions</li>
                    </ul>
                  </li>
                  <li>
                    <strong>Mobile-specific tips</strong>:
                    <ul>
                      <li>Hold your device in portrait orientation for better visualization</li>
                      <li>Use small, deliberate pinch gestures for precise zooming</li>
                      <li>Tap the reset zoom button on the curve (↺) if you get lost</li>
                    </ul>
                  </li>
                </ol>
              </div>
              
              <div className="guide-section">
                <h3>Pitch Visualization Details</h3>
                <p>
                  The pitch visualization shows the fundamental frequency (pitch) of the voice over time:
                </p>
                <ul>
                  <li><strong>Blue line</strong>: Your recorded voice</li>
                  <li><strong>Green line</strong>: Native speaker's voice</li>
                </ul>
                <p>
                  The y-axis shows frequency in Hertz (Hz), typically ranging from 50-500 Hz, with male voices generally lower (80-180 Hz) and female voices higher (160-300 Hz).
                </p>
              </div>
            </div>
            <div className="overlay-footer">
              <button 
                className="button close-overlay-button" 
                onClick={() => setShowGuide(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Settings Overlay */}
      {showSettings && (
        <div className="overlay">
          <div className="overlay-content settings-content">
            <div className="overlay-header">
              <h2>Settings</h2>
              <button 
                className="icon-button close-button" 
                onClick={() => setShowSettings(false)}
                title="Close"
              >
                ×
              </button>
            </div>
            <div className="overlay-body">
              <div className="settings-section">
                <h3>Pitch Display Settings</h3>
                <div className="setting-group">
                  <label className="setting-label">
                    <span>Y-Axis Range</span>
                    <div className="setting-description">
                      Adjust the minimum and maximum values for the pitch display
                    </div>
                  </label>
                  <div className="setting-placeholder">
                    <i>Pitch range adjustment will be implemented here</i>
                  </div>
                </div>
                
                <div className="setting-group">
                  <label className="setting-label">
                    <span>Pitch Curve Smoothing</span>
                    <div className="setting-description">
                      Choose the amount of smoothing applied to pitch curves
                    </div>
                  </label>
                  <div className="setting-placeholder">
                    <i>Smoothing method options will be implemented here</i>
                  </div>
                </div>
              </div>
              
              <div className="settings-section">
                <h3>Keyboard Shortcuts</h3>
                <div className="setting-group">
                  <div className="setting-description">
                    Current keyboard shortcuts:
                  </div>
                  <ul className="shortcuts-list">
                    <li><strong>Play/Pause native recording</strong>: spacebar</li>
                    <li><strong>Loop visible</strong>: l</li>
                    <li><strong>Start/stop user recording</strong>: r</li>
                    <li><strong>Play/Pause user recording</strong>: e</li>
                  </ul>
                  <div className="setting-placeholder">
                    <i>Shortcut customization will be implemented here</i>
                  </div>
                </div>
              </div>
              
              <div className="settings-section">
                <h3>Interface Settings</h3>
                <div className="setting-group">
                  <label className="setting-label">
                    <span>Tooltips</span>
                    <div className="setting-description">
                      Configure when and how tooltips are displayed
                    </div>
                  </label>
                  <div className="setting-placeholder">
                    <i>Tooltip configuration will be implemented here</i>
                  </div>
                </div>
                
                <div className="setting-group">
                  <label className="setting-label">
                    <span>Loop Overlay Appearance</span>
                    <div className="setting-description">
                      Adjust the transparency and color of the loop region overlay
                    </div>
                  </label>
                  <div className="setting-placeholder">
                    <i>Loop overlay appearance options will be implemented here</i>
                  </div>
                </div>
              </div>
              
              <div className="settings-section">
                <h3>Advanced Settings</h3>
                <div className="setting-group">
                  <label className="setting-label">
                    <span>Pitch Detection Range</span>
                    <div className="setting-description">
                      Configure the minimum and maximum pitch detection thresholds
                    </div>
                  </label>
                  <div className="setting-placeholder">
                    <i>Pitch detection range settings will be implemented here</i>
                  </div>
                </div>
              </div>
            </div>
            <div className="overlay-footer">
              <button 
                className="button close-overlay-button" 
                onClick={() => setShowSettings(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .pitch-graph-container {
          touch-action: pinch-zoom pan-x pan-y;
        }
        
        /* App header with navigation buttons */
        .app-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 1rem;
          padding: 0.5rem 0;
        }
        
        /* Icon buttons for navigation */
        .icon-button {
          background: none;
          border: none;
          font-size: 1.5rem;
          cursor: pointer;
          width: 40px;
          height: 40px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          color: #1976d2;
          transition: background-color 0.2s;
        }
        
        .icon-button:hover {
          background-color: rgba(25, 118, 210, 0.1);
        }
        
        .help-button {
          font-weight: bold;
          font-size: 1.8rem;
        }
        
        .settings-button {
          font-size: 1.8rem;
        }
        
        .close-button {
          font-size: 1.8rem;
        }
        
        /* Overlay styles */
        .overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background-color: rgba(0, 0, 0, 0.5);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
          overflow-y: auto;
          padding: 1rem;
        }
        
        .overlay-content {
          background-color: white;
          border-radius: 8px;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
          width: 100%;
          max-width: 800px;
          max-height: 90vh;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          text-align: left; /* Ensure text is left-aligned */
          color: #333; /* Ensure text is dark */
        }
        
        .overlay-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 1rem;
          border-bottom: 1px solid #eee;
        }
        
        .overlay-header h2 {
          margin: 0;
          font-size: 1.5rem;
          color: #333;
        }
        
        .overlay-body {
          padding: 1rem;
          overflow-y: auto;
          flex: 1;
          color: #333; /* Ensure text is dark */
        }
        
        .overlay-footer {
          padding: 1rem;
          border-top: 1px solid #eee;
          display: flex;
          justify-content: flex-end;
        }
        
        .button {
          padding: 0.5rem 1rem;
          border-radius: 4px;
          border: none;
          background-color: #1976d2;
          color: white;
          font-weight: 500;
          cursor: pointer;
          font-size: 1rem;
        }
        
        .button:hover {
          background-color: #1565c0;
        }
        
        .close-overlay-button {
          min-width: 100px;
        }
        
        /* Loop controls styling */
        .loop-controls-wrapper {
          text-align: center;
          margin: 0.5rem auto;
          max-width: 500px;
        }
        
        .loop-region-display {
          display: flex;
          justify-content: center;
          align-items: center;
          gap: 8px;
          margin-bottom: 8px;
          font-size: 12px;
        }
        
        .reset-button {
          padding: 2px 6px;
          border-radius: 50%;
          border: none;
          background: transparent;
          color: #1976d2;
          font-size: 1.1rem;
          cursor: pointer;
          min-width: 0;
          min-height: 0;
          line-height: 1;
        }
        
        .loop-controls-row {
          display: flex;
          justify-content: center;
          align-items: center;
          gap: 8px;
          margin-bottom: 8px;
          font-size: 12px;
        }
        
        .loop-delay-input {
          width: 80px;
          min-width: 80px;
        }
        
        .loop-visible-button, .jump-button {
          font-size: 12px;
          padding: 2px 8px;
        }
        
        .auto-loop-label {
          display: flex;
          align-items: center;
          gap: 4px;
          font-size: 12px;
        }
        
        @media (max-width: 768px) {
          .container {
            width: 100vw;
            overflow-x: hidden;
            box-sizing: border-box;
            padding-left: max(2vw, env(safe-area-inset-left));
            padding-right: max(2vw, env(safe-area-inset-right));
          }
          .pitch-graph-container {
            touch-action: none;
            height: 160px !important;
            min-height: 160px !important;
            max-height: 160px !important;
            width: 100% !important;
            max-width: 100% !important; 
            box-sizing: border-box;
            padding: 0;
            margin: 0;
          }
          .chorusing-title {
            font-size: 1.3rem;
            margin-bottom: 0.5rem;
          }
          .container, main, section, .pitch-graph-container, .chorusing-title {
            font-size: 0.95rem;
          }
          button, input, select {
            font-size: 0.95rem !important;
            padding: 4px 8px !important;
          }
          
          .auto-loop-label {
            white-space: normal;
            line-height: 1.2;
          }
          
          .loop-controls-row {
            flex-wrap: wrap;
          }
        }
        
        /* Desktop styles */
        @media (min-width: 769px) {
          .loop-controls-wrapper {
            max-width: 500px;
          }
        }
        
        body {
          overflow-x: hidden;
        }
        
        /* Prevent body scrolling when overlay is open */
        body.overlay-open {
          overflow: hidden;
        }
        
        /* Mobile responsive adjustments */
        @media (max-width: 768px) {
          .container {
            width: 100vw;
            overflow-x: hidden;
            box-sizing: border-box;
            padding-left: max(2vw, env(safe-area-inset-left));
            padding-right: max(2vw, env(safe-area-inset-right));
          }
          
          .overlay {
            padding: 0.5rem;
          }
          
          .overlay-content {
            max-width: 100%;
            max-height: 100vh;
            border-radius: 0;
            background-color: #242424; /* Dark background for mobile */
            color: #ffffff; /* Brightest text for dark background */
          }
          
          .overlay-header {
            border-bottom: 1px solid #444;
          }
          
          .overlay-header h2 {
            color: #ffffff;
            font-size: 1.2rem;
          }
          
          .overlay-body {
            padding: 0.75rem;
            color: #ffffff;
          }
          
          .overlay-footer {
            border-top: 1px solid #444;
          }
          
          .icon-button {
            width: 36px;
            height: 36px;
          }
          
          .app-header {
            padding: 0.25rem 0;
          }
          
          .help-button, .settings-button, .close-button {
            font-size: 1.5rem;
          }
          
          .close-button {
            color: #ffffff;
          }
          
          .guide-section h3,
          .settings-section h3 {
            color: #6bb5ff; /* Even brighter blue for dark background */
            border-bottom: 1px solid #444;
          }
          
          .guide-section h4 {
            color: #ffffff;
          }
          
          .guide-section p,
          .guide-section li,
          .setting-description,
          .shortcuts-list li {
            color: #ffffff;
          }
          
          .setting-label span {
            color: #ffffff;
          }
          
          .setting-placeholder {
            background-color: #333;
            color: #ffffff;
          }
          
          .guide-section strong,
          .shortcuts-list strong {
            color: #ffffff;
            font-weight: 700; /* Bolder for more emphasis */
          }
          
          /* Fix for list markers in dark mode */
          .guide-section ul li::marker,
          .guide-section ol li::marker {
            color: #ffffff;
          }
          
          /* Increase contrast for all text elements */
          .guide-section *,
          .settings-section * {
            color: #ffffff !important; /* Force white text everywhere */
          }
          
          /* Special styling for headings */
          .guide-section h3,
          .settings-section h3 {
            color: #6bb5ff !important; /* Keep headings blue but brighter */
          }
          
          /* Ensure all placeholders are visible */
          .setting-placeholder i {
            color: #ffffff;
          }
          
          .pitch-graph-container {
            touch-action: none;
            height: 160px !important;
            min-height: 160px !important;
            max-height: 160px !important;
            width: 100% !important;
            max-width: 100% !important; 
            box-sizing: border-box;
            padding: 0;
            margin: 0;
          }
          
          .chorusing-title {
            font-size: 1.3rem;
            margin-bottom: 0.5rem;
          }
          
          .container, main, section, .pitch-graph-container, .chorusing-title {
            font-size: 0.95rem;
          }
          
          button, input, select {
            font-size: 0.95rem !important;
            padding: 4px 8px !important;
          }
          
          .auto-loop-label {
            white-space: normal;
            line-height: 1.2;
          }
          
          .loop-controls-row {
            flex-wrap: wrap;
          }
        }
        
        /* Prevent body scrolling when overlay is open */
        body.overlay-open {
          overflow: hidden;
        }
        
        /* Guide specific styles */
        .guide-section {
          margin-bottom: 2rem;
          text-align: left;
        }
        
        .guide-section h3 {
          margin-top: 0;
          color: #1976d2;
          border-bottom: 1px solid #eee;
          padding-bottom: 0.5rem;
          margin-bottom: 1rem;
          text-align: left;
        }
        
        .guide-section h4 {
          margin-top: 1.5rem;
          margin-bottom: 0.5rem;
          color: #333;
          text-align: left;
        }
        
        .guide-section p {
          margin-bottom: 1rem;
          line-height: 1.5;
          color: #333; /* Ensure text is dark */
          text-align: left;
        }
        
        .guide-section ul, .guide-section ol {
          padding-left: 1.5rem;
          margin-bottom: 1rem;
          text-align: left;
        }
        
        .guide-section li {
          margin-bottom: 0.5rem;
          line-height: 1.5;
          color: #333; /* Ensure text is dark */
          text-align: left;
        }
        
        .guide-section strong {
          font-weight: 600;
          color: #333;
        }
        
        /* Settings specific styles */
        .settings-section {
          margin-bottom: 2rem;
          padding-bottom: 1rem;
          border-bottom: 1px solid #eee;
          text-align: left;
        }
        
        .settings-section:last-child {
          border-bottom: none;
        }
        
        .settings-section h3 {
          margin-top: 0;
          color: #1976d2;
          margin-bottom: 1rem;
        }
        
        .setting-group {
          margin-bottom: 1.5rem;
        }
        
        .setting-label {
          display: block;
          margin-bottom: 0.5rem;
        }
        
        .setting-label span {
          font-weight: 600;
          color: #333;
          display: block;
          margin-bottom: 0.25rem;
        }
        
        .setting-description {
          font-size: 0.9rem;
          color: #666;
          margin-bottom: 0.5rem;
        }
        
        .setting-placeholder {
          background-color: #f5f5f5;
          padding: 0.75rem;
          border-radius: 4px;
          font-size: 0.9rem;
          color: #666;
          font-style: italic;
        }
        
        .shortcuts-list {
          list-style-type: none;
          padding-left: 0;
          margin-bottom: 1rem;
        }
        
        .shortcuts-list li {
          margin-bottom: 0.5rem;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        
        .shortcuts-list strong {
          margin-right: 1rem;
        }
      `}</style>
    </div>
  )
}

export default App
