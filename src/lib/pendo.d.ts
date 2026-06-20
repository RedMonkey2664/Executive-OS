interface PendoTrackFunction {
  (eventName: string, properties?: Record<string, string | number | boolean>): void;
}

interface Pendo {
  track: PendoTrackFunction;
}

declare const pendo: Pendo | undefined;
