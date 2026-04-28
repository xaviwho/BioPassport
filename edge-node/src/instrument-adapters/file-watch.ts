import chokidar from 'chokidar';
import path from 'node:path';

export interface InstrumentEvent {
  filePath: string;
  detectedAt: number;
  instrumentId: string;
}

export function watchDirectory(
  dir: string,
  instrumentId: string,
  onEvent: (e: InstrumentEvent) => void
): () => Promise<void> {
  const watcher = chokidar.watch(dir, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });
  watcher.on('add', (filePath) => {
    onEvent({ filePath: path.resolve(filePath), detectedAt: Date.now(), instrumentId });
  });
  return () => watcher.close();
}
