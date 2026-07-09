export const MAX_TRACE_EVENTS = 5000;

export function ingestTraceEvents(eventsById, events, maxEvents = MAX_TRACE_EVENTS) {
  if (!Array.isArray(events) || events.length === 0) return;
  for (const event of events) {
    if (!event || event.id === undefined) continue;
    if (eventsById.has(event.id)) eventsById.delete(event.id);
    eventsById.set(event.id, event);
  }
  while (eventsById.size > maxEvents) {
    const oldest = eventsById.keys().next().value;
    if (oldest === undefined) break;
    eventsById.delete(oldest);
  }
}
