"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { joinRoom, selfId, type Room } from "trystero";

type GameId = "gem-sprint" | "crown-chase" | "pulse-push";
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

const WIDTH = 960;
const HEIGHT = 540;
const COLORS = ["#f9e547", "#ff6b8a", "#68e6c1", "#73a7ff", "#cf83ff", "#ff9d4d"];
const APP_ID = "ainyan-multiplay-arcade-v1";

const GAMES: Array<{
  id: GameId;
  icon: string;
  title: string;
  subtitle: string;
  description: string;
  players: string;
  accent: string;
}> = [
  {
    id: "gem-sprint",
    icon: "◆",
    title: "GEM SPRINT",
    subtitle: "みんなで宝石ダッシュ",
    description: "フィールドを駆け回って光る宝石を集めよう。60秒でいちばん集めた人の勝ち。",
    players: "2–16人",
    accent: "yellow",
  },
  {
    id: "crown-chase",
    icon: "♛",
    title: "CROWN CHASE",
    subtitle: "王冠おにごっこ",
    description: "王冠を持つ相手にタッチ！ 持っている時間だけ得点が増える、逆転だらけのおにごっこ。",
    players: "2–12人",
    accent: "pink",
  },
  {
    id: "pulse-push",
    icon: "◎",
    title: "PULSE PUSH",
    subtitle: "はじき出しバトル",
    description: "パルスでライバルを押し出せ。落ちてもすぐ復帰できる、にぎやかなサバイバル。",
    players: "2–8人",
    accent: "cyan",
  },
];

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

export function Arcade() {
  const [gameId, setGameId] = useState<GameId | null>(null);
  const [name, setName] = useState(() => `PLAYER-${Math.floor(100 + Math.random() * 900)}`);
  const [sound, setSound] = useState(true);
  const selected = GAMES.find((game) => game.id === gameId);

  useEffect(() => {
    const saved = window.localStorage.getItem("multiplay-name");
    if (saved) setName(saved);
  }, []);

  useEffect(() => {
    window.localStorage.setItem("multiplay-name", name);
  }, [name]);

  if (selected) {
    return (
      <GameScreen
        game={selected}
        name={name}
        sound={sound}
        onSound={() => setSound((value) => !value)}
        onLeave={() => setGameId(null)}
      />
    );
  }

  return (
    <main className="lobby-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <div><strong>MULTIPLAY</strong><small>ONLINE ARCADE</small></div>
        </div>
        <div className="online-pill"><span /> P2P ONLINE</div>
      </header>

      <section className="hero">
        <p className="eyebrow">DROP IN. PLAY TOGETHER.</p>
        <h1>あつまれば、<br /><em>すぐゲーム。</em></h1>
        <p className="lead">登録も待ち時間もなし。好きなゲームを選んだら、<br />世界のどこかのプレイヤーとその場でつながります。</p>
      </section>

      <section className="player-name" aria-label="プレイヤー設定">
        <label htmlFor="player-name">YOUR NAME</label>
        <input id="player-name" maxLength={14} value={name} onChange={(event) => setName(event.target.value.toUpperCase())} />
        <span>名前はこの端末だけに保存されます</span>
      </section>

      <section className="game-section">
        <div className="section-title"><h2>CHOOSE A GAME</h2><span>3 GAMES AVAILABLE</span></div>
        <div className="game-grid">
          {GAMES.map((game, index) => (
            <article className={`game-card ${game.accent}`} key={game.id}>
              <div className="card-topline"><span>0{index + 1}</span><b>{game.players}</b></div>
              <div className="game-icon" aria-hidden="true">{game.icon}</div>
              <p>{game.subtitle}</p>
              <h3>{game.title}</h3>
              <div className="pixel-rule" />
              <p className="description">{game.description}</p>
              <button onClick={() => setGameId(game.id)}>このゲームに参加 <span>→</span></button>
            </article>
          ))}
        </div>
      </section>

      <footer><span>WEBRTC / SERVERLESS</span><p>ゲーム中でも、いつでも参加・退出できます。</p><span>V0.1 PROTOTYPE</span></footer>
    </main>
  );
}

function GameScreen({ game, name, sound, onSound, onLeave }: {
  game: (typeof GAMES)[number]; name: string; sound: boolean; onSound: () => void; onLeave: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playersRef = useRef<Map<string, Player>>(new Map());
  const pulsesRef = useRef<Pulse[]>([]);
  const keysRef = useRef(new Set<string>());
  const roomRef = useRef<Room | null>(null);
  const sendStateRef = useRef<((state: WirePlayer) => Promise<void>) | null>(null);
  const sendPulseRef = useRef<((pulse: Pulse) => Promise<void>) | null>(null);
  const collectedRef = useRef(new Set<string>());
  const [connected, setConnected] = useState(1);
  const [scoreboard, setScoreboard] = useState<Player[]>([]);
  const color = useMemo(() => COLORS[Math.floor(Math.random() * COLORS.length)], []);

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

  useEffect(() => {
    const now = Date.now();
    playersRef.current.set(selfId, {
      id: selfId, name: name || "PLAYER", x: WIDTH / 2, y: HEIGHT / 2,
      vx: 0, vy: 0, color, score: 0, crown: game.id === "crown-chase", seen: now,
    });

    const room = joinRoom({ appId: APP_ID, relayConfig: { redundancy: 3 } }, `public-${game.id}`);
    roomRef.current = room;
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
      room.leave();
      roomRef.current = null;
      playersRef.current.clear();
    };
  }, [color, game.id, name]);

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      keysRef.current.add(event.key.toLowerCase());
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(event.key)) event.preventDefault();
      if (event.key === " " && game.id === "pulse-push") {
        const me = playersRef.current.get(selfId);
        if (!me) return;
        const pulse = { id: `${selfId}:${Date.now()}`, x: me.x, y: me.y, born: Date.now(), owner: selfId };
        pulsesRef.current.push(pulse); sendPulseRef.current?.(pulse); playTone(120);
      }
    };
    const up = (event: KeyboardEvent) => keysRef.current.delete(event.key.toLowerCase());
    window.addEventListener("keydown", down); window.addEventListener("keyup", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); };
  }, [game.id, playTone]);

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
        const living = [...playersRef.current.values()].filter((player) => now - player.seen < 8000);
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
        sendStateRef.current?.(wire);
      }
      for (const [id, player] of playersRef.current) if (id !== selfId && now - player.seen > 10000) playersRef.current.delete(id);
      if (time - lastBoard > 300) { lastBoard = time; setScoreboard([...playersRef.current.values()].sort((a, b) => b.score - a.score)); }

      drawGame(context, game.id, [...playersRef.current.values()], pulsesRef.current, collectedRef.current, now);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [game.id, playTone]);

  return (
    <main className={`play-shell mode-${game.accent}`}>
      <header className="play-header">
        <button className="back-button" onClick={onLeave}>← ロビーへ</button>
        <div className="play-title"><span>{game.icon}</span><div><strong>{game.title}</strong><small>{game.subtitle}</small></div></div>
        <div className="play-status"><span className="online-dot" /> {connected} PLAYERS <button onClick={onSound} aria-label="サウンド切替">{sound ? "SOUND ON" : "SOUND OFF"}</button></div>
      </header>
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
      <div className="controls-bar"><span><kbd>WASD</kbd><kbd>↑↓←→</kbd> 移動</span>{game.id === "pulse-push" && <span><kbd>SPACE</kbd> パルス</span>}<p>{game.description}</p></div>
    </main>
  );
}

function drawGame(context: CanvasRenderingContext2D, gameId: GameId, players: Player[], pulses: Pulse[], collected: Set<string>, now: number) {
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
  for (const player of players) {
    context.save(); context.translate(player.x, player.y);
    if (player.crown) { context.fillStyle = "#f9e547"; context.font = "bold 25px monospace"; context.textAlign = "center"; context.fillText("♛", 0, -27); }
    context.shadowBlur = 16; context.shadowColor = player.color; context.fillStyle = player.color;
    context.beginPath(); context.arc(0, 0, 16, 0, Math.PI * 2); context.fill();
    context.shadowBlur = 0; context.fillStyle = "#09111d"; context.fillRect(-5, -5, 4, 5); context.fillRect(3, -5, 4, 5);
    context.fillStyle = "white"; context.font = "bold 12px monospace"; context.textAlign = "center"; context.fillText(player.name, 0, 35);
    context.restore();
  }
}
