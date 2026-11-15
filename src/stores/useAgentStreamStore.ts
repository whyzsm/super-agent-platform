import { create } from 'zustand';
import type { DaemonEnvelope } from '../protocol';

interface AgentStreamStore {
  connected: boolean;
  lastSeq: number;
  recentEnvelopes: DaemonEnvelope[];
  pendingBatch: DaemonEnvelope[];
  startStream: () => () => void;
}

export const useAgentStreamStore = create<AgentStreamStore>((set, get) => ({
  connected: false,
  lastSeq: 0,
  recentEnvelopes: [],
  pendingBatch: [],

  startStream: () => {
    const source = new EventSource('/api/stream');

    const flushTimer = window.setInterval(() => {
      const batch = get().pendingBatch;
      if (batch.length === 0) return;
      const latestSeq = batch[batch.length - 1]?.seq ?? get().lastSeq;
      set((s) => ({
        lastSeq: Math.max(s.lastSeq, latestSeq),
        recentEnvelopes: [...batch.slice().reverse(), ...s.recentEnvelopes].slice(0, 40),
        pendingBatch: [],
      }));
    }, 100);

    source.onopen = () => {
      set({ connected: true });
    };

    source.onmessage = (event) => {
      try {
        const envelope = JSON.parse(event.data) as DaemonEnvelope;
        set((s) => ({
          pendingBatch: [...s.pendingBatch, envelope],
        }));
      } catch {
        // Ignore malformed SSE payload
      }
    };

    source.onerror = () => {
      set({ connected: false });
    };

    return () => {
      window.clearInterval(flushTimer);
      source.close();
      set({ connected: false });
    };
  },
}));
