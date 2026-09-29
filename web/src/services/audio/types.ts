export interface Microphone {
  readonly label: string;
  startSending(send: (chunk: ArrayBuffer) => void): void;
  stopSending(): void;
  release(): Promise<void>;
}
