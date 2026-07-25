import { isPlaceId, PLAYER_NAME_LIMIT, type PlaceId } from "./games.ts";
import { boundedString, finite, record } from "./validate.ts";

export type ChatPayload = { id: string; name: string; text: string; at: number; place: PlaceId };
export type ChatEntry = ChatPayload & { authorId: string; system?: boolean };
export type ChatHistoryRequest = { version: 1 };
export type ChatHistoryResponse = { messages: ChatPayload[] };

export const CHAT_TEXT_LIMIT = 180;
export const CHAT_ID_LIMIT = 120;
export const OWN_CHAT_HISTORY_LIMIT = 40;
export const CHAT_LOG_LIMIT = 100;
const CHAT_BACKDATE_LIMIT_MS = 24 * 60 * 60 * 1000;
const OWN_CHAT_STORAGE_KEY = "multiplay-own-chat-v1";

// `name` is carried so older builds still render something, but it is a
// self-declared value and must never be used for display; the log resolves the
// author's name from presence by peer id instead.
export function sanitizeChatPayload(value: unknown, now: number): ChatPayload | null {
  const item = record(value);
  if (!item) return null;
  if (!boundedString(item.id, CHAT_ID_LIMIT)) return null;
  if (typeof item.name !== "string" || item.name.length > PLAYER_NAME_LIMIT) return null;
  if (typeof item.text !== "string" || item.text.length > CHAT_TEXT_LIMIT) return null;
  if (!finite(item.at, 0, Number.MAX_SAFE_INTEGER)) return null;
  if (!isPlaceId(item.place)) return null;
  const text = item.text.trim();
  if (!text) return null;
  return {
    id: item.id,
    name: item.name,
    text,
    // Peer clocks drift in both directions. Pinning the entry inside a window
    // around now keeps a skewed sender readable without letting a crafted
    // timestamp park a message at the top or bottom of the log forever.
    at: Math.min(Math.max(item.at, now - CHAT_BACKDATE_LIMIT_MS), now),
    place: item.place,
  };
}

export function sanitizeChatHistory(value: unknown, now: number, limit = OWN_CHAT_HISTORY_LIMIT): ChatPayload[] | null {
  const item = record(value);
  if (!item || !Array.isArray(item.messages)) return null;
  // Reject before mapping so an oversized array is never walked.
  if (item.messages.length > limit) return null;
  const messages: ChatPayload[] = [];
  for (const entry of item.messages) {
    const sanitized = sanitizeChatPayload(entry, now);
    if (sanitized) messages.push(sanitized);
  }
  return messages;
}

export function mergeChatEntries(current: ChatEntry[], incoming: ChatEntry[]) {
  const system = current.find((entry) => entry.system);
  const byMessageId = new Map<string, ChatEntry>();
  for (const entry of [...current, ...incoming]) {
    // First entry wins so a peer reusing a known id cannot rewrite a
    // displayed message.
    if (!entry.system && !byMessageId.has(entry.id)) byMessageId.set(entry.id, entry);
  }
  const messages = [...byMessageId.values()]
    // The id tiebreak keeps equal timestamps from reshuffling on every render.
    .sort((first, second) => first.at - second.at || first.id.localeCompare(second.id))
    .slice(-(CHAT_LOG_LIMIT - (system ? 1 : 0)));
  return system ? [system, ...messages] : messages;
}

export function loadOwnChatHistory() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(OWN_CHAT_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(stored)) return [];
    const now = Date.now();
    return stored
      .map((item) => sanitizeChatPayload(item, now))
      .filter((item): item is ChatPayload => item !== null)
      .slice(-OWN_CHAT_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

export function saveOwnChatHistory(history: ChatPayload[]) {
  try {
    window.localStorage.setItem(OWN_CHAT_STORAGE_KEY, JSON.stringify(history.slice(-OWN_CHAT_HISTORY_LIMIT)));
  } catch {
    // Storage can be unavailable in private modes; live chat should continue working.
  }
}
