import { FormEvent, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { joinRoom, selfId } from "trystero";
import {
  CHAT_TEXT_LIMIT,
  formatChatTimestamp,
  loadOwnChatHistory,
  mergeChatEntries,
  OWN_CHAT_HISTORY_LIMIT,
  sanitizeChatHistory,
  saveOwnChatHistory,
  sanitizeChatPayload,
  type ChatEntry,
  type ChatHistoryRequest,
  type ChatHistoryResponse,
  type ChatPayload,
} from "./chat.ts";
import {
  GAME_DEFINITIONS as GAMES,
  GAME_HEIGHT as HEIGHT,
  GAME_WIDTH as WIDTH,
  PLAYER_NAME_LIMIT,
  type GameDefinition,
  type GameId,
  type PlaceId,
  type PlayerState,
} from "./games.ts";
import {
  addBomb,
  createArenaRuntime,
  drawArena,
  drawDeathOverlay,
  sanitizeBombEvent,
  stepArena,
  tryPlaceBomb,
} from "./arenaGame.ts";
import { dropNpcsOwnedBy, receiveNpcSnapshot, sanitizeNpcSnapshot, toWireNpcs, type NpcSnapshot } from "./arenaNpc.ts";
import { cellCenterX, cellCenterY, SPAWN_CELLS, type ArenaSnapshot, type BombEvent } from "./arena.ts";
import { correctedRoomNow, observeSkew, peerSkews, type SkewStore } from "./clock.ts";
import { applyLobbyImpulse, isLobbyImpulsePlausible, resolveLobbyCollisions, steerLobbyPlayer } from "./lobbyPhysics.ts";
import { advanceFixedSteps } from "./timestep.ts";
import {
  isNewerVersion,
  parseLobbyImpulse,
  parsePresence,
  PROTO_VERSION,
  STATE_SEND_MS,
  type LobbyImpulsePayload,
  type PresencePayload,
} from "./protocol.ts";
import { receiveRemotePlayer, smoothRemotePlayers, toWirePlayer, type RemoteMotion, type WirePlayer } from "./remotePlayers.ts";

type Player = PlayerState;

const COLORS = ["#f9e547", "#ff6b8a", "#68e6c1", "#73a7ff", "#cf83ff", "#ff9d4d"];
const APP_ID = "ainyan-multiplay-arcade-v2";
const CHAT_VISIBLE_MS = 6_000;
// 60Hz, with a small cap so a tab returning from the background catches up
// without replaying every step it missed.
const ARENA_STEP_MS = 1000 / 60;
const ARENA_MAX_STEPS = 5;
const NPC_SEND_MS = 200;
// Monotonic across room changes and rejoins, so a peer that reconnects is never
// mistaken for one replaying old updates.
let stateSeq = 0;
function nextStateSeq() {
  stateSeq += 1;
  return stateSeq;
}

// Rejoining before the first peer is met corrupts discovery instead of helping
// it. Trystero keys relay subscriptions by topic without reference counting, so
// while the initial subscribe is still in flight, a leave/join pair resolves as
// subscribe, subscribe, unsubscribe -- and the trailing unsubscribe cancels the
// subscription the new room just made. The tab then announces itself forever
// while listening to nothing. Once a peer has answered, the subscribe has
// settled and the same sequence is ordered safely.
let hasMetPeer = false;
function notePeerMet() {
  hasMetPeer = true;
}
const LOBBY = {
  id: "lobby" as const,
  icon: "⌂",
  title: "LOBBY PLAZA",
  shortTitle: "LOBBY",
  subtitle: "みんなの待ち合わせ広場",
  description: "ゲームを選んだり、チャットで仲間を誘ったりする常設のミニゲーム広場。",
  players: "人数制限なし",
  accent: "blue",
};

const PLACES = [LOBBY, ...GAMES];
const LOBBY_PORTALS = GAMES.map((game) => ({ gameId: game.id, ...game.portal }));

function shortId(id: string) {
  return id.slice(0, 5).toUpperCase();
}

let sharedAudioContext: AudioContext | null = null;

// Browsers cap concurrent AudioContexts, so every tone reuses a single lazily created one.
function getAudioContext() {
  if (!sharedAudioContext) {
    const AudioCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor) return null;
    sharedAudioContext = new AudioCtor();
  }
  if (sharedAudioContext.state === "suspended") void sharedAudioContext.resume();
  return sharedAudioContext;
}

function useReconnectEpoch() {
  const [epoch, setEpoch] = useState(0);
  const lastReconnectRef = useRef(0);
  const requestReconnect = useCallback(() => {
    if (!hasMetPeer) return;
    const now = Date.now();
    if (now - lastReconnectRef.current < 800) return;
    lastReconnectRef.current = now;
    setEpoch((current) => current + 1);
  }, []);

  useEffect(() => {
    let wasHidden = document.hidden;
    const onVisibility = () => {
      if (document.hidden) { wasHidden = true; return; }
      if (wasHidden) { wasHidden = false; requestReconnect(); }
    };
    const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) requestReconnect(); };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("online", requestReconnect);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("online", requestReconnect);
    };
  }, [requestReconnect]);

  return { epoch, requestReconnect };
}

function useCommunity(name: string, place: PlaceId, connectionEpoch: number) {
  const [initialOwnHistory] = useState(loadOwnChatHistory);
  const ownHistoryRef = useRef<ChatPayload[]>(initialOwnHistory);
  const [presence, setPresence] = useState<Map<string, PresencePayload>>(() => new Map());
  const [chats, setChats] = useState<ChatEntry[]>(() => [{
    id: "welcome",
    authorId: "system",
    name: "SYSTEM",
    text: "MULTIPLAYへようこそ。ロビーもひとつの遊び場です。",
    at: Date.now(),
    place: "lobby",
    system: true,
  }, ...initialOwnHistory.map((message) => ({ ...message, authorId: selfId }))]);
  const [outdated, setOutdated] = useState(false);
  const sendPresenceRef = useRef<((payload: PresencePayload) => Promise<void>) | null>(null);
  const sendChatRef = useRef<((payload: ChatPayload) => Promise<void>) | null>(null);
  const identityRef = useRef({ name, place });

  const publishPresence = useCallback(() => {
    const payload: PresencePayload = {
      name: identityRef.current.name || "PLAYER",
      place: identityRef.current.place,
      at: Date.now(),
      v: PROTO_VERSION,
    };
    setPresence((current) => new Map(current).set(selfId, payload));
    void sendPresenceRef.current?.(payload);
  }, []);

  useEffect(() => {
    identityRef.current = { name, place };
    publishPresence();
  }, [name, place, publishPresence]);

  useEffect(() => {
    const localPresence: PresencePayload = {
      name: identityRef.current.name || "PLAYER",
      place: identityRef.current.place,
      at: Date.now(),
      v: PROTO_VERSION,
    };
    setPresence(new Map([[selfId, localPresence]]));
    const room = joinRoom({ appId: APP_ID, relayConfig: { redundancy: 3 } }, "community-hub");
    const presenceAction = room.makeAction<PresencePayload>("presence-v1");
    const chatAction = room.makeAction<ChatPayload>("chat-v1");
    const historyAction = room.makeAction<ChatHistoryRequest, ChatHistoryResponse>("chat-history-v1", {
      kind: "request",
      onRequest: (request) => ({
        messages: request?.version === 1 ? ownHistoryRef.current.slice(-OWN_CHAT_HISTORY_LIMIT) : [],
      }),
    });
    sendPresenceRef.current = (payload) => presenceAction.send(payload);
    sendChatRef.current = (payload) => chatAction.send(payload);

    presenceAction.onMessage = (payload, { peerId }) => {
      const parsed = parsePresence(payload, Date.now());
      if (!parsed) return;
      if (isNewerVersion(parsed.v)) setOutdated(true);
      setPresence((current) => new Map(current).set(peerId, parsed));
    };
    chatAction.onMessage = (payload, { peerId }) => {
      const sanitized = sanitizeChatPayload(payload, Date.now());
      if (!sanitized) return;
      setChats((current) => mergeChatEntries(current, [{ ...sanitized, authorId: peerId }]));
    };
    room.onPeerJoin = (peerId) => {
      notePeerMet();
      publishPresence();
      void historyAction.request({ version: 1 }, { target: peerId, timeoutMs: 3_000 }).then((response) => {
        const messages = sanitizeChatHistory(response, Date.now());
        if (!messages?.length) return;
        // The peer that answered is recorded as the author; it only ever serves
        // its own messages, so it cannot attribute history to anyone else.
        const restored = messages.map((message): ChatEntry => ({ ...message, authorId: peerId }));
        setChats((current) => mergeChatEntries(current, restored));
      }).catch(() => undefined);
    };
    room.onPeerLeave = (peerId) => {
      setPresence((current) => {
        const next = new Map(current);
        next.delete(peerId);
        return next;
      });
    };

    publishPresence();
    const presenceTimer = window.setInterval(publishPresence, 10_000);
    const cleanupTimer = window.setInterval(() => {
      const cutoff = Date.now() - 30_000;
      setPresence((current) => new Map([...current].filter(([id, item]) => id === selfId || item.at >= cutoff)));
    }, 5_000);

    const onPageHide = () => { void room.leave(); };
    window.addEventListener("pagehide", onPageHide);

    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.clearInterval(presenceTimer);
      window.clearInterval(cleanupTimer);
      sendPresenceRef.current = null;
      sendChatRef.current = null;
      void room.leave();
    };
  }, [publishPresence, connectionEpoch]);

  const sendChat = useCallback((rawText: string) => {
    const text = rawText.trim().slice(0, CHAT_TEXT_LIMIT);
    if (!text) return;
    const payload: ChatPayload = {
      id: `${selfId}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
      name: identityRef.current.name || "PLAYER",
      text,
      at: Date.now(),
      place: identityRef.current.place,
    };
    ownHistoryRef.current = [...ownHistoryRef.current, payload].slice(-OWN_CHAT_HISTORY_LIMIT);
    saveOwnChatHistory(ownHistoryRef.current);
    setChats((current) => mergeChatEntries(current, [{ ...payload, authorId: selfId }]));
    void sendChatRef.current?.(payload);
  }, []);

  const counts = useMemo(() => {
    const result = Object.fromEntries(PLACES.map((item) => [item.id, 0])) as Record<PlaceId, number>;
    for (const item of presence.values()) result[item.place] += 1;
    return result;
  }, [presence]);

  // Chat renders names from here rather than from the message, so a peer cannot
  // post under someone else's name.
  const names = useMemo(() => {
    const result = new Map<string, string>();
    for (const [id, item] of presence) if (item.name) result.set(id, item.name);
    return result;
  }, [presence]);

  return { chats, counts, names, outdated, sendChat };
}

export function Arcade() {
  // `?game=<id>` opens a game straight away, so a link can point at one.
  const [gameId, setGameId] = useState<GameId | null>(() => {
    const requested = new URLSearchParams(window.location.search).get("game");
    return GAMES.some((game) => game.id === requested) ? (requested as GameId) : null;
  });
  const [name, setName] = useState(() => `PLAYER-${Math.floor(100 + Math.random() * 900)}`);
  const [sound, setSound] = useState(true);
  const { epoch: connectionEpoch } = useReconnectEpoch();
  const place: PlaceId = gameId ?? "lobby";
  const community = useCommunity(name, place, connectionEpoch);
  const selected = GAMES.find((game) => game.id === gameId);

  useEffect(() => {
    const saved = window.localStorage.getItem("multiplay-name");
    if (saved) setName(saved);
  }, []);

  useEffect(() => {
    window.localStorage.setItem("multiplay-name", name);
  }, [name]);

  return (
    <>
      {selected ? (
        <GameScreen
          game={selected}
          name={name}
          sound={sound}
          chats={community.chats}
          counts={community.counts}
          connectionEpoch={connectionEpoch}
          onSound={() => setSound((value) => !value)}
          onLeave={() => setGameId(null)}
        />
      ) : (
        <LobbyScreen name={name} chats={community.chats} counts={community.counts} connectionEpoch={connectionEpoch} onName={setName} onJoin={setGameId} />
      )}
      <ChatPanel chats={community.chats} names={community.names} place={place} onSend={community.sendChat} />
      {community.outdated && (
        <div className="update-banner" role="status">
          新しいバージョンが公開されています。ページを再読み込みしてください。
        </div>
      )}
    </>
  );
}

function LobbyScreen({ name, chats, counts, connectionEpoch, onName, onJoin }: {
  name: string;
  chats: ChatEntry[];
  counts: Record<PlaceId, number>;
  connectionEpoch: number;
  onName: (name: string) => void;
  onJoin: (id: GameId) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playersRef = useRef<Map<string, Player>>(new Map());
  const remoteMotionsRef = useRef<Map<string, RemoteMotion>>(new Map());
  const keysRef = useRef(new Set<string>());
  const stickRef = useRef({ x: 0, y: 0 });
  const sendStateRef = useRef<((state: WirePlayer) => Promise<void>) | null>(null);
  const sendImpulseRef = useRef<((impulse: LobbyImpulsePayload) => Promise<void>) | null>(null);
  const collisionTimesRef = useRef(new Map<string, number>());
  const receivedImpulseIdsRef = useRef(new Set<string>());
  const chatsRef = useRef(chats);
  const countsRef = useRef(counts);
  const nameRef = useRef(name);
  const nearGameRef = useRef<GameId | null>(null);
  const [nearGame, setNearGame] = useState<GameId | null>(null);
  const [connected, setConnected] = useState(1);
  const color = useMemo(() => COLORS[Math.floor(Math.random() * COLORS.length)], []);

  useEffect(() => { chatsRef.current = chats; }, [chats]);
  useEffect(() => { countsRef.current = counts; }, [counts]);
  useEffect(() => {
    nameRef.current = name;
    const me = playersRef.current.get(selfId);
    if (me) me.name = name || "PLAYER";
  }, [name]);

  const setStick = useCallback((x: number, y: number) => { stickRef.current = { x, y }; }, []);
  const enterPortal = useCallback(() => {
    if (nearGameRef.current) onJoin(nearGameRef.current);
  }, [onJoin]);
  const broadcastState = useCallback(() => {
    const me = playersRef.current.get(selfId);
    if (!me) return;
    const now = Date.now();
    me.seen = now;
    void sendStateRef.current?.(toWirePlayer(me, nextStateSeq(), now));
  }, []);

  useEffect(() => {
    const existing = playersRef.current.get(selfId);
    playersRef.current.clear();
    remoteMotionsRef.current.clear();
    collisionTimesRef.current.clear();
    receivedImpulseIdsRef.current.clear();
    playersRef.current.set(selfId, existing ?? {
      id: selfId, name: nameRef.current || "PLAYER", x: WIDTH / 2, y: HEIGHT / 2,
      vx: 0, vy: 0, color, score: 0, seen: Date.now(),
    });
    setConnected(1);
    const room = joinRoom({ appId: APP_ID, relayConfig: { redundancy: 3 } }, "public-lobby");
    const stateAction = room.makeAction<WirePlayer>("player-state");
    const impulseAction = room.makeAction<LobbyImpulsePayload>("collision-impulse-v1");
    sendStateRef.current = (state) => stateAction.send(state);
    sendImpulseRef.current = (impulse) => impulseAction.send(impulse);
    stateAction.onMessage = (state, { peerId }) => {
      receiveRemotePlayer(playersRef.current, remoteMotionsRef.current, state, peerId, Date.now());
    };
    impulseAction.onMessage = (payload, { peerId }) => {
      const impulse = parseLobbyImpulse(payload, selfId);
      if (!impulse || receivedImpulseIdsRef.current.has(impulse.id)) return;
      const me = playersRef.current.get(selfId);
      const source = playersRef.current.get(peerId);
      if (!me || !source || !isLobbyImpulsePlausible(me, source, impulse.vx, impulse.vy, Date.now())) return;
      receivedImpulseIdsRef.current.add(impulse.id);
      if (receivedImpulseIdsRef.current.size > 128) {
        const oldest = receivedImpulseIdsRef.current.values().next().value;
        if (oldest) receivedImpulseIdsRef.current.delete(oldest);
      }
      applyLobbyImpulse(me, impulse.vx, impulse.vy);
    };
    room.onPeerJoin = () => {
      notePeerMet();
      setConnected(Object.keys(room.getPeers()).length + 1);
      broadcastState();
    };
    room.onPeerLeave = (peerId) => {
      playersRef.current.delete(peerId);
      remoteMotionsRef.current.delete(peerId);
      setConnected(Object.keys(room.getPeers()).length + 1);
    };

    // Broadcasting from a timer rather than the animation frame keeps a
    // backgrounded tab visible to everyone else: browsers throttle rAF to a
    // standstill, which used to make the player vanish after the ghost timeout.
    const stateTimer = window.setInterval(broadcastState, STATE_SEND_MS);
    const onPageHide = () => { void room.leave(); };
    window.addEventListener("pagehide", onPageHide);

    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.clearInterval(stateTimer);
      sendStateRef.current = null;
      sendImpulseRef.current = null;
      void room.leave();
    };
  }, [broadcastState, color, connectionEpoch]);

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      keysRef.current.add(event.key.toLowerCase());
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(event.key)) event.preventDefault();
      if (event.key === " ") enterPortal();
    };
    const up = (event: KeyboardEvent) => keysRef.current.delete(event.key.toLowerCase());
    window.addEventListener("keydown", down); window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, [enterPortal]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    let frame = 0; let previous = performance.now();
    const loop = (time: number) => {
      const dt = Math.min((time - previous) / 1000, .05); previous = time;
      const now = Date.now();
      const me = playersRef.current.get(selfId);
      if (!me) { frame = requestAnimationFrame(loop); return; }
      const keys = keysRef.current;
      const keyboardX = Number(keys.has("d") || keys.has("arrowright")) - Number(keys.has("a") || keys.has("arrowleft"));
      const keyboardY = Number(keys.has("s") || keys.has("arrowdown")) - Number(keys.has("w") || keys.has("arrowup"));
      const keyboardLength = Math.hypot(keyboardX, keyboardY) || 1;
      const dx = keyboardX ? keyboardX / keyboardLength : stickRef.current.x;
      const dy = keyboardY ? keyboardY / keyboardLength : stickRef.current.y;
      steerLobbyPlayer(me, dx, dy, dt);
      me.x += me.vx * dt;
      me.y += me.vy * dt;
      smoothRemotePlayers(playersRef.current, remoteMotionsRef.current, selfId, dt, now);
      const collisionImpulses = resolveLobbyCollisions(me, playersRef.current, now, collisionTimesRef.current);
      for (const impulse of collisionImpulses) {
        void sendImpulseRef.current?.({
          id: `${selfId}:${impulse.targetId}:${now}`,
          targetId: impulse.targetId,
          vx: impulse.vx,
          vy: impulse.vy,
          at: now,
        });
      }
      const closest = LOBBY_PORTALS.find((portal) => Math.hypot(me.x - portal.x, me.y - portal.y) < 76)?.gameId ?? null;
      if (closest !== nearGameRef.current) { nearGameRef.current = closest; setNearGame(closest); }
      for (const [id, player] of playersRef.current) if (id !== selfId && now - player.seen > 10_000) {
        playersRef.current.delete(id); remoteMotionsRef.current.delete(id);
      }
      drawLobby(context, [...playersRef.current.values()], chatsRef.current, countsRef.current, closest, now);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, []);

  const nearby = GAMES.find((game) => game.id === nearGame);
  return (
    <main className="play-shell lobby-world-shell has-chat">
      <header className="play-header lobby-world-header">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <div><strong>MULTIPLAY</strong><small>LOBBY MAP</small></div>
        </div>
        <label className="lobby-name" htmlFor="player-name"><span>PLAYER</span><input id="player-name" maxLength={PLAYER_NAME_LIMIT} value={name} onChange={(event) => onName(event.target.value.toUpperCase())} /></label>
        <div className="play-status"><span className="online-dot" /> {connected} IN PLAZA</div>
      </header>
      <nav className="occupancy-strip" aria-label="各ゲームの参加人数">
        {PLACES.map((item) => <span className={item.id === "lobby" ? "active" : ""} key={item.id}><b>{item.shortTitle}</b> {counts[item.id]}</span>)}
      </nav>
      <section className="lobby-world-stage">
        <canvas ref={canvasRef} width={WIDTH} height={HEIGHT} aria-label="LOBBY MAP ロビー広場" />
        <div className={`portal-prompt ${nearby ? "visible" : ""}`}>
          {nearby ? <><b>{nearby.icon} {nearby.title}</b><span><kbd>SPACE</kbd> または <kbd>A</kbd> で入る</span></> : <span>入口まで歩いてゲームを選ぼう</span>}
        </div>
      </section>
      <MobileController onMove={setStick} onAction={nearGame ? enterPortal : undefined} actionLabel="A" />
      <div className="controls-bar lobby-controls"><span><kbd>WASD</kbd><kbd>↑↓←→</kbd> 移動</span><span><kbd>SPACE</kbd> 入口に入る</span><span><kbd>ENTER</kbd> チャット</span><p>マップ上の入口に近づくと、参加中の人数とゲーム名を確認できます。</p></div>
    </main>
  );
}

function ChatPanel({ chats, names, place, onSend }: {
  chats: ChatEntry[];
  names: Map<string, string>;
  place: PlaceId;
  onSend: (text: string) => void;
}) {
  type ChatSize = "collapsed" | "compact" | "expanded";
  const [draft, setDraft] = useState("");
  const [size, setSize] = useState<ChatSize>("compact");
  const [inputActive, setInputActive] = useState(false);
  const [unread, setUnread] = useState(0);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const logPointerRef = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const previousCountRef = useRef(chats.length);
  const atBottomRef = useRef(true);
  const focusHeightRef = useRef(0);
  const restingHeightRef = useRef(window.visualViewport?.height ?? window.innerHeight);
  const keyboardOpenRef = useRef(false);

  const focusChat = useCallback(() => {
    flushSync(() => {
      setSize((current) => current === "collapsed" ? "compact" : current);
      setInputActive(true);
    });
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  const updateKeyboardState = useCallback(() => {
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const focused = document.activeElement === inputRef.current;
    if (!focused) restingHeightRef.current = viewportHeight;
    const baseline = Math.max(focusHeightRef.current, restingHeightRef.current);
    const keyboardOpen = focused && baseline - viewportHeight > 100;
    document.documentElement.classList.toggle("screen-keyboard-open", keyboardOpen);
    if (keyboardOpen && !keyboardOpenRef.current) window.dispatchEvent(new Event("multiplay:controller-reset"));
    keyboardOpenRef.current = keyboardOpen;
  }, []);

  useEffect(() => {
    const log = logRef.current;
    const added = Math.max(0, chats.length - previousCountRef.current);
    previousCountRef.current = chats.length;
    const ownMessage = chats.at(-1)?.authorId === selfId;
    if (log && size !== "collapsed" && (atBottomRef.current || ownMessage)) {
      log.scrollTop = log.scrollHeight;
      setUnread(0);
    } else if (added > 0 && !ownMessage) {
      setUnread((current) => current + added);
    }
  }, [chats, size]);

  useEffect(() => {
    if (!window.matchMedia("(max-width: 900px)").matches) return;
    setSize("compact");
  }, [place]);

  useEffect(() => {
    if (size === "collapsed") return;
    const log = logRef.current;
    if (log && atBottomRef.current) log.scrollTop = log.scrollHeight;
  }, [size]);

  useEffect(() => {
    const onKeyboardShortcut = (event: KeyboardEvent) => {
      if (!window.matchMedia("(pointer: fine)").matches || event.key !== "Enter" || event.repeat || event.isComposing) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.target instanceof HTMLButtonElement || event.target instanceof HTMLTextAreaElement) return;
      event.preventDefault();
      focusChat();
    };
    window.addEventListener("multiplay:chat-focus", focusChat);
    window.addEventListener("keydown", onKeyboardShortcut);
    return () => {
      window.removeEventListener("multiplay:chat-focus", focusChat);
      window.removeEventListener("keydown", onKeyboardShortcut);
      document.documentElement.classList.remove("screen-keyboard-open");
    };
  }, [focusChat]);

  useEffect(() => {
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", updateKeyboardState);
    viewport?.addEventListener("scroll", updateKeyboardState);
    window.addEventListener("resize", updateKeyboardState);
    return () => {
      viewport?.removeEventListener("resize", updateKeyboardState);
      viewport?.removeEventListener("scroll", updateKeyboardState);
      window.removeEventListener("resize", updateKeyboardState);
    };
  }, [updateKeyboardState]);

  useEffect(() => {
    document.documentElement.classList.toggle("chat-focus-active", inputActive);
    return () => document.documentElement.classList.remove("chat-focus-active");
  }, [inputActive]);

  const sendDraft = () => {
    if (!draft.trim()) return;
    onSend(draft);
    setDraft("");
    setUnread(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    sendDraft();
  };

  const handleScroll = () => {
    const log = logRef.current;
    if (!log) return;
    atBottomRef.current = log.scrollHeight - log.scrollTop - log.clientHeight < 28;
    if (atBottomRef.current) setUnread(0);
  };

  const beginLogPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    logPointerRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
  };

  const moveLogPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = logPointerRef.current;
    if (!start || start.id !== event.pointerId) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 7) start.moved = true;
  };

  const endLogPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = logPointerRef.current;
    logPointerRef.current = null;
    const selection = window.getSelection();
    if (!start || start.id !== event.pointerId || start.moved || (selection && !selection.isCollapsed)) return;
    focusChat();
  };

  const openChat = () => {
    setSize("compact");
    setUnread(0);
  };

  // Resolved from presence, never from the message, so a peer serving history
  // cannot make its messages appear under another player's name.
  const authorName = (chat: ChatEntry) =>
    chat.system ? chat.name : names.get(chat.authorId) ?? shortId(chat.authorId);

  const latest = [...chats].reverse().find((chat) => !chat.system);

  return (
    <aside className={`chat-panel ${size} ${inputActive ? "input-active" : "input-idle"}`} aria-label="全体チャット">
      <header>
        <button className="chat-heading" type="button" onClick={size === "collapsed" ? openChat : undefined} aria-expanded={size !== "collapsed"}>
          <span className="online-dot" /><strong>{inputActive ? "TYPING" : "GLOBAL CHAT"}</strong>
          {size === "collapsed" && latest && <em><b>{authorName(latest)}</b> {latest.text}</em>}
          {unread > 0 && <i className="unread-badge">{unread > 99 ? "99+" : unread}</i>}
        </button>
        <div className="chat-tools">
          <small>{PLACES.find((item) => item.id === place)?.shortTitle}</small>
          {size !== "collapsed" && <button type="button" onClick={focusChat} aria-label="メッセージを入力する">✎</button>}
          {size !== "collapsed" && <button type="button" onClick={() => setSize(size === "expanded" ? "compact" : "expanded")} aria-label={size === "expanded" ? "チャットを通常サイズに戻す" : "チャットを拡大する"}>{size === "expanded" ? "↙" : "↗"}</button>}
          <button type="button" onClick={() => {
            const collapsing = size !== "collapsed";
            setSize(collapsing ? "collapsed" : "compact");
            if (collapsing) { inputRef.current?.blur(); setInputActive(false); }
          }} aria-label={size === "collapsed" ? "チャットを開く" : "チャットを最小化する"}>{size === "collapsed" ? "+" : "−"}</button>
        </div>
      </header>
      <div
        className="chat-log"
        ref={logRef}
        onScroll={handleScroll}
        onPointerDown={beginLogPointer}
        onPointerMove={moveLogPointer}
        onPointerUp={endLogPointer}
        onPointerCancel={() => { logPointerRef.current = null; }}
        aria-label="チャットログ。クリックまたはタップでメッセージを入力"
        aria-live="polite"
      >
        {chats.map((chat) => (
          <div className={`chat-message ${chat.system ? "system" : chat.authorId === selfId ? "own" : "other"}`} key={chat.id}>
            <p>
              <b>{authorName(chat)}</b>
              <small>{PLACES.find((item) => item.id === chat.place)?.shortTitle}</small>
              <time dateTime={new Date(chat.at).toISOString()}>{formatChatTimestamp(chat.at)}</time>
            </p>
            <span>{chat.text}</span>
          </div>
        ))}
      </div>
      <form ref={formRef} onSubmit={submit}>
        <textarea
          ref={inputRef}
          aria-label="チャットメッセージ"
          enterKeyHint="send"
          inputMode="text"
          maxLength={CHAT_TEXT_LIMIT}
          placeholder={inputActive ? "メッセージを入力…" : "ENTER / CHAT またはここをタップして入力"}
          readOnly={!inputActive}
          rows={1}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onPointerDown={(event) => {
            if (inputActive) return;
            event.preventDefault();
            focusChat();
          }}
          onFocus={() => {
            setInputActive(true);
            focusHeightRef.current = Math.max(restingHeightRef.current, window.visualViewport?.height ?? window.innerHeight);
            if (size === "collapsed") setSize("compact");
            requestAnimationFrame(() => {
              inputRef.current?.scrollIntoView({ block: "nearest" });
              updateKeyboardState();
            });
          }}
          onBlur={() => {
            focusHeightRef.current = 0;
            requestAnimationFrame(() => {
              updateKeyboardState();
              if (!formRef.current?.contains(document.activeElement)) setInputActive(false);
            });
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter" && !event.shiftKey) {
              if (event.nativeEvent.isComposing) return;
              event.preventDefault();
              if (draft.trim()) sendDraft();
              else inputRef.current?.blur();
            }
          }}
        />
        <button
          aria-label={inputActive ? "送信" : "メッセージ入力を開始"}
          type={inputActive ? "submit" : "button"}
          onPointerDown={(event) => {
            if (inputActive) return;
            event.preventDefault();
            focusChat();
          }}
        >{inputActive ? "SEND" : "CHAT"}</button>
      </form>
    </aside>
  );
}

function MobileController({ onMove, onAction, actionLabel }: {
  onMove: (x: number, y: number) => void;
  onAction?: () => void;
  actionLabel: string;
}) {
  const baseRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef<number | null>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });

  const resetStick = useCallback(() => {
    pointerRef.current = null;
    setKnob({ x: 0, y: 0 });
    onMove(0, 0);
    document.documentElement.classList.remove("controller-active");
  }, [onMove]);

  const updateStick = useCallback((clientX: number, clientY: number) => {
    const rect = baseRef.current?.getBoundingClientRect();
    if (!rect) return;
    const radius = Math.min(rect.width, rect.height) * .34;
    const rawX = clientX - (rect.left + rect.width / 2);
    const rawY = clientY - (rect.top + rect.height / 2);
    const distance = Math.hypot(rawX, rawY);
    const scale = distance > radius ? radius / distance : 1;
    const x = rawX * scale; const y = rawY * scale;
    const strength = Math.min(1, distance / radius);
    const adjusted = strength < .12 ? 0 : (strength - .12) / .88;
    setKnob({ x, y });
    onMove(distance ? rawX / distance * adjusted : 0, distance ? rawY / distance * adjusted : 0);
    document.getSelection()?.removeAllRanges();
  }, [onMove]);

  useEffect(() => {
    const onVisibility = () => { if (document.hidden) resetStick(); };
    window.addEventListener("blur", resetStick);
    window.addEventListener("multiplay:controller-reset", resetStick);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      resetStick();
      window.removeEventListener("blur", resetStick);
      window.removeEventListener("multiplay:controller-reset", resetStick);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [resetStick]);

  const startStick = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (pointerRef.current !== null) return;
    pointerRef.current = event.pointerId;
    // Synthetic or already released pointers make this throw, which would abort
    // the handler and leave the stick stuck mid-press.
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* capture is optional */ }
    document.documentElement.classList.add("controller-active");
    document.getSelection()?.removeAllRanges();
    updateStick(event.clientX, event.clientY);
  };
  const moveStick = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pointerRef.current !== event.pointerId) return;
    event.preventDefault();
    updateStick(event.clientX, event.clientY);
  };
  const endStick = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pointerRef.current !== event.pointerId) return;
    event.preventDefault();
    resetStick();
  };

  return (
    <div className="mobile-controller" aria-label="スマートフォン用仮想コントローラ">
      <div
        className="analog-stick"
        ref={baseRef}
        role="slider"
        aria-label="移動用アナログスティック"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(Math.min(1, Math.hypot(knob.x, knob.y) / 45) * 100)}
        tabIndex={-1}
        onPointerDown={startStick}
        onPointerMove={moveStick}
        onPointerUp={endStick}
        onPointerCancel={endStick}
        onLostPointerCapture={endStick}
        onContextMenu={(event) => event.preventDefault()}
      >
        <span className="stick-ring" />
        <span className="stick-knob" style={{ transform: `translate(${knob.x}px,${knob.y}px)` }} />
      </div>
      <div className="controller-actions">
        <button className="chat-action" type="button" onPointerDown={(event) => { event.preventDefault(); window.dispatchEvent(new Event("multiplay:chat-focus")); }}>CHAT</button>
        <button className="primary-action" type="button" disabled={!onAction} onPointerDown={(event) => { event.preventDefault(); onAction?.(); }}>{actionLabel}</button>
      </div>
    </div>
  );
}

function GameScreen({ game, name, sound, chats, counts, connectionEpoch, onSound, onLeave }: {
  game: GameDefinition;
  name: string;
  sound: boolean;
  chats: ChatEntry[];
  counts: Record<PlaceId, number>;
  connectionEpoch: number;
  onSound: () => void;
  onLeave: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playersRef = useRef<Map<string, Player>>(new Map());
  const remoteMotionsRef = useRef<Map<string, RemoteMotion>>(new Map());
  const arenaRef = useRef(createArenaRuntime());
  const keysRef = useRef(new Set<string>());
  const stickRef = useRef({ x: 0, y: 0 });
  const sendStateRef = useRef<((state: WirePlayer) => Promise<void>) | null>(null);
  const sendBombRef = useRef<((bomb: BombEvent) => Promise<void>) | null>(null);
  const sendNpcsRef = useRef<((snapshot: NpcSnapshot) => Promise<void>) | null>(null);
  const skewRef = useRef<SkewStore>(new Map());
  const collectedRef = useRef(new Set<string>());
  const chatsRef = useRef(chats);
  const nameRef = useRef(name);
  const [connected, setConnected] = useState(1);
  const [scoreboard, setScoreboard] = useState<Player[]>([]);
  const color = useMemo(() => COLORS[Math.floor(Math.random() * COLORS.length)], []);

  useEffect(() => { chatsRef.current = chats; }, [chats]);
  useEffect(() => {
    nameRef.current = name;
    const me = playersRef.current.get(selfId);
    if (me) me.name = name || "PLAYER";
  }, [name]);

  const soundRef = useRef(sound);
  useEffect(() => { soundRef.current = sound; }, [sound]);

  const playTone = useCallback((frequency: number) => {
    if (!soundRef.current) return;
    const context = getAudioContext();
    if (!context) return;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "square";
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.045, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.09);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(); oscillator.stop(context.currentTime + 0.1);
  }, []);

  const triggerAction = useCallback(() => {
    if (game.kind !== "arena") return;
    const me = playersRef.current.get(selfId);
    if (!me) return;
    const roomNow = correctedRoomNow(Date.now(), peerSkews(skewRef.current));
    const bomb = tryPlaceBomb(arenaRef.current, me, selfId, roomNow);
    if (!bomb) return;
    addBomb(arenaRef.current, bomb);
    void sendBombRef.current?.(bomb);
    playTone(180);
  }, [game.kind, playTone]);

  const setStick = useCallback((x: number, y: number) => { stickRef.current = { x, y }; }, []);
  const broadcastState = useCallback(() => {
    const me = playersRef.current.get(selfId);
    if (!me) return;
    const now = Date.now();
    me.seen = now;
    void sendStateRef.current?.(toWirePlayer(me, nextStateSeq(), now));
  }, []);

  useEffect(() => {
    const now = Date.now();
    const existing = playersRef.current.get(selfId);
    playersRef.current.clear();
    remoteMotionsRef.current.clear();
    skewRef.current.clear();
    // Bombs and enemies belong to the room we just left, not the one we joined.
    arenaRef.current = createArenaRuntime();
    const spawn = game.kind === "arena" ? SPAWN_CELLS[0]! : null;
    playersRef.current.set(selfId, existing ?? {
      id: selfId, name: nameRef.current || "PLAYER",
      x: spawn ? cellCenterX(spawn.col) : WIDTH / 2,
      y: spawn ? cellCenterY(spawn.row) : HEIGHT / 2,
      vx: 0, vy: 0, color, score: 0, crown: game.initialCrown, seen: now,
    });
    if (spawn && existing) {
      // Coming from another room, the carried-over position may be inside a wall.
      existing.x = cellCenterX(spawn.col);
      existing.y = cellCenterY(spawn.row);
      existing.vx = 0;
      existing.vy = 0;
    }
    setConnected(1);

    const room = joinRoom({ appId: APP_ID, relayConfig: { redundancy: 3 } }, `public-${game.id}`);
    const stateAction = room.makeAction<WirePlayer>("player-state");
    const bombAction = room.makeAction<BombEvent>("bomb-v1");
    const npcAction = room.makeAction<NpcSnapshot>("npc-v1");
    sendStateRef.current = (state) => stateAction.send(state);
    sendBombRef.current = (bomb) => bombAction.send(bomb);
    sendNpcsRef.current = (snapshot) => npcAction.send(snapshot);
    stateAction.onMessage = (state, { peerId }) => {
      const receivedAt = Date.now();
      const accepted = receiveRemotePlayer(playersRef.current, remoteMotionsRef.current, state, peerId, receivedAt);
      if (accepted?.ts !== undefined) observeSkew(skewRef.current, peerId, accepted.ts, receivedAt);
    };
    bombAction.onMessage = (payload, { peerId }) => {
      const roomNow = correctedRoomNow(Date.now(), peerSkews(skewRef.current));
      const bomb = sanitizeBombEvent(payload, peerId, roomNow);
      if (bomb) addBomb(arenaRef.current, bomb);
    };
    npcAction.onMessage = (payload, { peerId }) => {
      const npcs = sanitizeNpcSnapshot(payload, peerId);
      if (npcs) receiveNpcSnapshot(arenaRef.current.remoteNpcs, npcs, peerId, Date.now());
    };
    room.onPeerJoin = () => {
      notePeerMet();
      setConnected(Object.keys(room.getPeers()).length + 1);
      broadcastState();
    };
    room.onPeerLeave = (peerId) => {
      playersRef.current.delete(peerId);
      remoteMotionsRef.current.delete(peerId);
      // Enemies exist only while the client running them is here.
      dropNpcsOwnedBy(arenaRef.current.remoteNpcs, peerId);
      setConnected(Object.keys(room.getPeers()).length + 1);
    };

    // See the lobby room for why this is a timer and not the animation frame.
    const stateTimer = window.setInterval(broadcastState, STATE_SEND_MS);
    const npcTimer = game.kind === "arena"
      ? window.setInterval(() => {
        void sendNpcsRef.current?.({ npcs: toWireNpcs(arenaRef.current.npcs), ts: Date.now() });
      }, NPC_SEND_MS)
      : 0;
    const onPageHide = () => { void room.leave(); };
    window.addEventListener("pagehide", onPageHide);

    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.clearInterval(stateTimer);
      if (npcTimer) window.clearInterval(npcTimer);
      sendStateRef.current = null;
      sendBombRef.current = null;
      sendNpcsRef.current = null;
      void room.leave();
    };
  }, [broadcastState, color, connectionEpoch, game]);

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      keysRef.current.add(event.key.toLowerCase());
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(event.key)) event.preventDefault();
      if (event.key === " ") triggerAction();
    };
    const up = (event: KeyboardEvent) => keysRef.current.delete(event.key.toLowerCase());
    window.addEventListener("keydown", down); window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, [triggerAction]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    let frame = 0; let previous = performance.now(); let lastBoard = 0;
    let arenaAccumulator = 0;
    let arenaSnapshot: ArenaSnapshot | null = null;

    const loop = (time: number) => {
      const dt = Math.min((time - previous) / 1000, 0.05); previous = time;
      const now = Date.now();
      const me = playersRef.current.get(selfId);
      if (!me) { frame = requestAnimationFrame(loop); return; }
      const keys = keysRef.current;
      const keyboardX = Number(keys.has("d") || keys.has("arrowright")) - Number(keys.has("a") || keys.has("arrowleft"));
      const keyboardY = Number(keys.has("s") || keys.has("arrowdown")) - Number(keys.has("w") || keys.has("arrowup"));
      const keyboardLength = Math.hypot(keyboardX, keyboardY) || 1;
      const dx = keyboardX ? keyboardX / keyboardLength : stickRef.current.x;
      const dy = keyboardY ? keyboardY / keyboardLength : stickRef.current.y;

      if (game.kind === "arena") {
        const roomNow = correctedRoomNow(now, peerSkews(skewRef.current));
        // Bomb fuses and block regrowth must land on the same tick everywhere,
        // so the arena advances in fixed steps rather than by frame time.
        const paced = advanceFixedSteps(arenaAccumulator, dt * 1000, ARENA_STEP_MS, ARENA_MAX_STEPS);
        arenaAccumulator = paced.accumulator;
        for (let step = 0; step < paced.steps; step += 1) {
          arenaSnapshot = stepArena({
            runtime: arenaRef.current,
            me,
            players: playersRef.current,
            selfId,
            dirX: dx,
            dirY: dy,
            dt: ARENA_STEP_MS / 1000,
            roomNow: roomNow - (paced.steps - 1 - step) * ARENA_STEP_MS,
            playTone,
          });
        }
      } else {
        me.vx += (dx * 310 - me.vx) * Math.min(dt * 9, 1);
        me.vy += (dy * 310 - me.vy) * Math.min(dt * 9, 1);
        if (!dx) me.vx *= Math.pow(0.01, dt); if (!dy) me.vy *= Math.pow(0.01, dt);
        me.x += me.vx * dt; me.y += me.vy * dt;
        game.update?.({
          me,
          players: playersRef.current,
          collected: collectedRef.current,
          now,
          dt,
          selfId,
          playTone,
        });
      }

      smoothRemotePlayers(playersRef.current, remoteMotionsRef.current, selfId, dt, now);
      for (const [id, player] of playersRef.current) if (id !== selfId && now - player.seen > 10_000) {
        playersRef.current.delete(id); remoteMotionsRef.current.delete(id);
      }
      if (time - lastBoard > 300) { lastBoard = time; setScoreboard([...playersRef.current.values()].sort((a, b) => b.score - a.score)); }

      if (game.kind === "arena" && arenaSnapshot) {
        const roomNow = correctedRoomNow(now, peerSkews(skewRef.current));
        drawArena(context, arenaSnapshot, arenaRef.current, roomNow);
        const recent = recentChatMap(chatsRef.current, now);
        for (const player of playersRef.current.values()) {
          // A player waiting to respawn is hidden rather than left standing.
          if (player.id === selfId && roomNow < arenaRef.current.deadUntil) continue;
          drawAvatar(context, player, recent.get(player.id));
        }
        if (roomNow < arenaRef.current.deadUntil) drawDeathOverlay(context, arenaRef.current.deadUntil - roomNow);
      } else {
        drawGame(context, game, [...playersRef.current.values()], collectedRef.current, chatsRef.current, now);
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [game, playTone]);

  return (
    <main className={`play-shell mode-${game.accent} has-chat`}>
      <header className="play-header">
        <button className="back-button" onClick={onLeave}>← ロビーへ</button>
        <div className="play-title"><span>{game.icon}</span><div><strong>{game.title}</strong><small>{game.subtitle}</small></div></div>
        <div className="play-status"><span className="online-dot" /> {connected} PLAYERS <button onClick={onSound} aria-label="サウンド切替">{sound ? "SOUND ON" : "SOUND OFF"}</button></div>
      </header>
      <nav className="occupancy-strip" aria-label="各ゲームの参加人数">
        {PLACES.map((item) => <span className={item.id === game.id ? "active" : ""} key={item.id}><b>{item.shortTitle}</b> {counts[item.id]}</span>)}
      </nav>
      <section className="game-stage">
        <canvas ref={canvasRef} width={WIDTH} height={HEIGHT} aria-label={`${game.title} ゲーム画面`} />
        <aside className="score-panel">
          <p>LIVE SCORE</p>
          {scoreboard.slice(0, 8).map((player, index) => (
            <div className={player.id === selfId ? "is-me" : ""} key={player.id}>
              <b>{index + 1}</b><i style={{ background: player.color }} /><span>{player.name || shortId(player.id)}</span><strong>{Math.floor(player.score)}</strong>
            </div>
          ))}
        </aside>
      </section>
      <MobileController onMove={setStick} onAction={game.action === "bomb" ? triggerAction : undefined} actionLabel={game.actionLabel} />
      <div className="controls-bar"><span><kbd>WASD</kbd><kbd>↑↓←→</kbd> 移動</span>{game.action === "bomb" && <span><kbd>SPACE</kbd> 爆弾を置く</span>}<span><kbd>ENTER</kbd> チャット</span><p>{game.description}</p></div>
    </main>
  );
}

function drawGame(
  context: CanvasRenderingContext2D,
  game: GameDefinition,
  players: Player[],
  collected: Set<string>,
  chats: ChatEntry[],
  now: number,
) {
  context.clearRect(0, 0, WIDTH, HEIGHT);
  context.fillStyle = "#09111d"; context.fillRect(0, 0, WIDTH, HEIGHT);
  context.strokeStyle = "rgba(104,230,193,.08)"; context.lineWidth = 1;
  for (let x = 0; x <= WIDTH; x += 32) { context.beginPath(); context.moveTo(x, 0); context.lineTo(x, HEIGHT); context.stroke(); }
  for (let y = 0; y <= HEIGHT; y += 32) { context.beginPath(); context.moveTo(0, y); context.lineTo(WIDTH, y); context.stroke(); }
  context.strokeStyle = "#233247"; context.lineWidth = 5; context.strokeRect(14, 14, WIDTH - 28, HEIGHT - 28);
  game.draw?.({ context, collected, now });

  const recentChats = recentChatMap(chats, now);
  for (const player of players) drawAvatar(context, player, recentChats.get(player.id));
}

function drawLobby(
  context: CanvasRenderingContext2D,
  players: Player[],
  chats: ChatEntry[],
  counts: Record<PlaceId, number>,
  nearGame: GameId | null,
  now: number,
) {
  context.clearRect(0, 0, WIDTH, HEIGHT);
  context.fillStyle = "#0b1727"; context.fillRect(0, 0, WIDTH, HEIGHT);
  context.strokeStyle = "rgba(108,156,255,.1)"; context.lineWidth = 1;
  for (let x = 0; x <= WIDTH; x += 32) { context.beginPath(); context.moveTo(x, 0); context.lineTo(x, HEIGHT); context.stroke(); }
  for (let y = 0; y <= HEIGHT; y += 32) { context.beginPath(); context.moveTo(0, y); context.lineTo(WIDTH, y); context.stroke(); }
  context.fillStyle = "#111f32"; context.fillRect(80, 70, WIDTH - 160, HEIGHT - 140);
  context.strokeStyle = "#263c58"; context.lineWidth = 4; context.strokeRect(80, 70, WIDTH - 160, HEIGHT - 140);
  context.fillStyle = "rgba(108,156,255,.09)";
  context.beginPath(); context.arc(WIDTH / 2, HEIGHT / 2, 112, 0, Math.PI * 2); context.fill();
  context.strokeStyle = "rgba(108,156,255,.28)"; context.lineWidth = 3; context.stroke();
  context.textAlign = "center";
  context.font = "900 17px monospace"; context.fillStyle = "#6c9cff"; context.fillText("MULTIPLAY PLAZA", WIDTH / 2, HEIGHT / 2 - 8);
  context.font = "700 10px monospace"; context.fillStyle = "#62758f"; context.fillText("WALK TO A GAME GATE", WIDTH / 2, HEIGHT / 2 + 12);

  for (const portal of LOBBY_PORTALS) {
    const game = GAMES.find((item) => item.id === portal.gameId)!;
    const active = nearGame === portal.gameId;
    context.save(); context.translate(portal.x, portal.y);
    context.shadowBlur = active ? 30 : 15; context.shadowColor = portal.color;
    context.fillStyle = active ? portal.color : "#172a40"; context.fillRect(-82, -48, 164, 96);
    context.shadowBlur = 0; context.strokeStyle = portal.color; context.lineWidth = active ? 5 : 3; context.strokeRect(-82, -48, 164, 96);
    context.fillStyle = active ? "#07101d" : portal.color; context.font = "900 28px monospace"; context.fillText(game.icon, 0, -10);
    context.font = "900 13px monospace"; context.fillText(game.title, 0, 17);
    context.font = "800 10px monospace"; context.fillText(`${counts[game.id]} PLAYING`, 0, 35);
    context.restore();
  }
  const recentChats = recentChatMap(chats, now);
  for (const player of players) drawAvatar(context, player, recentChats.get(player.id));
}

function recentChatMap(chats: ChatEntry[], now: number) {
  const recent = new Map<string, ChatEntry>();
  for (const chat of chats) if (!chat.system && now - chat.at < CHAT_VISIBLE_MS) recent.set(chat.authorId, chat);
  return recent;
}

function drawAvatar(context: CanvasRenderingContext2D, player: Player, chat?: ChatEntry) {
  context.save(); context.translate(player.x, player.y);
  if (player.crown) { context.fillStyle = "#f9e547"; context.font = "bold 25px monospace"; context.textAlign = "center"; context.fillText("♛", 0, -50); }
  context.shadowBlur = 16; context.shadowColor = player.color; context.fillStyle = player.color;
  context.beginPath(); context.arc(0, 0, 16, 0, Math.PI * 2); context.fill();
  context.shadowBlur = 0; context.fillStyle = "#09111d"; context.fillRect(-5, -5, 4, 5); context.fillRect(3, -5, 4, 5);
  context.font = "bold 12px monospace"; context.textAlign = "center";
  const displayName = player.name || shortId(player.id);
  const nameWidth = context.measureText(displayName).width + 12;
  context.fillStyle = "rgba(7,16,29,.84)"; context.fillRect(-nameWidth / 2, -38, nameWidth, 17);
  context.fillStyle = "white"; context.fillText(displayName, 0, -25);
  if (chat) {
    const text = chat.text.length > 38 ? `${chat.text.slice(0, 38)}…` : chat.text;
    const bubbleY = player.crown ? -86 : -62;
    context.font = "bold 12px sans-serif";
    const bubbleWidth = Math.min(260, Math.max(74, context.measureText(text).width + 22));
    context.fillStyle = "#edf0e8"; context.fillRect(-bubbleWidth / 2, bubbleY - 18, bubbleWidth, 27);
    context.fillStyle = "#07101d"; context.fillText(text, 0, bubbleY);
    context.beginPath(); context.moveTo(-6, bubbleY + 9); context.lineTo(6, bubbleY + 9); context.lineTo(0, bubbleY + 17); context.fill();
  }
  context.restore();
}
