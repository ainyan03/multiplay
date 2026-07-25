"use client";

import { FormEvent, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { joinRoom, selfId } from "trystero";

type GameId = "gem-sprint" | "crown-chase" | "pulse-push";
type PlaceId = "lobby" | GameId;
type Player = {
  id: string;
  name: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  score: number;
  crown?: boolean;
  seen: number;
};
type WirePlayer = Omit<Player, "seen"> & { seen?: number };
type Pulse = { id: string; x: number; y: number; born: number; owner: string };
type PresencePayload = { name: string; place: PlaceId; at: number };
type ChatPayload = { id: string; name: string; text: string; at: number; place: PlaceId };
type ChatEntry = ChatPayload & { authorId: string; system?: boolean };

const WIDTH = 960;
const HEIGHT = 540;
const COLORS = ["#f9e547", "#ff6b8a", "#68e6c1", "#73a7ff", "#cf83ff", "#ff9d4d"];
const APP_ID = "ainyan-multiplay-arcade-v2";
const CHAT_VISIBLE_MS = 6_000;
const LOBBY_PORTALS: Array<{ gameId: GameId; x: number; y: number; color: string }> = [
  { gameId: "gem-sprint", x: 180, y: 145, color: "#f9e547" },
  { gameId: "crown-chase", x: 780, y: 145, color: "#ff6082" },
  { gameId: "pulse-push", x: 480, y: 430, color: "#5fe0c0" },
];

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

const GAMES: Array<{
  id: GameId;
  icon: string;
  title: string;
  shortTitle: string;
  subtitle: string;
  description: string;
  players: string;
  accent: string;
}> = [
  {
    id: "gem-sprint",
    icon: "◆",
    title: "GEM SPRINT",
    shortTitle: "GEMS",
    subtitle: "みんなで宝石ダッシュ",
    description: "フィールドを駆け回って光る宝石を集めよう。60秒でいちばん集めた人の勝ち。",
    players: "2–16人",
    accent: "yellow",
  },
  {
    id: "crown-chase",
    icon: "♛",
    title: "CROWN CHASE",
    shortTitle: "CROWN",
    subtitle: "王冠おにごっこ",
    description: "王冠を持つ相手にタッチ！ 持っている時間だけ得点が増える、逆転だらけのおにごっこ。",
    players: "2–12人",
    accent: "pink",
  },
  {
    id: "pulse-push",
    icon: "◎",
    title: "PULSE PUSH",
    shortTitle: "PULSE",
    subtitle: "はじき出しバトル",
    description: "パルスでライバルを押し出せ。落ちてもすぐ復帰できる、にぎやかなサバイバル。",
    players: "2–8人",
    accent: "cyan",
  },
];

const PLACES = [LOBBY, ...GAMES];

function isPlaceId(value: unknown): value is PlaceId {
  return value === "lobby" || GAMES.some((game) => game.id === value);
}

function shortId(id: string) {
  return id.slice(0, 5).toUpperCase();
}

function hash(seed: number) {
  const x = Math.sin(seed * 999.91) * 43758.5453;
  return x - Math.floor(x);
}

function gems(now: number) {
  const phase = Math.floor(now / 9000);
  return Array.from({ length: 18 }, (_, i) => ({
    id: `${phase}:${i}`,
    x: 70 + hash(phase * 47 + i * 3) * (WIDTH - 140),
    y: 70 + hash(phase * 53 + i * 7) * (HEIGHT - 140),
  }));
}

function useCommunity(name: string, place: PlaceId) {
  const [presence, setPresence] = useState<Map<string, PresencePayload>>(() => new Map());
  const [chats, setChats] = useState<ChatEntry[]>(() => [{
    id: "welcome",
    authorId: "system",
    name: "SYSTEM",
    text: "MULTIPLAYへようこそ。ロビーもひとつの遊び場です。",
    at: Date.now(),
    place: "lobby",
    system: true,
  }]);
  const sendPresenceRef = useRef<((payload: PresencePayload) => Promise<void>) | null>(null);
  const sendChatRef = useRef<((payload: ChatPayload) => Promise<void>) | null>(null);
  const identityRef = useRef({ name, place });

  const publishPresence = useCallback(() => {
    const payload: PresencePayload = {
      name: identityRef.current.name || "PLAYER",
      place: identityRef.current.place,
      at: Date.now(),
    };
    setPresence((current) => new Map(current).set(selfId, payload));
    void sendPresenceRef.current?.(payload);
  }, []);

  useEffect(() => {
    identityRef.current = { name, place };
    publishPresence();
  }, [name, place, publishPresence]);

  useEffect(() => {
    const room = joinRoom({ appId: APP_ID, relayConfig: { redundancy: 3 } }, "community-hub");
    const presenceAction = room.makeAction<PresencePayload>("presence-v1");
    const chatAction = room.makeAction<ChatPayload>("chat-v1");
    sendPresenceRef.current = (payload) => presenceAction.send(payload);
    sendChatRef.current = (payload) => chatAction.send(payload);

    presenceAction.onMessage = (payload, { peerId }) => {
      if (!payload || typeof payload.name !== "string" || !isPlaceId(payload.place)) return;
      setPresence((current) => new Map(current).set(peerId, {
        name: payload.name.slice(0, 14),
        place: payload.place,
        at: Date.now(),
      }));
    };
    chatAction.onMessage = (payload, { peerId }) => {
      if (!payload || typeof payload.text !== "string" || !isPlaceId(payload.place)) return;
      const entry: ChatEntry = {
        ...payload,
        authorId: peerId,
        name: payload.name.slice(0, 14),
        text: payload.text.trim().slice(0, 180),
        at: Date.now(),
      };
      if (!entry.text) return;
      setChats((current) => current.some((item) => item.id === entry.id) ? current : [...current, entry].slice(-80));
    };
    room.onPeerJoin = () => publishPresence();
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

    return () => {
      window.clearInterval(presenceTimer);
      window.clearInterval(cleanupTimer);
      sendPresenceRef.current = null;
      sendChatRef.current = null;
      void room.leave();
    };
  }, [publishPresence]);

  const sendChat = useCallback((rawText: string) => {
    const text = rawText.trim().slice(0, 180);
    if (!text) return;
    const payload: ChatPayload = {
      id: `${selfId}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
      name: identityRef.current.name || "PLAYER",
      text,
      at: Date.now(),
      place: identityRef.current.place,
    };
    setChats((current) => [...current, { ...payload, authorId: selfId }].slice(-80));
    void sendChatRef.current?.(payload);
  }, []);

  const counts = useMemo(() => {
    const result: Record<PlaceId, number> = { lobby: 0, "gem-sprint": 0, "crown-chase": 0, "pulse-push": 0 };
    for (const item of presence.values()) result[item.place] += 1;
    return result;
  }, [presence]);

  return { chats, counts, sendChat };
}

export function Arcade() {
  const [gameId, setGameId] = useState<GameId | null>(null);
  const [name, setName] = useState(() => `PLAYER-${Math.floor(100 + Math.random() * 900)}`);
  const [sound, setSound] = useState(true);
  const place: PlaceId = gameId ?? "lobby";
  const community = useCommunity(name, place);
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
          onSound={() => setSound((value) => !value)}
          onLeave={() => setGameId(null)}
        />
      ) : (
        <LobbyScreen name={name} chats={community.chats} counts={community.counts} onName={setName} onJoin={setGameId} />
      )}
      <ChatPanel chats={community.chats} place={place} onSend={community.sendChat} />
    </>
  );
}

function LobbyScreen({ name, chats, counts, onName, onJoin }: {
  name: string;
  chats: ChatEntry[];
  counts: Record<PlaceId, number>;
  onName: (name: string) => void;
  onJoin: (id: GameId) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playersRef = useRef<Map<string, Player>>(new Map());
  const keysRef = useRef(new Set<string>());
  const sendStateRef = useRef<((state: WirePlayer) => Promise<void>) | null>(null);
  const chatsRef = useRef(chats);
  const countsRef = useRef(counts);
  const nearGameRef = useRef<GameId | null>(null);
  const [nearGame, setNearGame] = useState<GameId | null>(null);
  const [connected, setConnected] = useState(1);
  const color = useMemo(() => COLORS[Math.floor(Math.random() * COLORS.length)], []);

  useEffect(() => { chatsRef.current = chats; }, [chats]);
  useEffect(() => { countsRef.current = counts; }, [counts]);
  useEffect(() => {
    const me = playersRef.current.get(selfId);
    if (me) me.name = name || "PLAYER";
  }, [name]);

  const setTouchKey = useCallback((key: string, pressed: boolean) => {
    if (pressed) keysRef.current.add(key);
    else keysRef.current.delete(key);
  }, []);
  const enterPortal = useCallback(() => {
    if (nearGameRef.current) onJoin(nearGameRef.current);
  }, [onJoin]);

  useEffect(() => {
    playersRef.current.set(selfId, {
      id: selfId, name: name || "PLAYER", x: WIDTH / 2, y: HEIGHT / 2,
      vx: 0, vy: 0, color, score: 0, seen: Date.now(),
    });
    const room = joinRoom({ appId: APP_ID, relayConfig: { redundancy: 3 } }, "public-lobby");
    const stateAction = room.makeAction<WirePlayer>("player-state");
    sendStateRef.current = (state) => stateAction.send(state);
    stateAction.onMessage = (state, { peerId }) => {
      if (!state || typeof state.x !== "number" || typeof state.y !== "number") return;
      playersRef.current.set(peerId, { ...state, id: peerId, seen: Date.now() });
    };
    room.onPeerJoin = () => setConnected(Object.keys(room.getPeers()).length + 1);
    room.onPeerLeave = (peerId) => {
      playersRef.current.delete(peerId);
      setConnected(Object.keys(room.getPeers()).length + 1);
    };
    return () => {
      sendStateRef.current = null;
      void room.leave();
      playersRef.current.clear();
    };
  }, [color]);

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
    let frame = 0; let previous = performance.now(); let lastSend = 0;
    const loop = (time: number) => {
      const dt = Math.min((time - previous) / 1000, .05); previous = time;
      const now = Date.now();
      const me = playersRef.current.get(selfId);
      if (!me) { frame = requestAnimationFrame(loop); return; }
      const keys = keysRef.current;
      const dx = Number(keys.has("d") || keys.has("arrowright")) - Number(keys.has("a") || keys.has("arrowleft"));
      const dy = Number(keys.has("s") || keys.has("arrowdown")) - Number(keys.has("w") || keys.has("arrowup"));
      const length = Math.hypot(dx, dy) || 1;
      me.vx += (dx / length * 285 - me.vx) * Math.min(dt * 9, 1);
      me.vy += (dy / length * 285 - me.vy) * Math.min(dt * 9, 1);
      if (!dx) me.vx *= Math.pow(.01, dt); if (!dy) me.vy *= Math.pow(.01, dt);
      me.x = Math.max(25, Math.min(WIDTH - 25, me.x + me.vx * dt));
      me.y = Math.max(28, Math.min(HEIGHT - 28, me.y + me.vy * dt));
      const closest = LOBBY_PORTALS.find((portal) => Math.hypot(me.x - portal.x, me.y - portal.y) < 76)?.gameId ?? null;
      if (closest !== nearGameRef.current) { nearGameRef.current = closest; setNearGame(closest); }
      if (time - lastSend > 66) {
        lastSend = time; me.seen = now;
        const { seen: _seen, ...wire } = me; void _seen;
        void sendStateRef.current?.(wire);
      }
      for (const [id, player] of playersRef.current) if (id !== selfId && now - player.seen > 10_000) playersRef.current.delete(id);
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
        <label className="lobby-name" htmlFor="player-name"><span>PLAYER</span><input id="player-name" maxLength={14} value={name} onChange={(event) => onName(event.target.value.toUpperCase())} /></label>
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
      <MobileController onDirection={setTouchKey} onAction={nearGame ? enterPortal : undefined} actionLabel="A" />
      <div className="controls-bar lobby-controls"><span><kbd>WASD</kbd><kbd>↑↓←→</kbd> 移動</span><span><kbd>SPACE</kbd> 入口に入る</span><p>マップ上の入口に近づくと、参加中の人数とゲーム名を確認できます。</p></div>
    </main>
  );
}

function ChatPanel({ chats, place, onSend }: { chats: ChatEntry[]; place: PlaceId; onSend: (text: string) => void }) {
  type ChatSize = "collapsed" | "compact" | "expanded";
  const [draft, setDraft] = useState("");
  const [size, setSize] = useState<ChatSize>(() => window.matchMedia("(max-width: 600px)").matches ? "collapsed" : "compact");
  const [unread, setUnread] = useState(0);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const previousCountRef = useRef(chats.length);
  const atBottomRef = useRef(true);

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
    if (!window.matchMedia("(max-width: 600px)").matches) return;
    setSize(place === "lobby" ? "compact" : "collapsed");
  }, [place]);

  useEffect(() => {
    if (size === "collapsed") return;
    const log = logRef.current;
    if (log && atBottomRef.current) log.scrollTop = log.scrollHeight;
  }, [size]);

  useEffect(() => {
    const focusChat = () => {
      flushSync(() => setSize("compact"));
      inputRef.current?.focus({ preventScroll: true });
    };
    window.addEventListener("multiplay:chat-focus", focusChat);
    return () => {
      window.removeEventListener("multiplay:chat-focus", focusChat);
      document.documentElement.classList.remove("chat-input-focused");
    };
  }, []);

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

  const openChat = () => {
    setSize("compact");
    setUnread(0);
  };

  const latest = [...chats].reverse().find((chat) => !chat.system);

  return (
    <aside className={`chat-panel ${size}`} aria-label="全体チャット">
      <header>
        <button className="chat-heading" type="button" onClick={size === "collapsed" ? openChat : undefined} aria-expanded={size !== "collapsed"}>
          <span className="online-dot" /><strong>GLOBAL CHAT</strong>
          {size === "collapsed" && latest && <em><b>{latest.name}</b> {latest.text}</em>}
          {unread > 0 && <i className="unread-badge">{unread > 99 ? "99+" : unread}</i>}
        </button>
        <div className="chat-tools">
          <small>{PLACES.find((item) => item.id === place)?.shortTitle}</small>
          {size !== "collapsed" && <button type="button" onClick={() => setSize(size === "expanded" ? "compact" : "expanded")} aria-label={size === "expanded" ? "チャットを通常サイズに戻す" : "チャットを拡大する"}>{size === "expanded" ? "↙" : "↗"}</button>}
          <button type="button" onClick={() => setSize(size === "collapsed" ? "compact" : "collapsed")} aria-label={size === "collapsed" ? "チャットを開く" : "チャットを最小化する"}>{size === "collapsed" ? "+" : "−"}</button>
        </div>
      </header>
      <div className="chat-log" ref={logRef} onScroll={handleScroll} aria-live="polite">
        {chats.map((chat) => (
          <div className={`chat-message ${chat.system ? "system" : chat.authorId === selfId ? "own" : "other"}`} key={chat.id}>
            <p><b>{chat.name}</b><small>{PLACES.find((item) => item.id === chat.place)?.shortTitle}</small></p>
            <span>{chat.text}</span>
          </div>
        ))}
      </div>
      <form onSubmit={submit}>
        <textarea
          ref={inputRef}
          aria-label="チャットメッセージ"
          enterKeyHint="send"
          inputMode="text"
          maxLength={180}
          placeholder="メッセージを入力…"
          rows={1}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={() => {
            document.documentElement.classList.add("chat-input-focused");
            if (size === "collapsed") setSize("compact");
            requestAnimationFrame(() => inputRef.current?.scrollIntoView({ block: "nearest" }));
          }}
          onBlur={() => document.documentElement.classList.remove("chat-input-focused")}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              sendDraft();
            }
          }}
        />
        <button aria-label="送信" type="submit">SEND</button>
      </form>
    </aside>
  );
}

function MobileController({ onDirection, onAction, actionLabel }: {
  onDirection: (key: string, pressed: boolean) => void;
  onAction?: () => void;
  actionLabel: string;
}) {
  const directionProps = (key: string) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => { event.currentTarget.setPointerCapture(event.pointerId); onDirection(key, true); },
    onPointerUp: () => onDirection(key, false),
    onPointerCancel: () => onDirection(key, false),
    onLostPointerCapture: () => onDirection(key, false),
  });
  return (
    <div className="mobile-controller" aria-label="スマートフォン用仮想コントローラ">
      <div className="controller-dpad">
        <button className="up" aria-label="上へ移動" {...directionProps("arrowup")}>▲</button>
        <button className="left" aria-label="左へ移動" {...directionProps("arrowleft")}>◀</button>
        <button className="down" aria-label="下へ移動" {...directionProps("arrowdown")}>▼</button>
        <button className="right" aria-label="右へ移動" {...directionProps("arrowright")}>▶</button>
      </div>
      <div className="controller-actions">
        <button className="chat-action" type="button" onPointerDown={() => window.dispatchEvent(new Event("multiplay:chat-focus"))}>CHAT</button>
        <button className="primary-action" type="button" disabled={!onAction} onPointerDown={onAction}>{actionLabel}</button>
      </div>
    </div>
  );
}

function GameScreen({ game, name, sound, chats, counts, onSound, onLeave }: {
  game: (typeof GAMES)[number];
  name: string;
  sound: boolean;
  chats: ChatEntry[];
  counts: Record<PlaceId, number>;
  onSound: () => void;
  onLeave: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playersRef = useRef<Map<string, Player>>(new Map());
  const pulsesRef = useRef<Pulse[]>([]);
  const keysRef = useRef(new Set<string>());
  const sendStateRef = useRef<((state: WirePlayer) => Promise<void>) | null>(null);
  const sendPulseRef = useRef<((pulse: Pulse) => Promise<void>) | null>(null);
  const collectedRef = useRef(new Set<string>());
  const chatsRef = useRef(chats);
  const [connected, setConnected] = useState(1);
  const [scoreboard, setScoreboard] = useState<Player[]>([]);
  const color = useMemo(() => COLORS[Math.floor(Math.random() * COLORS.length)], []);

  useEffect(() => { chatsRef.current = chats; }, [chats]);

  const playTone = useCallback((frequency: number) => {
    if (!sound) return;
    const AudioCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const context = new AudioCtor();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "square";
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.045, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.09);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(); oscillator.stop(context.currentTime + 0.1);
  }, [sound]);

  const triggerPulse = useCallback(() => {
    if (game.id !== "pulse-push") return;
    const me = playersRef.current.get(selfId);
    if (!me) return;
    const pulse = { id: `${selfId}:${Date.now()}`, x: me.x, y: me.y, born: Date.now(), owner: selfId };
    pulsesRef.current.push(pulse);
    void sendPulseRef.current?.(pulse);
    playTone(120);
  }, [game.id, playTone]);

  const setTouchKey = (key: string, pressed: boolean) => {
    if (pressed) keysRef.current.add(key);
    else keysRef.current.delete(key);
  };

  useEffect(() => {
    const now = Date.now();
    playersRef.current.set(selfId, {
      id: selfId, name: name || "PLAYER", x: WIDTH / 2, y: HEIGHT / 2,
      vx: 0, vy: 0, color, score: 0, crown: game.id === "crown-chase", seen: now,
    });

    const room = joinRoom({ appId: APP_ID, relayConfig: { redundancy: 3 } }, `public-${game.id}`);
    const stateAction = room.makeAction<WirePlayer>("player-state");
    const pulseAction = room.makeAction<Pulse>("pulse");
    sendStateRef.current = (state) => stateAction.send(state);
    sendPulseRef.current = (pulse) => pulseAction.send(pulse);
    stateAction.onMessage = (state, { peerId }) => {
      if (!state || typeof state.x !== "number" || typeof state.y !== "number") return;
      playersRef.current.set(peerId, { ...state, id: peerId, seen: Date.now() });
    };
    pulseAction.onMessage = (pulse) => {
      if (pulse && typeof pulse.x === "number") pulsesRef.current.push(pulse);
    };
    room.onPeerJoin = () => setConnected(Object.keys(room.getPeers()).length + 1);
    room.onPeerLeave = (peerId) => {
      playersRef.current.delete(peerId);
      setConnected(Object.keys(room.getPeers()).length + 1);
    };
    return () => {
      sendStateRef.current = null;
      sendPulseRef.current = null;
      void room.leave();
      playersRef.current.clear();
    };
  }, [color, game.id, name]);

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      keysRef.current.add(event.key.toLowerCase());
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(event.key)) event.preventDefault();
      if (event.key === " ") triggerPulse();
    };
    const up = (event: KeyboardEvent) => keysRef.current.delete(event.key.toLowerCase());
    window.addEventListener("keydown", down); window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, [triggerPulse]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    let frame = 0; let previous = performance.now(); let lastSend = 0; let lastBoard = 0;

    const loop = (time: number) => {
      const dt = Math.min((time - previous) / 1000, 0.05); previous = time;
      const now = Date.now();
      const me = playersRef.current.get(selfId);
      if (!me) { frame = requestAnimationFrame(loop); return; }
      const keys = keysRef.current;
      const dx = Number(keys.has("d") || keys.has("arrowright")) - Number(keys.has("a") || keys.has("arrowleft"));
      const dy = Number(keys.has("s") || keys.has("arrowdown")) - Number(keys.has("w") || keys.has("arrowup"));
      const length = Math.hypot(dx, dy) || 1;
      me.vx += (dx / length * 310 - me.vx) * Math.min(dt * 9, 1);
      me.vy += (dy / length * 310 - me.vy) * Math.min(dt * 9, 1);
      if (!dx) me.vx *= Math.pow(0.01, dt); if (!dy) me.vy *= Math.pow(0.01, dt);
      me.x += me.vx * dt; me.y += me.vy * dt;

      if (game.id === "pulse-push") {
        const outside = me.x < 25 || me.x > WIDTH - 25 || me.y < 25 || me.y > HEIGHT - 25;
        if (outside) { me.x = WIDTH / 2; me.y = HEIGHT / 2; me.vx = me.vy = 0; me.score = Math.max(0, me.score - 1); playTone(70); }
      } else {
        me.x = Math.max(24, Math.min(WIDTH - 24, me.x)); me.y = Math.max(24, Math.min(HEIGHT - 24, me.y));
      }

      if (game.id === "gem-sprint") {
        for (const gem of gems(now)) {
          if (!collectedRef.current.has(gem.id) && Math.hypot(me.x - gem.x, me.y - gem.y) < 28) {
            collectedRef.current.add(gem.id); me.score += 1; playTone(640 + me.score * 10);
          }
        }
      }
      if (game.id === "crown-chase") {
        const living = [...playersRef.current.values()].filter((player) => now - player.seen < 8_000);
        const crowned = living.find((player) => player.crown) ?? living.sort((a, b) => a.id.localeCompare(b.id))[0];
        me.crown = crowned?.id === me.id;
        if (me.crown) me.score += dt * 4;
        for (const player of living) {
          if (player.id !== me.id && player.crown && Math.hypot(me.x - player.x, me.y - player.y) < 34) {
            me.crown = true; player.crown = false; playTone(880);
          }
        }
      }
      pulsesRef.current = pulsesRef.current.filter((pulse) => now - pulse.born < 750);
      if (game.id === "pulse-push") {
        for (const pulse of pulsesRef.current) {
          if (pulse.owner === selfId) continue;
          const age = now - pulse.born; const radius = 25 + age * 0.32;
          const distance = Math.hypot(me.x - pulse.x, me.y - pulse.y);
          if (distance > radius - 18 && distance < radius + 18) {
            me.vx += (me.x - pulse.x) / Math.max(distance, 1) * 18;
            me.vy += (me.y - pulse.y) / Math.max(distance, 1) * 18;
          }
        }
        me.score += dt;
      }

      if (time - lastSend > 66) {
        lastSend = time; me.seen = now;
        const { seen: _seen, ...wire } = me; void _seen;
        void sendStateRef.current?.(wire);
      }
      for (const [id, player] of playersRef.current) if (id !== selfId && now - player.seen > 10_000) playersRef.current.delete(id);
      if (time - lastBoard > 300) { lastBoard = time; setScoreboard([...playersRef.current.values()].sort((a, b) => b.score - a.score)); }

      drawGame(context, game.id, [...playersRef.current.values()], pulsesRef.current, collectedRef.current, chatsRef.current, now);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [game.id, playTone]);

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
      <MobileController onDirection={setTouchKey} onAction={game.id === "pulse-push" ? triggerPulse : undefined} actionLabel={game.id === "pulse-push" ? "PULSE" : "A"} />
      <div className="controls-bar"><span><kbd>WASD</kbd><kbd>↑↓←→</kbd> 移動</span>{game.id === "pulse-push" && <span><kbd>SPACE</kbd> パルス</span>}<p>{game.description}</p></div>
    </main>
  );
}

function drawGame(
  context: CanvasRenderingContext2D,
  gameId: GameId,
  players: Player[],
  pulses: Pulse[],
  collected: Set<string>,
  chats: ChatEntry[],
  now: number,
) {
  context.clearRect(0, 0, WIDTH, HEIGHT);
  context.fillStyle = "#09111d"; context.fillRect(0, 0, WIDTH, HEIGHT);
  context.strokeStyle = "rgba(104,230,193,.08)"; context.lineWidth = 1;
  for (let x = 0; x <= WIDTH; x += 32) { context.beginPath(); context.moveTo(x, 0); context.lineTo(x, HEIGHT); context.stroke(); }
  for (let y = 0; y <= HEIGHT; y += 32) { context.beginPath(); context.moveTo(0, y); context.lineTo(WIDTH, y); context.stroke(); }
  context.strokeStyle = gameId === "pulse-push" ? "#ff6b8a" : "#233247"; context.lineWidth = 5; context.strokeRect(14, 14, WIDTH - 28, HEIGHT - 28);

  if (gameId === "gem-sprint") for (const gem of gems(now)) if (!collected.has(gem.id)) {
    const pulse = 1 + Math.sin(now / 180 + gem.x) * .12;
    context.save(); context.translate(gem.x, gem.y); context.scale(pulse, pulse); context.rotate(Math.PI / 4);
    context.shadowBlur = 18; context.shadowColor = "#f9e547"; context.fillStyle = "#f9e547"; context.fillRect(-9, -9, 18, 18); context.restore();
  }
  for (const pulse of pulses) {
    const radius = 25 + (now - pulse.born) * .32;
    context.beginPath(); context.arc(pulse.x, pulse.y, radius, 0, Math.PI * 2);
    context.strokeStyle = `rgba(255,107,138,${Math.max(0, 1 - (now - pulse.born) / 750)})`; context.lineWidth = 10; context.stroke();
  }

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
