import React, { useRef, useState, useEffect } from 'react';
import Button from '@mui/material/Button';

interface RecorderProps {
  onRecordingComplete?: (audioUrl: string, audioBlob: Blob) => void;
  audioUrl?: string | null;
  audioRef?: React.RefObject<HTMLAudioElement | null>;
  showPlayer?: boolean;
}

function isMobile() {
  return /Mobi|Android|iPhone|iPad|iPod|Opera Mini|IEMobile|WPDesktop/i.test(navigator.userAgent);
}

const getSupportedMimeType = () => {
  const mimeTypes = [
    'audio/mp4', // AAC (iOS Safari)
    'audio/mpeg', // MP3
    'audio/webm', // Opus (Chrome, Firefox)
    'audio/ogg', // Ogg Vorbis
    'audio/wav', // WAV (not always supported for MediaRecorder)
  ];
  for (const type of mimeTypes) {
    if (MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }
  return '';
};

const Recorder: React.FC<RecorderProps> = ({ onRecordingComplete, audioUrl, audioRef, showPlayer = true }) => {
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const [status, setStatus] = useState<'idle' | 'recording' | 'stopped'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | undefined>(undefined);

  // Enumerate audio input devices on mount (desktop only)
  useEffect(() => {
    if (isMobile()) return;
    navigator.mediaDevices.getUserMedia({ audio: true }).then(() => {
      navigator.mediaDevices.enumerateDevices().then(devices => {
        const mics = devices.filter(d => d.kind === 'audioinput');
        setDevices(mics);
        if (mics.length > 0) setSelectedDeviceId(mics[0].deviceId);
      });
    });
  }, []);

  const startRecording = async () => {
    setError(null);
    if (audioRef && audioRef.current) {
      audioRef.current.src = '';
    }
    try {
      const constraints: MediaStreamConstraints = {
        audio: selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : true
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      const mimeType = getSupportedMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = recorder;
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunks.push(e.data);
        }
      };
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: mimeType || 'audio/webm' });
        const url = URL.createObjectURL(blob);
        if (onRecordingComplete) {
          onRecordingComplete(url, blob);
        }
      };
      recorder.start();
      setStatus('recording');
    } catch (err: any) {
      setError('Could not start recording: ' + (err.message || err));
      setStatus('idle');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && status === 'recording') {
      mediaRecorderRef.current.stop();
      setStatus('stopped');
    }
  };

  const clearRecording = () => {
    if (audioRef && audioRef.current) {
      audioRef.current.src = '';
    }
    setStatus('idle');
    setError(null);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
      <div>Status: <b>{status}</b></div>
      {error && <div style={{ color: 'red', fontSize: 12 }}>{error}</div>}
      {!isMobile() && devices.length > 0 && (
        <div style={{ margin: '8px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
          <label htmlFor="mic-select" style={{ fontSize: 13 }}>Microphone:</label>
          <select
            id="mic-select"
            value={selectedDeviceId}
            onChange={e => setSelectedDeviceId(e.target.value)}
            style={{ fontSize: 13 }}
          >
            {devices.map(d => (
              <option key={d.deviceId} value={d.deviceId}>{d.label || `Microphone ${d.deviceId}`}</option>
            ))}
          </select>
        </div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant="contained" color="primary" onClick={startRecording} disabled={status === 'recording'}>
          Record
        </Button>
        <Button variant="contained" color="secondary" onClick={stopRecording} disabled={status !== 'recording'}>
          Stop
        </Button>
        <Button variant="outlined" onClick={clearRecording} disabled={!audioUrl}>
          Clear
        </Button>
      </div>
      {audioUrl && showPlayer && (
        <audio ref={audioRef} src={audioUrl} controls style={{ marginTop: 16 }} />
      )}
    </div>
  );
};

export default Recorder; 