// A comment thread became a note with replies. Its ids are derived, not stored, so an id an agent was
// given for the thread still names the note it became.

// FNV-1a, twice with different offsets: 16 hex digits with no runtime-specific hashing
function fnv(s: string, seed: number): string {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16).padStart(8, "0");
}
const hex16 = (s: string) => fnv(s, 2166136261) + fnv(s, 3735928559);

export const noteOfThread = (threadId: string): string => "mk-" + hex16("thread:" + threadId);
export const replyOfMessage = (messageId: string): string => "mr-" + hex16("message:" + messageId);
