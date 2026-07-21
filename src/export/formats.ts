import type { TranscriptResult, TranscriptSegment } from '../inference/types';

export function toTxt(result: TranscriptResult): string {
  return `${result.text.trim()}\n`;
}

function formatSrtTimestamp(totalSeconds: number): string {
  const clamped = Math.max(0, totalSeconds);
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const seconds = Math.floor(clamped % 60);
  const millis = Math.round((clamped - Math.floor(clamped)) * 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

function formatVttTimestamp(totalSeconds: number): string {
  return formatSrtTimestamp(totalSeconds).replace(',', '.');
}

export function toSrt(segments: TranscriptSegment[]): string {
  return segments
    .map((segment, index) => {
      return `${index + 1}\n${formatSrtTimestamp(segment.startSeconds)} --> ${formatSrtTimestamp(segment.endSeconds)}\n${segment.text.trim()}\n`;
    })
    .join('\n');
}

export function toWebVtt(segments: TranscriptSegment[]): string {
  const body = segments
    .map((segment) => {
      return `${formatVttTimestamp(segment.startSeconds)} --> ${formatVttTimestamp(segment.endSeconds)}\n${segment.text.trim()}\n`;
    })
    .join('\n');
  return `WEBVTT\n\n${body}`;
}

export function downloadTextFile(filename: string, contents: string, mimeType: string): void {
  const blob = new Blob([contents], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function safeExportBasename(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `transcript-${stamp}`;
}
