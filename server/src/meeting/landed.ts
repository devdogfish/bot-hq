// Results of work an Agent started from a meeting, waiting for its meeting bridge to say them.
// Voice calls get these through the web client as [work_landed] notes; a meeting has no web client.

const MAX_NOTES = 8;
const MAX_NOTE_CHARS = 700;
const landed = new Map<string, string[]>();

let meetingFor: (botId: string) => string | undefined = () => undefined;

/** Lets the voice module say which meeting a Bot is in, without the agent loop importing it. */
export function setMeetingLookup(fn: (botId: string) => string | undefined) {
  meetingFor = fn;
}

/** The meeting a Bot is in right now, if any. */
export function activeMeetingFor(botId: string): string | undefined {
  return meetingFor(botId);
}

export function pushLanded(callId: string, text: string) {
  const note = text.replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_CHARS);
  if (!note) return;
  const notes = landed.get(callId) ?? [];
  notes.push(note);
  landed.set(callId, notes.slice(-MAX_NOTES));
}

export function takeLanded(callId: string): string[] {
  const notes = landed.get(callId) ?? [];
  landed.delete(callId);
  return notes;
}

export function forgetLanded(callId: string) {
  landed.delete(callId);
}
