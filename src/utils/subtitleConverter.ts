interface SubtitleCue {
  startTime: string;
  endTime: string;
  text: string;
}

// Convert SRT timestamp (00:00:00,000) to WebVTT timestamp (00:00:00.000)
const convertSrtTimestamp = (timestamp: string): string => {
  return timestamp.replace(',', '.');
};

// Convert ASS timestamp (0:00:00.00) to WebVTT timestamp (00:00:00.000)
const convertAssTimestamp = (timestamp: string): string => {
  const [hours, minutes, seconds] = timestamp.split(':');
  return `${hours.padStart(2, '0')}:${minutes}:${seconds.padEnd(6, '0')}`;
};

// Parse SRT format
const parseSrt = async (content: string): Promise<string> => {
  const cues: SubtitleCue[] = [];
  const blocks = content.trim().split(/\n\s*\n/);

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 3) continue;

    // Skip the subtitle number
    const timeLine = lines[1];
    const textLines = lines.slice(2);

    const [startTime, endTime] = timeLine.split(' --> ').map(convertSrtTimestamp);
    
    cues.push({
      startTime,
      endTime,
      text: textLines.join('\n')
    });
  }

  return generateVtt(cues);
};

// Parse ASS format
const parseAss = async (content: string): Promise<string> => {
  const cues: SubtitleCue[] = [];
  const lines = content.split('\n');
  let inEvents = false;
  let format: string[] = [];

  for (const line of lines) {
    if (line.startsWith('[Events]')) {
      inEvents = true;
      continue;
    }

    if (inEvents) {
      if (line.startsWith('Format:')) {
        format = line.substring(7).split(',').map(f => f.trim());
        continue;
      }

      if (line.startsWith('Dialogue:')) {
        const parts = line.substring(9).split(',');
        const startTime = convertAssTimestamp(parts[1].trim());
        const endTime = convertAssTimestamp(parts[2].trim());
        
        // Get the text part (usually the last field)
        const text = parts.slice(format.indexOf('Text')).join(',').trim()
          // Remove ASS style codes like {\\an8} or {\\pos(1,2)}
          .replace(/\{[^}]+\}/g, '')
          // Convert ASS line breaks to normal line breaks
          .replace(/\\N/g, '\n');

        cues.push({ startTime, endTime, text });
      }
    }
  }

  return generateVtt(cues);
};

// Generate WebVTT output
const generateVtt = (cues: SubtitleCue[]): string => {
  let vtt = 'WEBVTT\n\n';
  
  cues.forEach(cue => {
    vtt += `${cue.startTime} --> ${cue.endTime}\n${cue.text}\n\n`;
  });

  return vtt;
};

export const convertToVtt = async (file: File): Promise<{ content: string; success: boolean; error?: string }> => {
  try {
    const content = await file.text();
    const extension = file.name.split('.').pop()?.toLowerCase();

    switch (extension) {
      case 'srt':
        return { content: await parseSrt(content), success: true };
      case 'ass':
        return { content: await parseAss(content), success: true };
      case 'vtt':
        return { content, success: true };
      default:
        return { 
          content: '', 
          success: false, 
          error: `Unsupported subtitle format: ${extension}. Please use .vtt, .srt, or .ass files.` 
        };
    }
  } catch (error) {
    return { 
      content: '', 
      success: false, 
      error: `Error converting subtitle file: ${error instanceof Error ? error.message : String(error)}` 
    };
  }
}; 