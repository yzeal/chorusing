// IMPORTANT: Modified by user to test Git detection - delete this line later
import React, { useState, useRef, useCallback, useEffect } from 'react'
import Footer from './components/Footer'
import Recorder from './components/Recorder'
import PitchGraphWithControls from './components/PitchGraph'
import type { Chart } from 'chart.js';
import './App.css'
import { PitchDetector } from 'pitchy'
import { PitchDataManager } from './services/PitchDataManager'
import { convertToVtt } from './utils/subtitleConverter';

// Create logging wrapper functions that only log in development mode
const isProduction = import.meta.env.MODE === 'production';

// Log function that suppresses logs in production - using let instead of const
let appLog = (message: string, ...args: any[]) => {
  if (!isProduction) {
    console.log(message, ...args);
  }
};

// Warning function that suppresses warnings in production
const appWarn = (message: string, ...args: any[]) => {
  if (!isProduction) {
    console.warn(message, ...args);
  }
};

// Error logs will show even in production
const appError = (message: string, ...args: any[]) => {
  console.error(message, ...args);
};

// Initialize mobile debug console if needed
if (typeof window !== 'undefined' && window.location.search.includes('debug=true')) {
  appLog('Initializing mobile debug console with Eruda');
  
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
    appLog('Mobile debug console ready!', {
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
            appError('Error in export:', err);
            alert('Export failed: ' + String(err));
          }
        };
        
        // Add instructions to console
        appLog('To see more detailed instructions, run:');
        appLog('window.exportLogs()');
      } catch (err) {
        appError('Error setting up log function:', err);
      }
    };
    
    // Add the export function after a short delay to ensure Eruda is fully initialized
    setTimeout(addExportButton, 1000);
  };

  // Enhance appLog to show timestamp
  const originalConsoleLog = appLog;
  appLog = function(...args) {
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

  // Add state for subtitle font size (default to 2em which is double the normal size)
  const [subtitleFontSize, setSubtitleFontSize] = useState<number>(2);

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

  // Add state for subtitle
  const [currentSubtitle, setCurrentSubtitle] = useState<{
    file: File | undefined;
    fileName: string | undefined;
  }>({
    file: undefined,
    fileName: undefined
  });

  // Add state for subtitle URL
  const [subtitleUrl, setSubtitleUrl] = useState<string | undefined>(undefined);

  const subtitleInputRef = useRef<HTMLInputElement>(null);

  
  // Update subtitle file change handler
  const handleSubtitleChange = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      // Convert subtitle file if needed
      const result = await convertToVtt(file);
      
      if (!result.success) {
        appError(result.error || 'Unknown error converting subtitle file');
        return;
      }

      // Clean up old URL if it exists
      if (subtitleUrl) {
        URL.revokeObjectURL(subtitleUrl);
      }

      // Create a new Blob with the VTT content
      const vttBlob = new Blob([result.content], { type: 'text/vtt' });
      const newUrl = URL.createObjectURL(vttBlob);
      
      setSubtitleUrl(newUrl);
      setCurrentSubtitle({
        file,
        fileName: file.name + (file.name.endsWith('.vtt') ? '' : ' (converted to VTT)')
      });
      
      // Force video reload and enable track
      const video = nativeVideoRef.current;
      if (video) {
        const currentTime = video.currentTime;
        video.load();
        // Wait for video to reload before enabling track
        video.onloadeddata = () => {
          video.currentTime = currentTime;
          // Enable the text track
          if (video.textTracks[0]) {
            video.textTracks[0].mode = 'showing';
          }
        };
      }
    } catch (error) {
      appError('Error processing subtitle file:', error instanceof Error ? error.message : String(error));
    }
  };

  // Clean up subtitle URL when component unmounts
  useEffect(() => {
    return () => {
      if (subtitleUrl) {
        URL.revokeObjectURL(subtitleUrl);
      }
    };
  }, [subtitleUrl]);



  const [nativeChartInstance, setNativeChartInstance] = useState<ExtendedChart | null>(null);

  // Add drag state
  const [isDragging, setIsDragging] = useState(false);

  const pitchManager = useRef(new PitchDataManager());

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
  
  // Add settings state for Y-axis range
  const [nativeMinPitch, setNativeMinPitch] = useState<number>(() => {
    const savedValue = localStorage.getItem('nativeMinPitch');
    return savedValue ? Number(savedValue) : DEFAULT_MIN_PITCH;
  });
  
  const [nativeMaxPitch, setNativeMaxPitch] = useState<number>(() => {
    const savedValue = localStorage.getItem('nativeMaxPitch');
    return savedValue ? Number(savedValue) : DEFAULT_MAX_PITCH;
  });
  
  const [userMinPitch, setUserMinPitch] = useState<number>(() => {
    const savedValue = localStorage.getItem('userMinPitch');
    return savedValue ? Number(savedValue) : DEFAULT_MIN_PITCH;
  });
  
  const [userMaxPitch, setUserMaxPitch] = useState<number>(() => {
    const savedValue = localStorage.getItem('userMaxPitch');
    return savedValue ? Number(savedValue) : DEFAULT_MAX_PITCH;
  });

  // Add state for pitch detection settings
  const [pitchDetectionSettings, setPitchDetectionSettings] = useState(() => {
    const savedSettings = localStorage.getItem('pitchDetectionSettings');
    if (savedSettings) {
      try {
        return JSON.parse(savedSettings);
      } catch (e) {
        appError('Error parsing saved pitch detection settings:', e);
      }
    }
    // Default settings - these match the constants at the top of the file
    return {
      minPitch: MIN_PITCH,
      maxPitch: MAX_PITCH,
      clarityThreshold: MIN_CLARITY
    };
  });
  
  // Save Y-axis range settings to localStorage when they change
  useEffect(() => {
    localStorage.setItem('nativeMinPitch', nativeMinPitch.toString());
  }, [nativeMinPitch]);
  
  useEffect(() => {
    localStorage.setItem('nativeMaxPitch', nativeMaxPitch.toString());
  }, [nativeMaxPitch]);
  
  useEffect(() => {
    localStorage.setItem('userMinPitch', userMinPitch.toString());
  }, [userMinPitch]);
  
  useEffect(() => {
    localStorage.setItem('userMaxPitch', userMaxPitch.toString());
  }, [userMaxPitch]);
  
  // Function to reset Y-axis range to defaults
  const resetNativeYAxisRange = () => {
    setNativeMinPitch(DEFAULT_MIN_PITCH);
    setNativeMaxPitch(DEFAULT_MAX_PITCH);
  };
  
  const resetUserYAxisRange = () => {
    setUserMinPitch(DEFAULT_MIN_PITCH);
    setUserMaxPitch(DEFAULT_MAX_PITCH);
  };
  
  // Get dynamic Y-axis range for native recording
  const getNativeYAxisRange = useCallback((): [number, number] => {
    return [nativeMinPitch, nativeMaxPitch];
  }, [nativeMinPitch, nativeMaxPitch]);
  
  // Get dynamic Y-axis range for user recording
  const getUserYAxisRange = useCallback((): [number, number] => {
    return [userMinPitch, userMaxPitch];
  }, [userMinPitch, userMaxPitch]);
  
  // Force chart updates when settings change
  useEffect(() => {
    if (nativeChartInstance) {
      nativeChartInstance.update();
    }
  }, [nativeMinPitch, nativeMaxPitch, nativeChartInstance]);
  
  useEffect(() => {
    if (userChartInstance) {
      userChartInstance.update();
    }
  }, [userMinPitch, userMaxPitch, userChartInstance]);
  
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
      appLog('[App] Directly setting user recording view range:', { min: 0, max: duration });
      
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
    appLog('[App] Loading new file via drop, setting isLoadingNewFile flag:', isLoadingNewFileRef.current);

    // Reset user-set loop region when loading a new file
    userSetLoopRef.current = null;
    appLog('[App] New file loaded, clearing user-set loop region');

    // Use the existing file handling logic
    const url = URL.createObjectURL(file);
    setNativeMediaUrl(url);
    
    if (file.type.startsWith('audio/')) {
      setNativeMediaType('audio');
      try {
        appLog('[App] Initializing PitchDataManager with audio file:', file.name);
        await pitchManager.current.initialize(file);

        // For long videos, start with empty data
        const initialData = pitchManager.current.isLongVideoFile() ? 
          { times: [], pitches: [] } : 
          pitchManager.current.getPitchDataForTimeRange(0, pitchManager.current.getTotalDuration());
        
        // Only apply smoothing for short videos
        if (!pitchManager.current.isLongVideoFile()) {
          const smoothingWindowSize = separateSmoothingSettings ? 
            getWindowSizeFromSettings(smoothingStyle, nativeSmoothingLevel) : 
            getWindowSizeFromSettings(smoothingStyle, smoothingLevel);
        
          const enhancedData = {
            times: initialData.times,
            pitches: smoothPitch(initialData.pitches, smoothingWindowSize)
          };
          appLog('[App] Initial pitch data loaded and smoothed with window size:', smoothingWindowSize);
          setNativePitchData(enhancedData);
        } else {
          setNativePitchData(initialData);
        }
      } catch (error) {
        appError('Error processing audio:', error);
        setNativePitchData({ times: [], pitches: [] });
      }
    } else if (file.type.startsWith('video/')) {
      setNativeMediaType('video');
      try {
        appLog('[App] Initializing PitchDataManager with video file:', file.name);
        await pitchManager.current.initialize(file);

        // For long videos, start with empty data
        const initialData = pitchManager.current.isLongVideoFile() ? 
          { times: [], pitches: [] } : 
          pitchManager.current.getPitchDataForTimeRange(0, pitchManager.current.getTotalDuration());

        // Only apply smoothing for short videos
        if (!pitchManager.current.isLongVideoFile()) {
          const smoothingWindowSize = separateSmoothingSettings ? 
            getWindowSizeFromSettings(smoothingStyle, nativeSmoothingLevel) : 
            getWindowSizeFromSettings(smoothingStyle, smoothingLevel);

          const enhancedData = {
            times: initialData.times,
            pitches: smoothPitch(initialData.pitches, smoothingWindowSize)
          };
          appLog('[App] Initial pitch data loaded and smoothed with window size:', smoothingWindowSize);
          setNativePitchData(enhancedData);
        } else {
          setNativePitchData(initialData);
        }
      } catch (error) {
        appError('Error processing video:', error);
        setNativePitchData({ times: [], pitches: [] });
      }
    } else {
      setNativeMediaType(null);
      setNativePitchData({ times: [], pitches: [] });
    }
    
    // Don't reset the flag here - it will be reset by a useEffect
    appLog('[App] File loading complete, isLoadingNewFile still set:', isLoadingNewFileRef.current);
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
        
        // Use user-defined pitch detection settings instead of constants
        const { minPitch, maxPitch, clarityThreshold } = pitchDetectionSettings;
        
        for (let i = 0; i + frameSize < channelData.length; i += hopSize) {
          const frame = channelData.slice(i, i + frameSize);
          const [pitch, clarity] = detector.findPitch(frame, sampleRate);
          if (pitch >= minPitch && pitch <= maxPitch && clarity >= clarityThreshold) {
            pitches.push(pitch);
          } else {
            pitches.push(null);
          }
          times.push(i / sampleRate);
        }
        
        // First apply basic median filter
        const basicSmoothed = medianFilter(pitches, MEDIAN_FILTER_SIZE);
        
        // Then apply enhanced smoothing with configurable settings
        const smoothingWindowSize = separateSmoothingSettings ?
          getWindowSizeFromSettings(smoothingStyle, userSmoothingLevel) :
          getWindowSizeFromSettings(smoothingStyle, smoothingLevel);
        
        const enhancedSmooth = smoothPitch(basicSmoothed, smoothingWindowSize);
        
        appLog('[App] User recording processed with pitch settings:', { minPitch, maxPitch, clarityThreshold });
        
        setUserPitchData({ times, pitches: enhancedSmooth });
        
        // Calculate the initial range for user pitch data when extracted
        const [minPitchRange, maxPitchRange] = calculateInitialPitchRange(enhancedSmooth);
        
        // Use the same y-axis range for user data as we do for native data
        // This makes it easier to compare the two
        const currentYFit = loopYFit || [DEFAULT_MIN_PITCH, DEFAULT_MAX_PITCH];
        const newYFit: [number, number] = [
          Math.min(minPitchRange, currentYFit[0]),
          Math.max(maxPitchRange, currentYFit[1])
        ];
        
        // Only update if the range has changed
        if (newYFit[0] !== currentYFit[0] || newYFit[1] !== currentYFit[1]) {
          appLog('[App] Adjusting y-axis range to include user pitch data:', {
            current: currentYFit,
            new: newYFit
          });
          setLoopYFit(newYFit);
        }
      } catch (error) {
        appError('Error extracting pitch:', error);
        setUserPitchData({ times: [], pitches: [] });
      }
    };
    extract();
  }, [audioBlob, pitchDetectionSettings]); // Add pitchDetectionSettings to dependency array

  // Add a helper effect to force redraw of user recording when data changes
  React.useEffect(() => {
    // Only run this for user recordings that have data
    if (isUserRecording && userPitchData.times.length > 0) {
      appLog('[App] User recording data updated, length:', userPitchData.times.length);
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
    appLog('[App] Loading new file via input, setting isLoadingNewFile flag:', isLoadingNewFileRef.current);
    
    // Reset user-set loop region when loading a new file
    userSetLoopRef.current = null;
    appLog('[App] New file loaded, clearing user-set loop region');
    
    const url = URL.createObjectURL(file);
    setNativeMediaUrl(url);
    
    if (file.type.startsWith('audio/')) {
      setNativeMediaType('audio');
      try {
        appLog('[App] Initializing PitchDataManager with audio file:', file.name);
        await pitchManager.current.initialize(file);

        // For long videos, start with empty data
        const initialData = pitchManager.current.isLongVideoFile() ? 
          { times: [], pitches: [] } : 
          pitchManager.current.getPitchDataForTimeRange(0, pitchManager.current.getTotalDuration());

        // Only apply smoothing for short videos
        if (!pitchManager.current.isLongVideoFile()) {
          const smoothingWindowSize = separateSmoothingSettings ? 
            getWindowSizeFromSettings(smoothingStyle, nativeSmoothingLevel) : 
            getWindowSizeFromSettings(smoothingStyle, smoothingLevel);

          const enhancedData = {
            times: initialData.times,
            pitches: smoothPitch(initialData.pitches, smoothingWindowSize)
          };
          appLog('[App] Initial pitch data loaded and smoothed with window size:', smoothingWindowSize);
          setNativePitchData(enhancedData);
        } else {
          setNativePitchData(initialData);
        }
      } catch (error) {
        appError('Error processing audio:', error);
        setNativePitchData({ times: [], pitches: [] });
      }
    } else if (file.type.startsWith('video/')) {
      setNativeMediaType('video');
      try {
        appLog('[App] Initializing PitchDataManager with video file:', file.name);
        await pitchManager.current.initialize(file);

        // For long videos, start with empty data
        const initialData = pitchManager.current.isLongVideoFile() ? 
          { times: [], pitches: [] } : 
          pitchManager.current.getPitchDataForTimeRange(0, pitchManager.current.getTotalDuration());

        // Only apply smoothing for short videos
        if (!pitchManager.current.isLongVideoFile()) {
          const smoothingWindowSize = separateSmoothingSettings ? 
            getWindowSizeFromSettings(smoothingStyle, nativeSmoothingLevel) : 
            getWindowSizeFromSettings(smoothingStyle, smoothingLevel);

          const enhancedData = {
            times: initialData.times,
            pitches: smoothPitch(initialData.pitches, smoothingWindowSize)
          };
          appLog('[App] Initial pitch data loaded and smoothed with window size:', smoothingWindowSize);
          setNativePitchData(enhancedData);
        } else {
          setNativePitchData(initialData);
        }
      } catch (error) {
        appError('Error processing video:', error);
        setNativePitchData({ times: [], pitches: [] });
      }
    } else {
      setNativeMediaType(null);
      setNativePitchData({ times: [], pitches: [] });
    }
    
    // Don't reset the flag here - it will be reset by a useEffect
    appLog('[App] File loading complete, isLoadingNewFile still set:', isLoadingNewFileRef.current);
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
      appLog('[App] Pitch data changed, but not loading a new file. Preserving loop region.', {
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
    
    appLog('[App] Setting loop region for newly loaded file', {
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
      appLog('[App] New file loaded (long), setting loop region to first 10 seconds:', {
        duration,
        loop: userSetLoopRef.current
      });
      
      // Update chart view range if chart is ready
      if (nativeChartInstance) {
        appLog('[App] Long video detected, setting initial view to first 10 seconds:', {
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
      appLog('[App] New file loaded (short), setting loop region to entire duration:', {
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
      appLog('[App] Loop region changed, fitting Y axis:', { 
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
        
        appLog('[App] Loop region overwritten detected, restoring user values:', {
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


  const handleViewChange = useCallback(async (startTime: number, endTime: number, preservedLoopStart?: number, preservedLoopEnd?: number) => {
    // Show loading state while we get the pitch data
    setIsLoadingPitchData(true);
    
    try {
      // Loop region preservation logic
      const userSetLoop = userSetLoopRef.current;
      const hasPreservedValues = preservedLoopStart !== undefined && preservedLoopEnd !== undefined;
      
      const loopRegionToRestore = userSetLoop ? 
        { start: userSetLoop.start, end: userSetLoop.end } : 
        hasPreservedValues ? 
          { start: preservedLoopStart!, end: preservedLoopEnd! } : 
          { start: loopStart, end: loopEnd };
  
      // Loop region preservation for non-new files
      if (!isLoadingNewFileRef.current) {
        const currentLoopStart = loopRegionToRestore.start;
        const currentLoopEnd = loopRegionToRestore.end;
        
        if (Math.abs(loopStart - currentLoopStart) > 0.001 || 
            Math.abs(loopEnd - currentLoopEnd) > 0.001) {
          setLoopStartWithLogging(currentLoopStart);
          setLoopEndWithLogging(currentLoopEnd);
        }
      }
  
      // Get pitch data and update state
      const visibleData = pitchManager.current.getPitchDataForTimeRange(startTime, endTime);
      setNativePitchData(visibleData);
    } finally {
      setIsLoadingPitchData(false);
    }
  }, [loopStart, loopEnd]);

  // Modify onLoopChange to store the user-set values in the ref
  const onLoopChangeHandler = (start: number, end: number) => {
    appLog('[App] Loop region changed by user interaction:', { start, end });
    
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
    
    appLog('[App] Calculated initial pitch range:', {
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
      appLog('[App] Setting initial y-axis range for new file');
      
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
      appLog('[App] Loop region mismatch detected, restoring user-set values:', {
        current: { start: currentLoopStart, end: currentLoopEnd },
        userSet: userSetLoop
      });
      
      // Restore the user-set values
      setLoopStartWithLogging(userSetLoop.start);
      setLoopEndWithLogging(userSetLoop.end);
      
      // Skip further processing since we're just restoring loop regions, not modifying the y-axis
      return;
    }

    appLog('[App] fitYAxisToLoop called but not changing y-axis range, keeping it consistent');
    // We no longer modify the y-axis range in this function
    // The y-axis range is set once when loading a new file and remains constant
  }

  // Update the view change handler
  const onViewChangeHandler = (startTime: number, endTime: number, preservedLoopStart?: number, preservedLoopEnd?: number) => {
    appLog('[App] View change from PitchGraph:', { 
      startTime, 
      endTime, 
      preservedLoopStart, 
      preservedLoopEnd,
      currentLoopStart: loopStart,
      currentLoopEnd: loopEnd,
      userSetLoop: userSetLoopRef.current,
      autoLoopEnabled
    });
    
    // If auto-loop is enabled, set the loop region to match the view
    if (autoLoopEnabled) {
      appLog('[App] Auto-loop enabled, setting loop region to match view:', { start: startTime, end: endTime });
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
            
            appLog('[App] Detected stuck playback:', {
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
              appLog('[App] Manually triggering loop for stuck media');
              media.pause();
              // Use a small timeout to avoid race conditions
              setTimeout(() => {
                if (media) {
                  media.currentTime = loopStart;
                  try {
                    media.play().catch(err => {
                      appLog('[App] Error playing after manual loop:', err);
                    });
                  } catch (e) {
                    appLog('[App] Error during manual loop play:', e);
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
      appLog('[App] Loop trigger detected:', {
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
        
        appLog('[App] Resetting playback to loop start:', loopStart);
        
        // Enhanced robust playback for mobile devices
        const isOnMobile = isMobileDevice();
        appLog('[App] Device type:', isOnMobile ? 'mobile' : 'desktop');
        
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
              appLog('[App] Media canplaythrough event fired, attempting playback');
              media.oncanplaythrough = existingHandler; // Restore original handler
              
              try {
                const playPromise = media.play();
                if (playPromise !== undefined) {
                  playPromise.catch(error => {
                    appLog('[App] Playback error:', error);
                    if (retriesLeft > 0) {
                      appLog(`[App] Retrying playback, ${retriesLeft} attempts left`);
                      setTimeout(() => playWithRetries(retriesLeft - 1), 300);
                    }
                  });
                }
              } catch (e) {
                appLog('[App] Play error:', e);
                if (retriesLeft > 0) {
                  appLog(`[App] Retrying after error, ${retriesLeft} attempts left`);
                  setTimeout(() => playWithRetries(retriesLeft - 1), 300);
                }
              }
            };
            
            // Set a safety timeout in case canplaythrough doesn't fire
            setTimeout(() => {
              if (media.paused && retriesLeft > 0) {
                appLog('[App] canplaythrough timeout, forcing play attempt');
                media.oncanplaythrough = existingHandler; // Restore original handler
                
                try {
                  media.play().catch(error => {
                    appLog('[App] Forced play error:', error);
                    if (retriesLeft > 0) {
                      setTimeout(() => playWithRetries(retriesLeft - 1), 300);
                    }
                  });
                } catch (e) {
                  appLog('[App] Forced play error:', e);
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
                  appLog('[App] Autoplay prevented by browser:', error);
                  // The play request was interrupted by browser policy
                  // Show a play button or notify the user
                });
              }
            } catch (e) {
              appLog('[App] Error during play attempt:', e);
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
      appLog('[App] User is seeking');
      setIsUserSeeking(true);
      
      // Clear any existing timeout
      if (seekingTimeoutRef.current) {
        clearTimeout(seekingTimeoutRef.current);
      }
    };
    
    const onSeeked = () => {
      // Delay resetting the seeking state to prevent immediate loop activation
      seekingTimeoutRef.current = setTimeout(() => {
        appLog('[App] User finished seeking');
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
        appLog('[App] Near end of media, resetting seeking state to restore loop behavior');
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
        appLog('[App] Detected manual timeline seek:', { 
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
      appLog('[App] Media error detected, resetting seeking state:', media.error);
      setIsUserSeeking(false);
      
      // Clear any existing timeout
      if (seekingTimeoutRef.current) {
        clearTimeout(seekingTimeoutRef.current);
      }
    };
    
    // Enhanced ended event listener to handle "stuck at end" issues
    const onEnded = () => {
      appLog('[App] Media playback ended, resetting seeking state and looping');
      setIsUserSeeking(false);
      
      // Clear any existing timeout
      if (seekingTimeoutRef.current) {
        clearTimeout(seekingTimeoutRef.current);
      }
      
      // Explicitly handle looping on ended event
      if (loopEnd > loopStart) {
        setTimeout(() => {
          if (media) {
            appLog('[App] Explicit loop to start after ended event');
            media.currentTime = loopStart;
            
            // Attempt to play with error handling
            try {
              const playPromise = media.play();
              if (playPromise !== undefined) {
                playPromise.catch(error => {
                  appLog('[App] Autoplay prevented by browser after loop:', error);
                });
              }
            } catch (e) {
              appLog('[App] Error during play attempt after loop:', e);
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
    
    appLog('[App] nativePitchData.pitches changed, current loop region:', {
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
      appLog('Chart ref is now set:', nativeChartInstance);
    }
  }, [nativeChartInstance]);

  // Get the active media element (either video or audio)
  const getActiveMediaElement = () => {
    if (nativeMediaType === 'video') return nativeVideoRef.current;
    if (nativeMediaType === 'audio') return nativeAudioRef.current;
    return null;
  };
  
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
        appLog('[App] Setting media duration from multiple sources:', {
          pitchManagerDuration: pitchManager.current.getTotalDuration(),
          mediaDuration: media.duration,
          seekableEnd: media.seekable && media.seekable.length > 0 ? media.seekable.end(media.seekable.length - 1) : 'N/A',
          finalDuration: detectedDuration,
          isFinite: isFinite(detectedDuration)
        });
        
        setNativeMediaDuration(detectedDuration);
        
        // Handle specific behaviors based on duration
        if (detectedDuration <= 30 && isLoadingNewFileRef.current) {
          appLog('[App] Short video detected, updating loop region to match duration:', detectedDuration);
          setLoopStartWithLogging(0);
          setLoopEndWithLogging(detectedDuration);
          
          // Set the user-set loop to this region
          userSetLoopRef.current = { start: 0, end: detectedDuration };
        } else if (detectedDuration > 30 && isLoadingNewFileRef.current) {
          // For long videos, ensure the initial loop is correctly set to the first 10 seconds
          appLog('[App] Long video detected, setting initial loop to first 10 seconds');
          const initialViewDuration = 10;
          setLoopStartWithLogging(0);
          setLoopEndWithLogging(initialViewDuration);
          
          // Set the user-set loop to this region
          userSetLoopRef.current = { start: 0, end: initialViewDuration };
        }
      } else {
        appWarn('[App] Invalid duration detected, sources:', {
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
          appLog('[App] Duration changed significantly:', {
            oldDuration: nativeMediaDuration,
            newDuration: updatedDuration
          });
          setNativeMediaDuration(updatedDuration);
          
          // If this is a duration correction event and we're still loading the file
          if (isLoadingNewFileRef.current) {
            if (updatedDuration <= 30) {
              appLog('[App] Duration updated for short video, correcting loop region:', updatedDuration);
              setLoopStartWithLogging(0);
              setLoopEndWithLogging(updatedDuration);
              
              // Set the user-set loop to this region
              userSetLoopRef.current = { start: 0, end: updatedDuration };
            } else {
              // Long video - keep the default 10-second initial view
              appLog('[App] Duration updated for long video, maintaining initial loop region');
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
    appLog('[App] setLoopStart called with:', { 
      value, 
      previousValue: loopStart,
      stack: new Error().stack?.split('\n').slice(1, 4).join('\n')
    });
    setLoopStart(value);
  };
  
  const setLoopEndWithLogging = (value: number) => {
    appLog('[App] setLoopEnd called with:', { 
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
        appLog('[App] Resetting isLoadingNewFile flag after data loaded, delay complete');
        isLoadingNewFileRef.current = false;
      }, 100); // Give some time for other effects to process
      
      return () => clearTimeout(timerId);
    }
  }, [nativePitchData]);

  // Add a utility function to detect mobile devices
  const isMobileDevice = () => {
    return /Mobi|Android|iPhone|iPad|iPod|Opera Mini|IEMobile|WPDesktop/i.test(navigator.userAgent);
  };

  // Add this function to the component, around line 157 after all the declarations
  const handleInputFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    // Select all text when input is focused
    e.target.select();
  };

  // Add after the Y-axis range state variables around line 250
  // Add smoothing settings state with localStorage persistence
  const [smoothingStyle, setSmoothingStyle] = useState<string>(() => {
    const savedValue = localStorage.getItem('smoothingStyle');
    return savedValue || 'medium'; // 'detailed', 'natural', 'medium', 'simplified'
  });

  const [smoothingLevel, setSmoothingLevel] = useState<number>(() => {
    const savedValue = localStorage.getItem('smoothingLevel');
    return savedValue ? Number(savedValue) : 25; // 0-100 scale
  });

  const [separateSmoothingSettings, setSeparateSmoothingSettings] = useState<boolean>(() => {
    const savedValue = localStorage.getItem('separateSmoothingSettings');
    return savedValue ? savedValue === 'true' : false;
  });

  const [nativeSmoothingLevel, setNativeSmoothingLevel] = useState<number>(() => {
    const savedValue = localStorage.getItem('nativeSmoothingLevel');
    return savedValue ? Number(savedValue) : 25; // 0-100 scale
  });

  const [userSmoothingLevel, setUserSmoothingLevel] = useState<number>(() => {
    const savedValue = localStorage.getItem('userSmoothingLevel');
    return savedValue ? Number(savedValue) : 25; // Changed from 15 to 25 to match current behavior
  });


// Update pitch detection settings
const updatePitchDetectionSettings = useCallback((setting: string, value: number) => {
  setPitchDetectionSettings((prev: { minPitch: number; maxPitch: number; clarityThreshold: number }) => {
    const updated = { ...prev, [setting]: value };
    localStorage.setItem('pitchDetectionSettings', JSON.stringify(updated));
    return updated;
  });
}, []);

// Reset pitch detection settings to defaults
const resetPitchDetectionSettings = useCallback(() => {
  const defaults = {
    minPitch: MIN_PITCH,
    maxPitch: MAX_PITCH,
    clarityThreshold: MIN_CLARITY
  };
  localStorage.setItem('pitchDetectionSettings', JSON.stringify(defaults));
  setPitchDetectionSettings(defaults);
}, []);

  // Add effects to save settings to localStorage when they change
  useEffect(() => {
    localStorage.setItem('smoothingStyle', smoothingStyle);
  }, [smoothingStyle]);

  useEffect(() => {
    localStorage.setItem('smoothingLevel', String(smoothingLevel));
  }, [smoothingLevel]);

  useEffect(() => {
    localStorage.setItem('separateSmoothingSettings', String(separateSmoothingSettings));
  }, [separateSmoothingSettings]);

  useEffect(() => {
    localStorage.setItem('nativeSmoothingLevel', String(nativeSmoothingLevel));
  }, [nativeSmoothingLevel]);

  useEffect(() => {
    localStorage.setItem('userSmoothingLevel', String(userSmoothingLevel));
  }, [userSmoothingLevel]);

  // Add helper function to convert smoothing settings to window size
  // Place this after the smoothing functions around line 140
  // Helper function to convert smoothing settings to window size
  const getWindowSizeFromSettings = (style: string, level: number): number => {
    // Special case to match the original fixed behavior
    if (style === 'medium' && level === 25) {
      return 25; // Ensure we get exactly 25 for the default medium/25 setting
    }
    
    // Map 0-100 level to appropriate window size based on style
    switch (style) {
      case 'detailed':
        // Detailed: smaller window sizes (3-15)
        return Math.round(3 + (level / 100) * 12);
      case 'natural':
        // Natural: medium window sizes (5-25)
        return Math.round(5 + (level / 100) * 20);
      case 'simplified':
        // Simplified: larger window sizes (15-50)
        return Math.round(15 + (level / 100) * 35);
      case 'medium':
      default:
        // Medium: balanced window sizes (10-35)
        return Math.round(10 + (level / 100) * 25);
    }
  };

  // Add after the localStorage saving effects (around line 1927)
  // Add effects to reprocess data when smoothing settings change
  useEffect(() => {
    // Only reprocess if we have data to work with
    if (nativePitchData.times.length > 0 && pitchManager.current) {
      appLog('[App] Smoothing settings changed, reprocessing native pitch data');
      
      try {
        // Get the raw data from the pitch manager
        const timeRange = {
          min: nativeChartInstance?.scales?.x?.min || 0,
          max: nativeChartInstance?.scales?.x?.max || 30
        };
        
        const initialData = pitchManager.current.getPitchDataForTimeRange(timeRange.min, timeRange.max);
        
        // Apply smoothing with the new settings
        const smoothingWindowSize = separateSmoothingSettings ? 
          getWindowSizeFromSettings(smoothingStyle, nativeSmoothingLevel) : 
          getWindowSizeFromSettings(smoothingStyle, smoothingLevel);
        
        const enhancedData = {
          times: initialData.times,
          pitches: smoothPitch(initialData.pitches, smoothingWindowSize)
        };
        
        appLog('[App] Native pitch data reprocessed with window size:', smoothingWindowSize);
        setNativePitchData(enhancedData);
      } catch (error) {
        appError('Error reprocessing native pitch data:', error);
      }
    }
  }, [smoothingStyle, smoothingLevel, separateSmoothingSettings, nativeSmoothingLevel, nativeChartInstance]);

  // Add effect to reprocess user recording data when settings change
  useEffect(() => {
    // Only reprocess if we have user recording data
    if (userPitchData.times.length > 0 && audioBlob) {
      appLog('[App] Settings changed, reprocessing user pitch data');
      
      // We need to re-extract from the audio blob to apply new settings
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
          
          // Use user-defined pitch detection settings
          const { minPitch, maxPitch, clarityThreshold } = pitchDetectionSettings;
          
          for (let i = 0; i + frameSize < channelData.length; i += hopSize) {
            const frame = channelData.slice(i, i + frameSize);
            const [pitch, clarity] = detector.findPitch(frame, sampleRate);
            if (pitch >= minPitch && pitch <= maxPitch && clarity >= clarityThreshold) {
              pitches.push(pitch);
            } else {
              pitches.push(null);
            }
            times.push(i / sampleRate);
          }
          
          // Apply basic median filter
          const basicSmoothed = medianFilter(pitches, MEDIAN_FILTER_SIZE);
          
          // Apply enhanced smoothing with new settings
          const smoothingWindowSize = separateSmoothingSettings ?
            getWindowSizeFromSettings(smoothingStyle, userSmoothingLevel) :
            getWindowSizeFromSettings(smoothingStyle, smoothingLevel);
          
          const enhancedSmooth = smoothPitch(basicSmoothed, smoothingWindowSize);
          
          appLog('[App] User recording reprocessed with settings:', {
            minPitch,
            maxPitch,
            clarityThreshold,
            smoothingWindowSize
          });
          
          setUserPitchData({ times, pitches: enhancedSmooth });
        } catch (error) {
          appError('Error reprocessing user pitch data:', error);
        }
      };
      
      extract();
    }
  }, [
    smoothingStyle, 
    smoothingLevel, 
    separateSmoothingSettings, 
    userSmoothingLevel, 
    audioBlob, 
    pitchDetectionSettings  // Add this to dependency array
  ]);

  // Add a simple keyboard shortcut handler
  useEffect(() => {
    // Only set up keyboard shortcuts on desktop
    if (isMobileDevice()) return;
    
    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip if user is typing in an input field
      if (e.target instanceof HTMLInputElement || 
          e.target instanceof HTMLTextAreaElement || 
          e.target instanceof HTMLSelectElement) {
        return;
      }
      
      // Skip if modifiers are pressed
      if (e.ctrlKey || e.altKey || e.metaKey) {
        return;
      }
      
      // Skip if overlays are open
      if (showGuide || showSettings) {
        return;
      }
      
      appLog('Keyboard shortcut:', e.key);
      
      // Declare variables outside switch to avoid linter errors
      let media, xMin, xMax, nativeMedia, recordButtons, recordButton, stopButton;
      
      // Use the key to determine which action to perform
      const key = e.key.toLowerCase();
      
      // Play/pause native recording
      if (key === keyboardShortcuts.playNative) {
        media = getActiveMediaElement();
        if (media) {
          if (media.paused) {
            media.play().catch(err => appError('Error playing media:', err));
          } else {
            media.pause();
          }
        }
      }
      
      // Set loop to visible region
      else if (key === keyboardShortcuts.loop) {
        if (nativeChartInstance?.scales?.x) {
          xMin = nativeChartInstance.scales.x.min;
          xMax = nativeChartInstance.scales.x.max;
          appLog('Setting loop to visible region:', xMin, xMax);
          userSetLoopRef.current = { start: xMin, end: xMax };
          setLoopStartWithLogging(xMin);
          setLoopEndWithLogging(xMax);
          
          // Optional: Jump to loop start
          nativeMedia = getActiveMediaElement();
          if (nativeMedia) {
            nativeMedia.currentTime = xMin;
          }
        }
      }
      
      // Record/stop
      else if (key === keyboardShortcuts.record) {
        recordButtons = Array.from(document.querySelectorAll('button'));
        
        stopButton = recordButtons.find(btn => 
          btn.textContent?.trim() === 'Stop'
        );
        
        recordButton = recordButtons.find(btn => 
          btn.textContent?.trim() === 'Record'
        );
        
        if (stopButton && !stopButton.disabled) {
          appLog('Clicking Stop button');
          stopButton.click();
        } else {
          if (recordButton) {
            appLog('Clicking Record button');
            recordButton.click();
          }
        }
      }
      
      // Play/pause user recording
      else if (key === keyboardShortcuts.playUser) {
        if (userAudioRef.current) {
          if (userAudioRef.current.paused) {
            userAudioRef.current.play().catch(err => appError('Error playing user audio:', err));
          } else {
            userAudioRef.current.pause();
          }
        }
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    appLog('Keyboard shortcuts enabled');
    
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [nativeChartInstance, showGuide, showSettings, nativeMediaDuration]);

  // Add state for customizable keyboard shortcuts
  const [keyboardShortcuts, setKeyboardShortcuts] = useState<Record<string, string>>(() => {
    const savedShortcuts = localStorage.getItem('keyboardShortcuts');
    if (savedShortcuts) {
      try {
        return JSON.parse(savedShortcuts);
      } catch (e) {
        appError('Error parsing saved shortcuts:', e);
      }
    }
    // Default shortcuts
    return {
      playNative: 'n',
      loop: 'l',
      record: 'r',
      playUser: 'e'
    };
  });

  // Add function to save shortcuts
  const saveKeyboardShortcut = useCallback((action: string, key: string) => {
    setKeyboardShortcuts(prev => {
      const updated = { ...prev, [action]: key };
      localStorage.setItem('keyboardShortcuts', JSON.stringify(updated));
      return updated;
    });
  }, []);

  // Add function to reset shortcuts to defaults
  const resetKeyboardShortcuts = useCallback(() => {
    const defaults = {
      playNative: 'n',
      loop: 'l',
      record: 'r',
      playUser: 'e'
    };
    localStorage.setItem('keyboardShortcuts', JSON.stringify(defaults));
    setKeyboardShortcuts(defaults);
  }, []);

  

  // Add loading state for pitch extraction
  const [isExtractingPitch, setIsExtractingPitch] = useState(false);

  // Add state for current segment boundaries
  const [currentSegment, setCurrentSegment] = useState<{ startTime: number; endTime: number } | null>(null);

  // Modify handleExtractPitch to update segment boundaries
  const handleExtractPitch = async () => {
    const media = getActiveMediaElement() as HTMLVideoElement | null;
    if (!media) return;

    setIsExtractingPitch(true);
    try {
      await pitchManager.current.extractSegment(media.currentTime);
      const extractedData = pitchManager.current.getPitchDataForTimeRange(0, pitchManager.current.getTotalDuration());
      
      // Get current segment boundaries
      const segment = pitchManager.current.getCurrentSegment();
      setCurrentSegment(segment);
      
      // Apply smoothing to the extracted segment
      const smoothingWindowSize = separateSmoothingSettings ? 
        getWindowSizeFromSettings(smoothingStyle, nativeSmoothingLevel) : 
        getWindowSizeFromSettings(smoothingStyle, smoothingLevel);

      const enhancedData = {
        times: extractedData.times,
        pitches: smoothPitch(extractedData.pitches, smoothingWindowSize)
      };
      
      setNativePitchData(enhancedData);
    } catch (error) {
      appError('Error extracting pitch data:', error);
    } finally {
      setIsExtractingPitch(false);
    }
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
              <div style={{ position: 'relative' }}>
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
                {/* Add Extract Pitch Curve button for long videos */}
                {pitchManager.current.isLongVideoFile() && (
                  <button
                    onClick={handleExtractPitch}
                    disabled={isExtractingPitch}
                    style={{
                      position: 'absolute',
                      bottom: '1rem',
                      right: '1rem',
                      padding: '0.5rem 1rem',
                      backgroundColor: '#1976d2',
                      color: 'white',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: isExtractingPitch ? 'wait' : 'pointer',
                      opacity: isExtractingPitch ? 0.7 : 1
                    }}
                  >
                    {isExtractingPitch ? 'Extracting...' : 'Extract Pitch Curve'}
                  </button>
                )}
              </div>
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
                      appLog('[App] Clearing user-set loop region');
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
                      appLog('Loop visible button clicked. Chart ref:', chart);
                      if (chart && chart.scales && chart.scales.x) {
                        const xMin = chart.scales.x.min;
                        const xMax = chart.scales.x.max;
                        appLog('Setting loop to visible region:', xMin, xMax);
                        
                        // Update userSetLoopRef since this is a user action
                        userSetLoopRef.current = { start: xMin, end: xMax };
                        
                        setLoopStartWithLogging(xMin);
                        setLoopEndWithLogging(xMax);
                        const media = getActiveMediaElement();
                        if (media) {
                          media.currentTime = xMin;
                        }
                      } else {
                        appLog('Chart or x scale not available');
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
                yFit={getNativeYAxisRange()}
                playbackTime={nativePlaybackTime}
                onLoopChange={onLoopChangeHandler}
                onViewChange={onViewChangeHandler}
                totalDuration={pitchManager.current.isLongVideoFile() ? 
                  (currentSegment?.endTime || 0) - (currentSegment?.startTime || 0) : 
                  pitchManager.current.getTotalDuration()}
                initialViewDuration={pitchManager.current.isLongVideoFile() ? 
                  (currentSegment?.endTime || 0) - (currentSegment?.startTime || 0) : 
                  undefined}
                yAxisConfig={{
                  beginAtZero: false,
                  suggestedMin: loopYFit?.[0],
                  suggestedMax: loopYFit?.[1],
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
              yFit={getUserYAxisRange()}
              isUserRecording={isUserRecording}
              onChartReady={setUserChartInstance}
              yAxisConfig={{
                beginAtZero: false,
                suggestedMin: getUserYAxisRange()[0],
                suggestedMax: getUserYAxisRange()[1],
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
                    <span>Native Recording Y-Axis Range (Hz)</span>
                    <div className="setting-description">
                      Adjust the minimum and maximum pitch values for the native recording display
                    </div>
                  </label>
                  <div className="setting-controls y-axis-range-controls">
                    <div className="range-input-group">
                      <label>Min: 
                        <input 
                          type="number" 
                          value={nativeMinPitch}
                          onChange={(e) => {
                            const newValue = Number(e.target.value);
                            if (!isNaN(newValue) && newValue >= 0 && newValue < nativeMaxPitch - 50) {
                              setNativeMinPitch(newValue);
                            }
                          }}
                          min={0}
                          max={nativeMaxPitch - 50}
                          step={10}
                        />
                      </label>
                      <label>Max: 
                        <input 
                          type="number" 
                          value={nativeMaxPitch}
                          onChange={(e) => {
                            // Allow any value during editing
                            const newValue = Number(e.target.value);
                            if (!isNaN(newValue)) {
                              setNativeMaxPitch(newValue);
                            }
                          }}
                          onBlur={(e) => {
                            // Apply validation constraints only when the field loses focus
                            const newValue = Number(e.target.value);
                            if (isNaN(newValue) || newValue <= nativeMinPitch + 20 || newValue > 1000) {
                              // If invalid, reset to previous valid value or default
                              setNativeMaxPitch(Math.max(nativeMinPitch + 50, DEFAULT_MAX_PITCH));
                            }
                          }}
                          onFocus={handleInputFocus}
                          onTouchStart={(e) => {
                            e.currentTarget.focus();
                          }}
                          min={0}
                          max={1000}
                          step={10}
                          inputMode="numeric"
                        />
                      </label>
                      <button 
                        className="reset-button"
                        onClick={resetNativeYAxisRange}
                        title="Reset to defaults"
                      >
                        ↺
                      </button>
                    </div>
                  </div>
                </div>
                
                <div className="setting-group">
                  <label className="setting-label">
                    <span>Your Recording Y-Axis Range (Hz)</span>
                    <div className="setting-description">
                      Adjust the minimum and maximum pitch values for your recording display
                    </div>
                  </label>
                  <div className="setting-controls y-axis-range-controls">
                    <div className="range-input-group">
                      <label>Min: 
                        <input 
                          type="number" 
                          value={userMinPitch}
                          onChange={(e) => {
                            const newValue = Number(e.target.value);
                            if (!isNaN(newValue) && newValue >= 0 && newValue < userMaxPitch - 50) {
                              setUserMinPitch(newValue);
                            }
                          }}
                          min={0}
                          max={userMaxPitch - 50}
                          step={10}
                        />
                      </label>
                      <label>Max: 
                        <input 
                          type="number" 
                          value={userMaxPitch}
                          onChange={(e) => {
                            // Allow any value during editing
                            const newValue = Number(e.target.value);
                            if (!isNaN(newValue)) {
                              setUserMaxPitch(newValue);
                            }
                          }}
                          onBlur={(e) => {
                            // Apply validation constraints only when the field loses focus
                            const newValue = Number(e.target.value);
                            if (isNaN(newValue) || newValue <= userMinPitch + 20 || newValue > 1000) {
                              // If invalid, reset to previous valid value or default
                              setUserMaxPitch(Math.max(userMinPitch + 50, DEFAULT_MAX_PITCH));
                            }
                          }}
                          onFocus={handleInputFocus}
                          onTouchStart={(e) => {
                            e.currentTarget.focus();
                          }}
                          min={0}
                          max={1000}
                          step={10}
                          inputMode="numeric"
                        />
                      </label>
                      <button 
                        className="reset-button"
                        onClick={resetUserYAxisRange}
                        title="Reset to defaults"
                      >
                        ↺
                      </button>
                    </div>
                  </div>
                </div>
                
                <div className="setting-group">
                  <label className="setting-label">
                    <span>Pitch Curve Smoothing</span>
                    <div className="setting-description">
                      Choose the amount of smoothing applied to pitch curves
                    </div>
                  </label>
                  <div className="setting-controls">
                    {/* Visualization Style */}
                    <div className="setting-control-row">
                      <label>Visualization Style:</label>
                      <select 
                        value={smoothingStyle} 
                        onChange={(e) => setSmoothingStyle(e.target.value)}
                        className="settings-select"
                      >
                        <option value="detailed">Detailed</option>
                        <option value="natural">Natural</option>
                        <option value="medium">Medium</option>
                        <option value="simplified">Simplified</option>
                      </select>
                    </div>
                    
                    <div className="setting-help">
                      <ul className="settings-help-text">
                        <li><strong>Detailed:</strong> Shows nuanced pitch changes</li>
                        <li><strong>Natural:</strong> Balanced smoothing</li>
                        <li><strong>Medium:</strong> Standard smoothing</li>
                        <li><strong>Simplified:</strong> Shows major contour only</li>
                      </ul>
                    </div>
                    
                    {/* Separate settings toggle */}
                    <div className="setting-control-row">
                      <label className="checkbox-label">
                        <input 
                          type="checkbox" 
                          checked={separateSmoothingSettings} 
                          onChange={(e) => setSeparateSmoothingSettings(e.target.checked)} 
                        />
                        <span>Use separate smoothing for native and user recordings</span>
                      </label>
                    </div>
                    
                    {!separateSmoothingSettings ? (
                      /* Global Smoothing Level */
                      <div className="setting-control-slider">
                        <label>Smoothing Intensity:</label>
                        <div className="slider-with-value">
                          <input 
                            type="range" 
                            min="0" 
                            max="100" 
                            value={smoothingLevel} 
                            onChange={(e) => setSmoothingLevel(Number(e.target.value))} 
                            className="settings-slider" 
                          />
                          <div className="slider-value">{smoothingLevel}%</div>
                        </div>
                        <div className="preset-buttons">
                          <button 
                            className={smoothingLevel === 5 ? 'active' : ''} 
                            onClick={() => setSmoothingLevel(5)}
                          >
                            None
                          </button>
                          <button 
                            className={smoothingLevel === 15 ? 'active' : ''} 
                            onClick={() => setSmoothingLevel(15)}
                          >
                            Light
                          </button>
                          <button 
                            className={smoothingLevel === 25 ? 'active' : ''} 
                            onClick={() => setSmoothingLevel(25)}
                          >
                            Medium
                          </button>
                          <button 
                            className={smoothingLevel === 40 ? 'active' : ''} 
                            onClick={() => setSmoothingLevel(40)}
                          >
                            Heavy
                          </button>
                        </div>
                        <div className="setting-tech-info">
                          Window size: {getWindowSizeFromSettings(smoothingStyle, smoothingLevel)}
                        </div>
                      </div>
                    ) : (
                      /* Separate Native and User Smoothing Controls */
                      <>
                        <div className="setting-control-slider">
                          <label>Native Recording Smoothing:</label>
                          <div className="slider-with-value">
                            <input 
                              type="range" 
                              min="0" 
                              max="100" 
                              value={nativeSmoothingLevel} 
                              onChange={(e) => setNativeSmoothingLevel(Number(e.target.value))} 
                              className="settings-slider" 
                            />
                            <div className="slider-value">{nativeSmoothingLevel}%</div>
                          </div>
                          <div className="preset-buttons">
                            <button
                              className={nativeSmoothingLevel === 5 ? 'active' : ''}
                              onClick={() => setNativeSmoothingLevel(5)}
                            >
                              None
                            </button>
                            <button
                              className={nativeSmoothingLevel === 15 ? 'active' : ''}
                              onClick={() => setNativeSmoothingLevel(15)}
                            >
                              Light
                            </button>
                            <button
                              className={nativeSmoothingLevel === 25 ? 'active' : ''}
                              onClick={() => setNativeSmoothingLevel(25)}
                            >
                              Medium
                            </button>
                            <button
                              className={nativeSmoothingLevel === 40 ? 'active' : ''}
                              onClick={() => setNativeSmoothingLevel(40)}
                            >
                              Heavy
                            </button>
                          </div>
                          <div className="setting-tech-info">
                            Window size: {getWindowSizeFromSettings(smoothingStyle, nativeSmoothingLevel)}
                          </div>
                        </div>
                        
                        <div className="setting-control-slider">
                          <label>User Recording Smoothing:</label>
                          <div className="slider-with-value">
                            <input 
                              type="range" 
                              min="0" 
                              max="100" 
                              value={userSmoothingLevel} 
                              onChange={(e) => setUserSmoothingLevel(Number(e.target.value))} 
                              className="settings-slider" 
                            />
                            <div className="slider-value">{userSmoothingLevel}%</div>
                          </div>
                          <div className="preset-buttons">
                            <button
                              className={userSmoothingLevel === 5 ? 'active' : ''}
                              onClick={() => setUserSmoothingLevel(5)}
                            >
                              None
                            </button>
                            <button
                              className={userSmoothingLevel === 15 ? 'active' : ''}
                              onClick={() => setUserSmoothingLevel(15)}
                            >
                              Light
                            </button>
                            <button
                              className={userSmoothingLevel === 25 ? 'active' : ''}
                              onClick={() => setUserSmoothingLevel(25)}
                            >
                              Medium
                            </button>
                            <button
                              className={userSmoothingLevel === 40 ? 'active' : ''}
                              onClick={() => setUserSmoothingLevel(40)}
                            >
                              Heavy
                            </button>
                          </div>
                          <div className="setting-tech-info">
                            Window size: {getWindowSizeFromSettings(smoothingStyle, userSmoothingLevel)}
                          </div>
                        </div>
                      </>
                    )}
                    
                    {/* Reset button */}
                    <div className="setting-control-row">
                      <button 
                        className="settings-reset-button" 
                        onClick={() => {
                          // Reset to original fixed window size of 25 (how curves look now)
                          setSmoothingStyle('medium');
                          setSmoothingLevel(25);
                          setNativeSmoothingLevel(25);
                          setUserSmoothingLevel(25); // Also set user level to 25 to match current behavior
                          setSeparateSmoothingSettings(false);
                        }}
                      >
                        Reset to Defaults
                      </button>
                    </div>
                  </div>
                </div>
              </div>
              
              {/* Keyboard Shortcuts - only shown on desktop */}
              {!isMobileDevice() && (
                <div className="settings-section">
                  <h3>Keyboard Shortcuts</h3>
                  <div className="setting-group">
                    <div className="keyboard-shortcut-list">
                      <div className="shortcut-item">
                        <span>Play/pause native recording:</span>
                        <div className="shortcut-input-container">
                          <input 
                            type="text" 
                            value={keyboardShortcuts.playNative}
                            onChange={(e) => saveKeyboardShortcut('playNative', e.target.value.length ? e.target.value[0].toLowerCase() : '')}
                            maxLength={1}
                            className="shortcut-input"
                          />
                          <button 
                            onClick={() => saveKeyboardShortcut('playNative', 'n')} 
                            title="Reset to default"
                            className="reset-button"
                          >
                            ↺
                          </button>
                        </div>
                      </div>
                      
                      <div className="shortcut-item">
                        <span>Set loop to visible area:</span>
                        <div className="shortcut-input-container">
                          <input 
                            type="text" 
                            value={keyboardShortcuts.loop}
                            onChange={(e) => saveKeyboardShortcut('loop', e.target.value.length ? e.target.value[0].toLowerCase() : '')}
                            maxLength={1}
                            className="shortcut-input"
                          />
                          <button 
                            onClick={() => saveKeyboardShortcut('loop', 'l')} 
                            title="Reset to default"
                            className="reset-button"
                          >
                            ↺
                          </button>
                        </div>
                      </div>
                      
                      <div className="shortcut-item">
                        <span>Record/stop recording:</span>
                        <div className="shortcut-input-container">
                          <input 
                            type="text" 
                            value={keyboardShortcuts.record}
                            onChange={(e) => saveKeyboardShortcut('record', e.target.value.length ? e.target.value[0].toLowerCase() : '')}
                            maxLength={1}
                            className="shortcut-input"
                          />
                          <button 
                            onClick={() => saveKeyboardShortcut('record', 'r')} 
                            title="Reset to default"
                            className="reset-button"
                          >
                            ↺
                          </button>
                        </div>
                      </div>
                      
                      <div className="shortcut-item">
                        <span>Play/pause your recording:</span>
                        <div className="shortcut-input-container">
                          <input 
                            type="text" 
                            value={keyboardShortcuts.playUser}
                            onChange={(e) => saveKeyboardShortcut('playUser', e.target.value.length ? e.target.value[0].toLowerCase() : '')}
                            maxLength={1}
                            className="shortcut-input"
                          />
                          <button 
                            onClick={() => saveKeyboardShortcut('playUser', 'e')} 
                            title="Reset to default"
                            className="reset-button"
                          >
                            ↺
                          </button>
                        </div>
                      </div>
                      
                    </div>
                    
                    <button 
                      className="settings-reset-button" 
                      onClick={resetKeyboardShortcuts}
                    >
                      Reset All Shortcuts
                    </button>
                  </div>
                </div>
              )}
            
                <div className="settings-section">                  
                  <h3>Advanced Settings</h3>                  
                  
                    <div className="setting-group">
                      <label className="setting-label">
                        <span>Pitch Detection Range</span>
                        <div className="setting-description">Configure the minimum and maximum pitch detection thresholds</div>
                      </label>
                    <div className="setting-controls">
                    <div className="setting-control-row">
                      <label>Minimum Pitch (Hz):</label>
                      <input 
                        type="number" 
                        min="20" 
                        max="300" 
                        step="5" 
                        value={pitchDetectionSettings.minPitch} 
                        onChange={(e) => updatePitchDetectionSettings('minPitch', Number(e.target.value))}
                        className="settings-number-input"
                      />
                    </div>
                    
                    <div className="setting-control-row">
                      <label>Maximum Pitch (Hz):</label>
                      <input 
                        type="number" 
                        min="200" 
                        max="1000" 
                        step="10" 
                        value={pitchDetectionSettings.maxPitch} 
                        onChange={(e) => updatePitchDetectionSettings('maxPitch', Number(e.target.value))}
                        className="settings-number-input"
                      />
                    </div>
                    
                    <div className="setting-control-row">
                      <label>Clarity Threshold:</label>
                      <div className="slider-with-value">
                        <input 
                          type="range" 
                          min="0" 
                          max="1" 
                          step="0.05" 
                          value={pitchDetectionSettings.clarityThreshold} 
                          onChange={(e) => updatePitchDetectionSettings('clarityThreshold', Number(e.target.value))} 
                          className="settings-slider" 
                        />
                        <div className="slider-value">{pitchDetectionSettings.clarityThreshold.toFixed(2)}</div>
                      </div>
                    </div>
                    
                    <div className="setting-description pitch-description">
                      <p><strong>Recommended settings:</strong></p>
                      <ul>
                        <li>For male voices: Min 60-80 Hz, Max 400-500 Hz</li>
                        <li>For female voices: Min 120-150 Hz, Max 500-700 Hz</li>
                        <li>Higher clarity threshold = more reliable pitches but more gaps</li>
                      </ul>
                    </div>
                    
                    <div className="setting-control-row">
                      <button 
                        className="settings-reset-button" 
                        onClick={resetPitchDetectionSettings}
                      >
                        Reset to Defaults
                      </button>
                    </div>
                    <div className="setting-group">                    
                    <label className="setting-label">                      
                      <span>Subtitle Upload</span>                      
                      <div className="setting-description">Upload a subtitle file for the native recording (*.vtt, *.srt, or *.ass formats supported - non-VTT files will be automatically converted)</div>
                    </label>
                    <div className="setting-controls">
                      <input type="file" accept=".vtt,.srt,.ass" style={{ display: 'none' }} ref={subtitleInputRef} onChange={handleSubtitleChange}/>
                      <div className="setting-control-row subtitle-controls">
                        <button className="settings-button" onClick={() => subtitleInputRef.current?.click()} disabled={!nativeMediaUrl}>Load Subtitle</button>                       
                        <button  className="settings-button" onClick={() => {
                          // Clean up old URL if it exists
                          if (subtitleUrl) {
                            URL.revokeObjectURL(subtitleUrl);
                          }
                          setSubtitleUrl(undefined);
                          setCurrentSubtitle({ file: undefined, fileName: undefined });
                          
                          // Force video reload to clear the track
                          const video = nativeVideoRef.current;
                          if (video) {
                            const currentTime = video.currentTime;
                            video.load();
                            video.currentTime = currentTime;
                          }
                        }} 
                        disabled={!currentSubtitle.file}>Clear Subtitle</button>                      
                      </div>
                      {currentSubtitle.fileName && (<div className="subtitle-info"> Current subtitle: {currentSubtitle.fileName}</div>)}
                    </div>
                  </div>
                  <div className="setting-group">
                    <label className="setting-label">
                      <span>Subtitle Font Size</span>
                      <div className="setting-description">Adjust the size of the subtitles (1 = normal size)</div>
                      </label>
                      <div className="setting-controls">
                        <div className="setting-control-row">
                          <input type="range" min="0.5" max="4" step="0.1" value={subtitleFontSize} onChange={(e) => setSubtitleFontSize(Number(e.target.value))} className="settings-slider"/>
                          <span className="slider-value">{subtitleFontSize}x</span>
                        </div>
                      </div>
                    </div>
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

        /* Subtitle styling */
        video::cue {
          font-size: ${subtitleFontSize}em;
          background-color: rgba(0, 0, 0, 0.8);
          color: white;
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

        .settings-number-input {
          width: 80px;
          height: 32px;
          text-align: center;
          font-size: 16px;
          border: 1px solid #ccc;
          border-radius: 4px;
        }

        .pitch-description p {
          margin-top: 15px;
          margin-bottom: 8px;
        }

        .pitch-description ul {
          margin-top: 0;
          padding-left: 20px;
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

          .settings-number-input {
            background-color: #333;
            color: #fff;
            border-color: #555;
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
        
        /* Y-Axis Range Controls */
        .y-axis-range-controls {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        
        .range-input-group {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        
        .range-input-group label {
          display: flex;
          align-items: center;
          gap: 4px;
          font-size: 0.9rem;
        }
        
        .range-input-group input {
          width: 70px;
          padding: 4px 6px;
          border: 1px solid #ccc;
          border-radius: 4px;
          font-size: 0.9rem;
        }
        
        .reset-button {
          background: none;
          border: none;
          color: #1976d2;
          font-size: 1.1rem;
          cursor: pointer;
          width: 24px;
          height: 24px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 0;
        }
        
        .reset-button:hover {
          background-color: rgba(25, 118, 210, 0.1);
        }
        
        .range-preview {
          display: flex;
          align-items: stretch;
          gap: 12px;
        }
        
        .range-preview-label {
          font-size: 0.9rem;
          flex-shrink: 0;
          padding-top: 8px;
        }
        
        .range-preview-box {
          flex-grow: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          position: relative;
        }
        
        .range-preview-scale {
          width: 20px;
          height: 100px;
          background: linear-gradient(to bottom, #6bb5ff, #1976d2);
          border-radius: 10px;
          margin: 4px 0;
        }
        
        .range-preview-max, .range-preview-min {
          font-size: 0.8rem;
          color: #666;
        }
        
        /* Mobile styles for range controls */
        @media (max-width: 768px) {
          .range-input-group {
            flex-wrap: wrap;
            justify-content: center;
            gap: 16px;
          }
          
          .range-preview {
            flex-direction: column;
            align-items: center;
          }
          
          .range-preview-label {
            padding-top: 0;
            margin-bottom: 4px;
          }
          
          .range-preview-box {
            width: 100%;
          }
          
          .range-preview-scale {
            height: 60px;
          }
          
          .range-input-group input {
            background-color: #333;
            color: #fff;
            border-color: #555;
            width: 85px; /* Increased from 70px for better touch targets */
            height: 40px; /* Taller for easier touch */
            font-size: 16px !important; /* Larger font for mobile */
            -webkit-appearance: none; /* Fix for iOS input styling */
            appearance: none;
            padding: 8px !important; /* More padding for better touch targets */
          }
          
          .range-input-group label {
            flex-direction: column;
            align-items: flex-start;
            gap: 8px;
            font-size: 1rem !important;
          }
          
          .range-preview-max, .range-preview-min {
            color: #ccc;
          }
          
          .reset-button {
            color: #6bb5ff;
            width: 32px; /* Larger touch target */
            height: 32px; /* Larger touch target */
            font-size: 1.3rem;
          }
        }
              `}</style>        {/* Add styles for the smoothing controls before the last style closing tag */}        <style>{`        /* Subtitle Controls Styles */        .subtitle-controls {          display: flex;          gap: 12px;        }        .subtitle-controls button {          flex: 1;          min-width: 120px;        }        .subtitle-info {          margin-top: 8px;          font-size: 0.9rem;          color: #666;          font-style: italic;        }        @media (max-width: 768px) {          .subtitle-controls {            flex-direction: column;            width: 100%;          }          .subtitle-controls button {            width: 100%;            background-color: #444;            color: #fff;            border-color: #555;            padding: 10px !important;          }          .subtitle-info {            color: #bbb;          }        }        /* Smoothing Controls Styles */
        .setting-control-row {
          margin-bottom: 12px;
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .setting-control-slider {
          margin-bottom: 20px;
        }

        .settings-select {
          padding: 6px 8px;
          border-radius: 4px;
          border: 1px solid #ccc;
          min-width: 120px;
          background-color: white;
        }

        .settings-help-text {
          font-size: 0.85rem;
          color: #666;
          padding-left: 1.5rem;
          margin: 8px 0 16px;
        }

        .slider-with-value {
          display: flex;
          align-items: center;
          gap: 8px;
          margin: 8px 0;
        }

        .settings-slider {
          flex-grow: 1;
          -webkit-appearance: none;
          appearance: none;
          height: 6px;
          background: #e0e0e0;
          border-radius: 3px;
          outline: none;
        }

        .settings-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 18px;
          height: 18px;
          border-radius: 50%;
          background: #1976d2;
          cursor: pointer;
        }

        .settings-slider::-moz-range-thumb {
          width: 18px;
          height: 18px;
          border-radius: 50%;
          background: #1976d2;
          cursor: pointer;
        }

        .slider-value {
          min-width: 45px;
          font-weight: 500;
          color: #333;
        }

        .preset-buttons {
          display: flex;
          gap: 8px;
          margin: 8px 0;
        }

        .preset-buttons button {
          padding: 4px 8px;
          background: #f2f2f2;
          border: 1px solid #ccc;
          border-radius: 4px;
          cursor: pointer;
          font-size: 0.85rem;
        }

        .preset-buttons button:hover {
          background: #e8e8e8;
        }

        .preset-buttons button.active {
          background: #1976d2;
          color: white;
          border-color: #1976d2;
        }

        .setting-tech-info {
          font-size: 0.8rem;
          color: #666;
          margin-top: 4px;
        }

        .checkbox-label {
          display: flex;
          align-items: center;
          gap: 8px;
          cursor: pointer;
        }

        .settings-reset-button {
          padding: 6px 12px;
          background: #f5f5f5;
          border: 1px solid #ccc;
          border-radius: 4px;
          cursor: pointer;
          font-size: 0.9rem;
          margin-top: 8px;
        }

        .settings-reset-button:hover {
          background: #e8e8e8;
        }

        /* Mobile styling for the smoothing controls */
        @media (max-width: 768px) {
          .setting-control-row {
            flex-direction: column;
            align-items: flex-start;
            gap: 8px;
          }
          
          .settings-select {
            width: 100%;
            background-color: #333;
            color: #fff;
            border-color: #555;
            font-size: 16px !important;
          }
          
          .settings-slider {
            background: #555;
            height: 10px;
          }
          
          .settings-slider::-webkit-slider-thumb {
            width: 24px;
            height: 24px;
            background: #6bb5ff;
          }
          
          .settings-slider::-moz-range-thumb {
            width: 24px;
            height: 24px;
            background: #6bb5ff;
          }
          
          .slider-value {
            color: #fff;
            min-width: 55px;
            font-size: 16px !important;
          }
          
          .preset-buttons {
            flex-wrap: wrap;
            justify-content: center;
            width: 100%;
          }
          
          .preset-buttons button {
            flex: 1;
            min-width: 70px;
            background-color: #444;
            color: #fff;
            border-color: #555;
            font-size: 14px !important;
            padding: 8px !important;
          }
          
          .preset-buttons button.active {
            background: #1976d2;
            color: white;
            border-color: #1976d2;
          }
          
          .setting-tech-info {
            color: #bbb;
          }
          
          .checkbox-label span {
            color: #fff;
          }
          
          .settings-reset-button {
            width: 100%;
            background-color: #444;
            color: #fff;
            border-color: #555;
            padding: 10px !important;
          }
          
          .settings-help-text {
            color: #ccc;
          }
        }
      `}</style>
      <style>{`
        .keyboard-shortcut-list {
          display: flex;
          flex-direction: column;
          gap: 12px;
          margin-bottom: 16px;
        }

        .shortcut-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 16px;
        }

        .shortcut-input-container {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .shortcut-input {
          width: 40px;
          height: 32px;
          text-align: center;
          font-size: 16px;
          border: 1px solid #ccc;
          border-radius: 4px;
        }

        /* Mobile styling */
        @media (max-width: 768px) {
          .shortcut-item {
            flex-direction: column;
            align-items: flex-start;
            gap: 8px;
          }
          
          .shortcut-input {
            background-color: #333;
            color: #fff;
            border-color: #555;
          }
        }
      `}</style>
    </div>
  )
}

export default App