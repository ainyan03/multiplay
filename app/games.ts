export type GameId = "gem-sprint" | "crown-chase" | "blast-grid";
export type PlaceId = "lobby" | GameId;

export const PLAYER_NAME_LIMIT = 14;

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

export const GAME_WIDTH = 960;
export const GAME_HEIGHT = 540;

export type GameUpdateContext = {
  me: PlayerState;
  players: Map<string, PlayerState>;
  collected: Set<string>;
  now: number;
  dt: number;
  selfId: string;
  playTone: (frequency: number) => void;
};

export type GameDrawContext = {
  context: CanvasRenderingContext2D;
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
  portal: { x: number; y: number; color: string };
  action?: "bomb";
  actionLabel: string;
  initialCrown?: boolean;
  /**
   * "arena" games run their own simulation loop in the game screen: they need
   * wall collision and a shared clock, which the free-floating games do not.
   */
  kind?: "arena";
  update?: (state: GameUpdateContext) => void;
  draw?: (state: GameDrawContext) => void;
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
    portal: { x: 180, y: 145, color: "#f9e547" },
    actionLabel: "A",
    update: ({ me, collected, now, playTone }) => {
      keepInsideField(me);
      const phasePrefix = `${Math.floor(now / 9000)}:`;
      for (const id of collected) if (!id.startsWith(phasePrefix)) collected.delete(id);
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
    portal: { x: 780, y: 145, color: "#ff6082" },
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
    id: "blast-grid",
    icon: "✸",
    title: "BLAST GRID",
    shortTitle: "BLAST",
    subtitle: "爆風で切り拓く迷路",
    description: "壊せるブロックを爆風で吹き飛ばし、敵と他プレイヤーを巻き込め。倒れてもすぐ復帰できる、出入り自由の常設アリーナ。",
    players: "1人〜",
    accent: "cyan",
    portal: { x: 480, y: 430, color: "#ff9d4d" },
    action: "bomb",
    actionLabel: "BOMB",
    kind: "arena",
  },
];

export function isPlaceId(value: unknown): value is PlaceId {
  return value === "lobby" || GAME_DEFINITIONS.some((game) => game.id === value);
}

