import type {
  ProgressEvent,
  RuntimeDiagnostics,
  TranscriptResult,
  WorkerError,
  WorkerRequest,
  WorkerResponse,
  LanguageOption,
  RuntimePreference,
  TimestampsOption,
} from '../inference/types';

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: ProgressEvent) => void;
  kind: WorkerRequest['type'];
};

export class InferenceClient {
  private worker: Worker | null = null;
  private generation = 0;
  private pending = new Map<string, PendingRequest>();
  private requestSeq = 0;

  private ensureWorker(): Worker {
    if (this.worker) {
      return this.worker;
    }

    const generation = this.generation;
    const worker = new Worker(new URL('../workers/whisper.worker.ts', import.meta.url), {
      type: 'module',
    });

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      if (generation !== this.generation) {
        return;
      }
      this.handleMessage(event.data);
    };

    worker.onerror = () => {
      if (generation !== this.generation) {
        return;
      }
      this.failAll(new Error('Inference Worker crashed.'));
      this.hardReset();
    };

    this.worker = worker;
    return worker;
  }

  private nextRequestId(): string {
    this.requestSeq += 1;
    return `req-${this.requestSeq}-${Date.now()}`;
  }

  private handleMessage(message: WorkerResponse): void {
    if (message.protocol !== 1) {
      return;
    }

    const pending = this.pending.get(message.requestId);
    if (!pending) {
      return;
    }

    switch (message.type) {
      case 'PROGRESS':
        pending.onProgress?.(message.progress);
        break;
      case 'READY':
      case 'RESULT':
      case 'DIAGNOSTICS':
        this.pending.delete(message.requestId);
        pending.resolve(message);
        break;
      case 'CANCELLED':
        this.pending.delete(message.requestId);
        pending.reject(Object.assign(new Error('Cancelled'), { code: 'CANCELLED' }));
        break;
      case 'ERROR':
        this.pending.delete(message.requestId);
        pending.reject(toError(message.error));
        break;
      default:
        break;
    }
  }

  private post<T>(
    request: WorkerRequest,
    transfer: Transferable[] = [],
    onProgress?: (progress: ProgressEvent) => void,
  ): Promise<T> {
    const worker = this.ensureWorker();

    return new Promise<T>((resolve, reject) => {
      this.pending.set(request.requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        onProgress,
        kind: request.type,
      });
      worker.postMessage(request, transfer);
    });
  }

  prepare(
    profileId: string,
    runtimePreference: RuntimePreference,
    onProgress?: (progress: ProgressEvent) => void,
  ): Promise<{ diagnostics: RuntimeDiagnostics }> {
    const requestId = this.nextRequestId();
    return this.post(
      {
        protocol: 1,
        type: 'PREPARE',
        requestId,
        profileId,
        runtimePreference,
      },
      [],
      onProgress,
    ).then((message) => {
      const ready = message as Extract<WorkerResponse, { type: 'READY' }>;
      return { diagnostics: ready.diagnostics };
    });
  }

  transcribe(args: {
    profileId: string;
    runtimePreference: RuntimePreference;
    audio: Float32Array;
    language: LanguageOption;
    timestamps: TimestampsOption;
    onProgress?: (progress: ProgressEvent) => void;
  }): Promise<TranscriptResult> {
    const requestId = this.nextRequestId();
    const audio = args.audio;

    return this.post(
      {
        protocol: 1,
        type: 'TRANSCRIBE',
        requestId,
        profileId: args.profileId,
        runtimePreference: args.runtimePreference,
        audio,
        options: {
          language: args.language,
          task: 'transcribe',
          timestamps: args.timestamps,
        },
      },
      [audio.buffer],
      args.onProgress,
    ).then((message) => {
      const result = message as Extract<WorkerResponse, { type: 'RESULT' }>;
      return result.result;
    });
  }

  async cancel(targetRequestId?: string): Promise<void> {
    if (!this.worker) {
      return;
    }

    if (targetRequestId) {
      const requestId = this.nextRequestId();
      try {
        await this.post({
          protocol: 1,
          type: 'CANCEL',
          requestId,
          targetRequestId,
        });
      } catch {
        // Hard cancel below.
      }
    }

    this.hardReset();
  }

  hardReset(): void {
    this.generation += 1;
    this.failAll(Object.assign(new Error('Cancelled'), { code: 'CANCELLED' }));
    this.worker?.terminate();
    this.worker = null;
  }

  dispose(): void {
    this.hardReset();
  }

  private failAll(error: Error): void {
    for (const [, pending] of this.pending) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function toError(error: WorkerError): Error {
  return Object.assign(new Error(error.code), {
    code: error.code,
    phase: error.phase,
    recoverable: error.recoverable,
    diagnostic: error.diagnostic,
  });
}

export const inferenceClient = new InferenceClient();
