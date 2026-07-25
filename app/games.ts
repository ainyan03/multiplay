export type GameId = "gem-sprint" | "crown-chase" | "pulse-push";

export type PlayerState = {
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

export type PulseState = { id: string; x: number; y: number; born: number; owner: string };

export const GAME_WIDTH = 960;
export const GAME_HEIGHT = 540;

export type GameUpdateContext = {
  me: PlayerState;
  players: Map<string, PlayerState>;
  pulses: PulseState[];
  collected: Set<string>;
  now: number;
  dt: number;
  selfId: string;
  playTone: (frequency: number) => void;
};

export type GameDrawContext = {
  context: CanvasRenderingContext2D;
  pulses: PulseState[];
  collected: Set<string>;
  now: number;
};

export type GameDefinition = {
  id: GameId;
  icon: string;
  title: string;
  shortTitle: string;
  subtitle: string;
  description: string;
  players: string;
  accent: string;
  action?: "pulse";
  actionLabel: string;
  initialCrown?: boolean;
  update: (state: GameUpdateContext) => void;
  draw: (state: GameDrawContext) => void;
};

function hash(seed: number) {
  const x = Math.sin(seed * 999.91) * 43758.5453;
  return x - Math.floor(x);
}

export function gems(now: number) {
  const phase = Math.floor(now / 9000);
  return Array.from({ length: 18 }, (_, i) => ({
    id: `${phase}:${i}`,
    x: 70 + hash(phase * 47 + i * 3) * (GAME_WIDTH - 140),
    y: 70 + hash(phase * 53 + i * 7) * (GAME_HEIGHT - 140),
  }));
}

function keepInsideField(me: PlayerState) {
  me.x = Math.max(24, Math.min(GAME_WIDTH - 24, me.x));
  me.y = Math.max(24, Math.min(GAME_HEIGHT - 24, me.y));
}

function drawGems({ context, collected, now }: GameDrawContext) {
  for (const gem of gems(now)) {
    if (collected.has(gem.id)) continue;
    const pulse = 1 + Math.sin(now / 180 + gem.x) * .12;
    context.save();
    context.translate(gem.x, gem.y);
    context.scale(pulse, pulse);
    context.rotate(Math.PI / 4);
    context.shadowBlur = 18;
    context.shadowColor = "#f9e547";
    context.fillStyle = "#f9e547";
    context.fillRect(-9, -9, 18, 18);
    context.restore();
  }
}

function drawPulses({ context, pulses, now }: GameDrawContext) {
  for (const pulse of pulses) {
    const radius = 25 + (now - pulse.born) * .32;
    context.beginPath();
    context.arc(pulse.x, pulse.y, radius, 0, Math.PI * 2);
    context.strokeStyle = `rgba(255,107,138,${Math.max(0, 1 - (now - pulse.born) / 750)})`;
    context.lineWidth = 10;
    context.stroke();
  }
}

export const GAME_DEFINITIONS: GameDefinition[] = [
  {
    id: "gem-sprint",
    icon: "◆",
    title: "GEM SPRINT",
    shortTitle: "GEMS",
    subtitle: "みんなで宝石ダッシュ",
    description: "フィールドを駆け回って光る宝石を集めよう。60秒でいちばん集めた人の勝ち。",
    players: "2–16人",
    accent: "yellow",
    actionLabel: "A",
    update: ({ me, collected, now, playTone }) => {
      keepInsideField(me);
      for (const gem of gems(now)) {
        if (!collected.has(gem.id) && Math.hypot(me.x - gem.x, me.y - gem.y) < 28) {
          collected.add(gem.id);
          me.score += 1;
          playTone(640 + me.score * 10);
        }
      }
    },
    draw: drawGems,
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
    actionLabel: "A",
    initialCrown: true,
    update: ({ me, players, now, dt, playTone }) => {
      keepInsideField(me);
      const living = [...players.values()].filter((player) => now - player.seen < 8_000);
      const crowned = living.find((player) => player.crown) ?? living.sort((a, b) => a.id.localeCompare(b.id))[0];
      me.crown = crowned?.id === me.id;
      if (me.crown) me.score += dt * 4;
      for (const player of living) {
        if (player.id !== me.id && player.crown && Math.hypot(me.x - player.x, me.y - player.y) < 34) {
          me.crown = true;
          player.crown = false;
          playTone(880);
        }
      }
    },
    draw: () => undefined,
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
    action: "pulse",
    actionLabel: "PULSE",
    update: ({ me, pulses, now, dt, selfId, playTone }) => {
      const outside = me.x < 25 || me.x > GAME_WIDTH - 25 || me.y < 25 || me.y > GAME_HEIGHT - 25;
      if (outside) {
        me.x = GAME_WIDTH / 2;
        me.y = GAME_HEIGHT / 2;
        me.vx = me.vy = 0;
        me.score = Math.max(0, me.score - 1);
        playTone(70);
      }
      for (const pulse of pulses) {
        if (pulse.owner === selfId) continue;
        const age = now - pulse.born;
        const radius = 25 + age * .32;
        const distance = Math.hypot(me.x - pulse.x, me.y - pulse.y);
        if (distance > radius - 18 && distance < radius + 18) {
          me.vx += (me.x - pulse.x) / Math.max(distance, 1) * 18;
          me.vy += (me.y - pulse.y) / Math.max(distance, 1) * 18;
        }
      }
      me.score += dt;
    },
    draw: drawPulses,
  },
];

export function getGameDefinition(gameId: GameId) {
  return GAME_DEFINITIONS.find((game) => game.id === gameId)!;
}
