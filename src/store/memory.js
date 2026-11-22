/**
 * Store interface (all methods may be sync or async):
 *   appendTimeline(entry)        – append one timeline entry
 *   putHand(record)              – upsert a hand: {id, title, goal, state, transcript, ...}
 *   putMetric(record)            – upsert a per-message metric by record.message
 *   load() -> {timeline, hands, metrics}
 */
export class MemoryStore {
  timeline = [];
  hands = new Map();
  metrics = new Map();
  appendTimeline(entry) { this.timeline.push(structuredClone(entry)); }
  putHand(record) { this.hands.set(record.id, structuredClone(record)); }
  putMetric(record) { this.metrics.set(record.message, structuredClone(record)); }
  load() {
    return {
      timeline: structuredClone(this.timeline),
      hands: [...this.hands.values()].map((h) => structuredClone(h)),
      metrics: [...this.metrics.values()].map((m) => structuredClone(m)),
    };
  }
}
