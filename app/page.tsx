"use client";

import React, { useEffect, useMemo, useState } from "react";
import { io } from "socket.io-client";
import type { Socket } from "socket.io-client";
import { AnimatePresence, motion } from "framer-motion";

const suits = ["♠", "♥", "♦", "♣"];
const ranks = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const rankValue = Object.fromEntries(ranks.map((r, i) => [r, i + 2]));

const APP_VERSION = "v0.2.6-beta";
const STARTING_STACK = 5000;
const SMALL_BLIND = 10;
const BIG_BLIND = 20;

type Card = {
  rank: string;
  suit: string;
  value: number;
};

type Player = {
  id: number;
  name: string;
  stack: number;
  hand: Card[];
  folded: boolean;
  bet: number;
  lastAction: string;
  isHero: boolean;
  level: string;
  persona?: string;
};


type ChipBurst = {
  id: number;
  playerId: number;
  amount: number;
};

type RoomState = {
  code: string;
  players: { id: string; name: string; seat?: number; role?: string }[];
};

type SyncedGameState = {
  players: Player[];
  deck: Card[];
  board: Card[];
  pot: number;
  currentBet: number;
  street: string;
  message: string;
  actionLog: string[];
  handOver: boolean;
  showAiCards: boolean;
};

const aiPersonas = [
  { name: "疯狗", style: "loose_aggressive" },
  { name: "老油条", style: "tricky" },
  { name: "铁乌龟", style: "tight" },
  { name: "跟注站", style: "calling_station" },
  { name: "鲨鱼", style: "shark" },
];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeDeck() {
  const deck: Card[] = [];
  for (const suit of suits) {
    for (const rank of ranks) {
      deck.push({ rank, suit, value: Number(rankValue[rank]) });
    }
  }
  return deck.sort(() => Math.random() - 0.5);
}

function cardText(card: Card) {
  return `${card.rank}${card.suit}`;
}

function isRed(card: Card) {
  return card.suit === "♥" || card.suit === "♦";
}

function createPlayers(aiLevel: string, includeSecondHuman = false): Player[] {
  const heroPlayer: Player = {
    id: 0,
    name: includeSecondHuman ? "真人玩家 1" : "你",
    stack: STARTING_STACK,
    hand: [],
    folded: false,
    bet: 0,
    lastAction: "等待",
    isHero: true,
    level: "hero",
  };
  const aiPlayers: Player[] = Array.from({ length: 5 }, (_, i): Player => {
    const isSecondHumanSeat = includeSecondHuman && i === 4;

    return {
      id: i + 1,
      name: isSecondHumanSeat ? "真人玩家 2" : `AI ${i + 1}｜${aiPersonas[i].name}`,
      stack: STARTING_STACK,
      hand: [],
      folded: false,
      bet: 0,
      lastAction: "等待",
      isHero: false,
      level: isSecondHumanSeat ? "human_remote" : aiLevel,
      persona: isSecondHumanSeat ? "human_remote" : aiPersonas[i].style,
    };
  });

  return [heroPlayer, ...aiPlayers];
}

function cleanPlayers(players: Player[]): Player[] {
  return players.map((p): Player => ({
    ...p,
    hand: [],
    folded: false,
    bet: 0,
    lastAction: "等待",
  }));
}

function getStartingHandScore(hand: Card[]) {
  if (hand.length < 2) return 0;
  const [a, b] = hand;
  const high = Math.max(a.value, b.value);
  const low = Math.min(a.value, b.value);
  const pair = a.value === b.value;
  const suited = a.suit === b.suit;
  const gap = high - low;

  let score = high * 4 + low * 2;
  if (pair) score += 45 + high * 3;
  if (suited) score += 8;
  if (gap === 1) score += 6;
  if (gap === 2) score += 3;
  if (gap >= 5) score -= 8;
  if (high === 14) score += 10;
  if (high >= 12 && low >= 10) score += 12;
  return score;
}

function combinations<T>(arr: T[], k: number) {
  const result: T[][] = [];
  function backtrack(start: number, combo: T[]) {
    if (combo.length === k) {
      result.push(combo);
      return;
    }
    for (let i = start; i < arr.length; i++) {
      backtrack(i + 1, [...combo, arr[i]]);
    }
  }
  backtrack(0, []);
  return result;
}

function evaluateFive(cards: Card[]) {
  const values = cards.map((c) => c.value).sort((a, b) => b - a);
  const counts: Record<number, number> = {};
  for (const v of values) counts[v] = (counts[v] || 0) + 1;

  const unique = [...new Set(values)].sort((a, b) => b - a);
  const wheel = unique.includes(14) && unique.includes(5) && unique.includes(4) && unique.includes(3) && unique.includes(2);
  let straightHigh = wheel ? 5 : 0;
  for (let i = 0; i <= unique.length - 5; i++) {
    const slice = unique.slice(i, i + 5);
    if (slice[0] - slice[4] === 4) straightHigh = Math.max(straightHigh, slice[0]);
  }

  const flush = cards.every((c) => c.suit === cards[0].suit);
  const groups = Object.entries(counts)
    .map(([value, count]) => ({ value: Number(value), count }))
    .sort((a, b) => b.count - a.count || b.value - a.value);

  if (flush && straightHigh) return [8, straightHigh];
  if (groups[0].count === 4) return [7, groups[0].value, ...unique.filter((v) => v !== groups[0].value)];
  if (groups[0].count === 3 && groups[1]?.count === 2) return [6, groups[0].value, groups[1].value];
  if (flush) return [5, ...values];
  if (straightHigh) return [4, straightHigh];
  if (groups[0].count === 3) return [3, groups[0].value, ...unique.filter((v) => v !== groups[0].value)];
  if (groups[0].count === 2 && groups[1]?.count === 2) {
    const pairs = groups.filter((g) => g.count === 2).map((g) => g.value).sort((a, b) => b - a);
    const kicker = unique.find((v) => !pairs.includes(v)) || 0;
    return [2, ...pairs, kicker];
  }
  if (groups[0].count === 2) return [1, groups[0].value, ...unique.filter((v) => v !== groups[0].value)];
  return [0, ...values];
}

function compareScore(a: number[], b: number[]) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function bestHandScore(cards: Card[]) {
  if (cards.length < 5) return [0, ...cards.map((c) => c.value).sort((a, b) => b - a)];
  return combinations(cards, 5).map(evaluateFive).sort((a, b) => compareScore(b, a))[0];
}

function handName(score: number[]) {
  return ["高牌", "一对", "两对", "三条", "顺子", "同花", "葫芦", "四条", "同花顺"][score?.[0] || 0];
}

function estimateStrength(hand: Card[], board: Card[] = []) {
  const start = getStartingHandScore(hand);
  if (board.length === 0) return Math.min(95, Math.max(5, Math.round(start)));
  const score = bestHandScore([...hand, ...board]);
  let base = [18, 35, 52, 68, 76, 82, 90, 96, 99][score[0]];
  const highCards = hand.filter((c) => c.value >= 12).length;
  const drawBonus = board.length < 5 && hand.some((c) => c.value >= 12) ? 4 : 0;
  base += highCards * 3 + drawBonus;
  return Math.min(99, Math.max(3, base));
}

function personaConfig(persona?: string, level = "normal") {
  const hard = level === "hard";

  if (persona === "loose_aggressive") {
    return {
      style: "LAG",
      tightness: hard ? 26 : 34,
      aggression: hard ? 0.42 : 0.28,
      bluff: hard ? 0.24 : 0.12,
      randomness: hard ? 28 : 16,
      raiseThreshold: hard ? 72 : 78,
      callBias: 6,
    };
  }

  if (persona === "tricky") {
    return {
      style: "TRICKY",
      tightness: hard ? 34 : 40,
      aggression: hard ? 0.24 : 0.16,
      bluff: hard ? 0.34 : 0.18,
      randomness: hard ? 36 : 20,
      raiseThreshold: hard ? 78 : 84,
      callBias: 2,
    };
  }

  if (persona === "tight") {
    return {
      style: "NIT",
      tightness: hard ? 58 : 66,
      aggression: hard ? 0.08 : 0.04,
      bluff: hard ? 0.02 : 0.01,
      randomness: hard ? 14 : 8,
      raiseThreshold: hard ? 90 : 94,
      callBias: -12,
    };
  }

  if (persona === "calling_station") {
    return {
      style: "CALLING",
      tightness: hard ? 22 : 28,
      aggression: hard ? 0.04 : 0.02,
      bluff: hard ? 0.01 : 0,
      randomness: hard ? 18 : 10,
      raiseThreshold: 99,
      callBias: 18,
    };
  }

  if (persona === "shark") {
    return {
      style: "SHARK",
      tightness: hard ? 42 : 48,
      aggression: hard ? 0.3 : 0.18,
      bluff: hard ? 0.14 : 0.08,
      randomness: hard ? 18 : 12,
      raiseThreshold: hard ? 76 : 82,
      callBias: 4,
    };
  }

  return {
    style: "NORMAL",
    tightness: 42,
    aggression: 0.12,
    bluff: 0.06,
    randomness: 18,
    raiseThreshold: 82,
    callBias: 0,
  };
}

function gtoAdvice(hand: Card[], board: Card[], toCall: number, pot: number, heroStack: number) {
  const strength = estimateStrength(hand, board);
  const potOdds = toCall > 0 ? Math.round((toCall / (pot + toCall)) * 100) : 0;
  let action = "弃牌";
  let reason = "牌力偏弱，面对下注不适合投入太多筹码。";

  if (toCall === 0) {
    if (strength >= 72) {
      action = "下注 50%-75% 底池";
      reason = "牌力强，可以价值下注，也能保护牌面。";
    } else if (strength >= 48) {
      action = "过牌 / 小注";
      reason = "中等牌力，适合控制底池。";
    } else {
      action = "过牌";
      reason = "弱牌优先免费看下一张。";
    }
  } else if (strength >= 70) {
    action = "加注 / 跟注";
    reason = "牌力足够强，可以继续打价值。";
  } else if (strength >= potOdds + 18) {
    action = "跟注";
    reason = "估算胜率高于底池赔率。";
  }

  if (heroStack <= BIG_BLIND * 6 && strength >= 55) {
    action = "全下";
    reason = "短码状态下，中强牌可以直接推入。";
  }

  return { strength, potOdds, action, reason };
}

function ChipStack({ amount, small = false }: { amount: number; small?: boolean }) {
  if (amount <= 0) return null;
  const chips = Math.min(9, Math.ceil(amount / 80));
  return (
    <div className="flex items-end gap-1 h-9 mt-2">
      {Array.from({ length: chips }).map((_, i) => (
        <motion.div
          key={i}
          initial={{ y: 8, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          className={`${small ? "w-5 h-2" : "w-7 h-3"} rounded-full border border-white/50 bg-red-500 shadow`}
          style={{ marginBottom: i * 2 }}
        />
      ))}
      <span className="text-xs text-amber-200 font-black">{amount}</span>
    </div>
  );
}

function CardView({ card, hidden = false }: { card?: Card; hidden?: boolean }) {
  if (hidden || !card) {
    return (
      <div className="w-12 h-16 md:w-14 md:h-20 rounded-xl bg-indigo-700 border border-indigo-400 shadow flex items-center justify-center text-xl">
        ★
      </div>
    );
  }

  return (
    <motion.div
      initial={{ rotateY: 90, y: 10, opacity: 0 }}
      animate={{ rotateY: 0, y: 0, opacity: 1 }}
      transition={{ type: "spring", stiffness: 260, damping: 18 }}
      className="w-12 h-16 md:w-14 md:h-20 rounded-xl bg-white text-black shadow flex flex-col items-center justify-center font-black"
    >
      <span className={isRed(card) ? "text-red-600" : "text-black"}>{card.rank}</span>
      <span className={isRed(card) ? "text-red-600" : "text-black"}>{card.suit}</span>
    </motion.div>
  );
}

export default function PokerTrainer() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [room, setRoom] = useState<RoomState | null>(null);
  const [roomCodeInput, setRoomCodeInput] = useState("");
  const [activeRoomCode, setActiveRoomCode] = useState("");
  const [mySeatId, setMySeatId] = useState(0);
  const [onlineMessage, setOnlineMessage] = useState("未连接房间");
  const [gameMode, setGameMode] = useState<"ai" | "multiplayer">("ai");
  const [aiLevel, setAiLevel] = useState("hard");
  const [players, setPlayers] = useState<Player[]>(() => createPlayers("hard"));
  const [deck, setDeck] = useState<Card[]>([]);
  const [board, setBoard] = useState<Card[]>([]);
  const [pot, setPot] = useState(0);
  const [currentBet, setCurrentBet] = useState(0);
  const [street, setStreet] = useState("准备");
  const [message, setMessage] = useState("点击开始新一手。目标：打光5个困难AI的筹码。");
  const [showGto, setShowGto] = useState(false);
  const [showChangelog, setShowChangelog] = useState(false);
  const [showAiCards, setShowAiCards] = useState(false);
  const [actionLog, setActionLog] = useState<string[]>([]);
  const [handOver, setHandOver] = useState(true);
  const [actingPlayerId, setActingPlayerId] = useState<number | null>(null);
  const [isResolving, setIsResolving] = useState(false);
  const [chipBursts, setChipBursts] = useState<ChipBurst[]>([]);

  const hero = players.find((p) => p.id === mySeatId) || players[0];
  const toCall = Math.max(0, currentBet - hero.bet);
  const advice = useMemo(() => gtoAdvice(hero.hand, board, toCall, pot, hero.stack), [hero.hand, board, toCall, pot, hero.stack]);
  const hasSecondHuman = Boolean(room && room.players.length >= 2);
  const isRoomHost = Boolean(room && socket && room.players[0]?.id === socket.id);

  useEffect(() => {
    const socketUrl =
      typeof window !== "undefined"
        ? window.location.origin
        : "https://blackjack-trainer-production-d563.up.railway.app";

    const nextSocket = io(socketUrl, {
      transports: ["websocket", "polling"],
    });
    setSocket(nextSocket);

    nextSocket.on("connect", () => {
      setOnlineMessage(`已连接服务器，可以创建或加入房间。Socket: ${nextSocket.id}`);
    });

    nextSocket.on("connect_error", (err) => {
      setOnlineMessage(`连接失败：${err.message}`);
    });

    nextSocket.on("roomCreated", (nextRoom: RoomState) => {
      setRoom(nextRoom);
      setActiveRoomCode(nextRoom.code);
      setMySeatId(0);
      setOnlineMessage(`房间 ${nextRoom.code}：${nextRoom.players.length}/2 人已加入`);
    });

    nextSocket.on("roomUpdate", (nextRoom: RoomState) => {
      setRoom(nextRoom);
      setActiveRoomCode(nextRoom.code);
      const currentSocketId = nextSocket.id;
      const currentPlayer = nextRoom.players.find((p) => p.id === currentSocketId);
      if (typeof currentPlayer?.seat === "number") setMySeatId(currentPlayer.seat);
      setOnlineMessage(`房间 ${nextRoom.code}：${nextRoom.players.length}/2 人已加入`);

      if (nextRoom.players.length >= 2 && handOver) {
        setPlayers((prev) =>
          prev.map((p) =>
            p.id === 5
              ? { ...p, name: "真人玩家 2", level: "human_remote", persona: "human_remote" }
              : p
          )
        );
      }
    });

    nextSocket.on("errorMessage", (msg: string) => {
      setOnlineMessage(msg);
    });

    nextSocket.on("gameSync", (state: SyncedGameState) => {
      if (!state) return;
      setPlayers(state.players);
      setDeck(state.deck);
      setBoard(state.board);
      setPot(state.pot);
      setCurrentBet(state.currentBet);
      setStreet(state.street);
      setMessage(state.message);
      setActionLog(state.actionLog);
      setHandOver(state.handOver);
      setShowAiCards(state.showAiCards);
      setActingPlayerId(state.handOver ? null : 0);
      setIsResolving(false);
    });

    nextSocket.on("disconnect", () => {
      setOnlineMessage("已断开服务器连接。");
    });

    return () => {
      nextSocket.disconnect();
    };
  }, []);

  function createOnlineRoom() {
    setGameMode("multiplayer");
    setShowAiCards(false);
    if (!socket || !socket.connected) {
      setOnlineMessage("Socket 还没连接成功，请刷新页面或稍等几秒。");
      return;
    }
    setOnlineMessage("正在创建房间...");
    socket.emit("createRoom");
  }

  function joinOnlineRoom() {
    setGameMode("multiplayer");
    setShowAiCards(false);
    const code = roomCodeInput.trim().toUpperCase();
    if (!code) {
      setOnlineMessage("请输入房间号。");
      return;
    }
    setActiveRoomCode(code);
    setMySeatId(5);
    socket?.emit("joinRoom", code);
  }

  function syncGameState(nextState: SyncedGameState) {
    if (!socket || !socket.connected) {
      setOnlineMessage("同步失败：Socket 未连接");
      return;
    }

    const roomCodeForSync = activeRoomCode || room?.code || roomCodeInput.trim().toUpperCase();

    if (!roomCodeForSync) {
      setOnlineMessage("同步失败：当前没有房间号");
      return;
    }

    socket.emit("gameSync", {
      roomCode: roomCodeForSync,
      state: nextState,
    });

    setOnlineMessage(`已同步牌局到房间 ${roomCodeForSync}`);
  }

  function addChipBurst(playerId: number, amount: number) {
    if (amount <= 0) return;
    const id = Date.now() + Math.random();
    setChipBursts((items) => [...items, { id, playerId, amount }]);
    setTimeout(() => setChipBursts((items) => items.filter((item) => item.id !== id)), 950);
  }

  function resetGame(level = aiLevel) {
    setAiLevel(level);
    setPlayers(createPlayers(level, hasSecondHuman));
    setDeck([]);
    setBoard([]);
    setPot(0);
    setCurrentBet(0);
    setStreet("准备");
    setMessage("已重新开始。点击开始新一手。目标：打光5个困难AI的筹码。");
    setShowAiCards(false);
    setActionLog([]);
    setHandOver(true);
    setActingPlayerId(null);
    setIsResolving(false);
    setChipBursts([]);
  }

  function startHand() {
    if (room && !isRoomHost) {
      setMessage("只有房主可以开始新一手，等待房主发牌同步。");
      return;
    }
    const activePlayers = players.filter((p) => p.stack > 0);
    if (hero.stack <= 0) return resetGame(aiLevel);
    if (activePlayers.filter((p) => !p.isHero).length === 0) {
      setMessage("你已经打光所有AI，训练完成！可以重新开始。");
      setHandOver(true);
      return;
    }

    const newDeck = makeDeck();
    let newPlayers: Player[] = players
      .map((p): Player => ({
        ...p,
        hand: [],
        folded: false,
        bet: 0,
        lastAction: "等待",
      }))
      .filter((p) => p.stack > 0);
    if (!newPlayers.some((p) => p.isHero)) newPlayers = createPlayers(aiLevel, hasSecondHuman);

    for (let round = 0; round < 2; round++) {
      newPlayers = newPlayers.map((p) => ({ ...p, hand: [...p.hand, newDeck.pop() as Card] }));
    }

    let newPot = 0;
    const log: string[] = [];
    newPlayers = newPlayers.map((p, i) => {
      const blind = i === 1 ? SMALL_BLIND : i === 2 ? BIG_BLIND : 0;
      const pay = Math.min(blind, p.stack);
      newPot += pay;
      if (pay > 0) {
        log.push(`${p.name} 下盲注 ${pay}`);
        addChipBurst(p.id, pay);
      }
      return { ...p, stack: p.stack - pay, bet: pay, lastAction: pay > 0 ? `盲注 ${pay}` : "等待" };
    });

    const nextMessage = "新一手开始。你行动。每次你操作后，AI会按顺序思考和下注。";
    const nextActionLog = ["新一手开始", ...log];

    setPlayers(newPlayers);
    setDeck(newDeck);
    setBoard([]);
    setPot(newPot);
    setCurrentBet(BIG_BLIND);
    setStreet("翻牌前");
    setMessage(nextMessage);
    setShowAiCards(false);
    setActionLog(nextActionLog);
    setActingPlayerId(0);
    setIsResolving(false);
    setHandOver(false);

    syncGameState({
      players: newPlayers,
      deck: newDeck,
      board: [],
      pot: newPot,
      currentBet: BIG_BLIND,
      street: "翻牌前",
      message: nextMessage,
      actionLog: nextActionLog,
      handOver: false,
      showAiCards: false,
    });
  }

  async function updateHero(action: string, amount = 0) {
    if (handOver || isResolving) return;
    setIsResolving(true);

    let newPlayers = [...players];
    let newPot = pot;
    let newBet = currentBet;
    const heroIndex = Math.max(0, newPlayers.findIndex((p) => p.id === mySeatId));
    const h = { ...newPlayers[heroIndex] };

    if (action === "fold") {
      h.folded = true;
      h.lastAction = "弃牌";
      newPlayers[heroIndex] = h;
      setPlayers(newPlayers);
      setActionLog((log) => ["你弃牌", ...log]);
      setShowAiCards(true);
      setMessage("你弃牌了。本手结束，AI拿走底池。");
      givePotToAi(newPlayers, newPot);
      return;
    }

    if (action === "call") {
      const pay = Math.min(toCall, h.stack);
      h.stack -= pay;
      h.bet += pay;
      h.lastAction = toCall > 0 ? `跟注 ${pay}` : "过牌";
      newPot += pay;
      addChipBurst(mySeatId, pay);
      setActionLog((log) => [`你${toCall > 0 ? `跟注 ${pay}` : "过牌"}`, ...log]);
    }

    if (action === "raise") {
      const target = currentBet + amount;
      const pay = Math.min(target - h.bet, h.stack);
      h.stack -= pay;
      h.bet += pay;
      h.lastAction = `加注到 ${h.bet}`;
      newPot += pay;
      newBet = Math.max(newBet, h.bet);
      addChipBurst(mySeatId, pay);
      setActionLog((log) => [`你加注到 ${h.bet}`, ...log]);
    }

    if (action === "allin") {
      const pay = h.stack;
      h.stack = 0;
      h.bet += pay;
      h.lastAction = `全下 ${h.bet}`;
      newPot += pay;
      newBet = Math.max(newBet, h.bet);
      addChipBurst(mySeatId, pay);
      setActionLog((log) => [`你全下，总下注 ${h.bet}`, ...log]);
    }

    newPlayers[heroIndex] = h;
    setPlayers(newPlayers);
    setPot(newPot);
    setCurrentBet(newBet);

    syncGameState({
      players: newPlayers,
      deck,
      board,
      pot: newPot,
      currentBet: newBet,
      street,
      message: action === "fold"
        ? "你弃牌了"
        : action === "call"
          ? "你选择跟注/过牌"
          : action === "allin"
            ? "你选择全下"
            : "你选择加注",
      actionLog:
        action === "fold"
          ? ["你弃牌", ...actionLog]
          : action === "call"
            ? [`你${toCall > 0 ? `跟注 ${toCall}` : "过牌"}`, ...actionLog]
            : action === "allin"
              ? [`你全下，总下注 ${h.bet}`, ...actionLog]
              : [`你加注到 ${h.bet}`, ...actionLog],
      handOver: false,
      showAiCards,
    });

    await sleep(500);
    await aiActSequential(newPlayers, newPot, newBet);
  }

  async function aiActSequential(basePlayers: Player[], basePot: number, baseBet: number) {
    let newPlayers = [...basePlayers];
    let newPot = basePot;
    let newBet = baseBet;
    let aiRaisesThisSequence = 0;

    for (let idx = 1; idx < newPlayers.length; idx++) {
      const p = newPlayers[idx];
      if (p.folded || p.stack <= 0 || p.level === "human_remote") continue;

      setActingPlayerId(p.id);
      setChipBursts([]);
      setMessage(`${p.name} 正在思考...`);
      await sleep(p.level === "hard" ? 650 + Math.random() * 950 : 450 + Math.random() * 500);

      const callNeed = Math.max(0, newBet - p.bet);
      const strength = estimateStrength(p.hand, board);
      const cfg = personaConfig(p.persona, p.level);
      const isPreflop = board.length === 0;
      const isFlop = board.length === 3;
      const isTurn = board.length === 4;
      const isRiver = board.length === 5;
      const potAfterCall = newPot + callNeed;
      const potPressure = callNeed > 0 ? callNeed / Math.max(1, potAfterCall) : 0;
      const randomSwing = Math.random() * cfg.randomness - cfg.randomness / 2;
      const adjusted = strength + cfg.callBias + randomSwing;
      const updated = { ...p };
      let logText = "";

      const isLag = p.persona === "loose_aggressive";
      const isTricky = p.persona === "tricky";
      const isNit = p.persona === "tight";
      const isCallingStation = p.persona === "calling_station";
      const isShark = p.persona === "shark";

      const strongHand = adjusted >= (isPreflop ? 86 : 76);
      const premiumHand = adjusted >= (isPreflop ? 92 : 84);
      const monsterHand = adjusted >= (isPreflop ? 97 : 92);
      const playableHand = adjusted >= (isPreflop ? 48 : 44);
      const shortStack = updated.stack <= BIG_BLIND * 18;
      const facingBigRaise = isPreflop ? callNeed >= BIG_BLIND * 7 : potPressure >= 0.42;
      const alreadyAggressive =
        updated.lastAction.includes("加注") ||
        updated.lastAction.includes("全下") ||
        updated.lastAction.includes("诈唬") ||
        updated.lastAction.includes("下注");

      const bluffFrequency =
        isLag ? 0.16 :
        isTricky ? 0.2 :
        isShark ? 0.07 :
        isNit ? 0.015 :
        isCallingStation ? 0.005 :
        0.04;

      const canAggress =
        aiRaisesThisSequence < 1 &&
        !alreadyAggressive &&
        updated.stack > callNeed + BIG_BLIND * 5;

      const rareAllInBluff =
        !isPreflop &&
        (isTurn || isRiver) &&
        (isLag || isTricky) &&
        !monsterHand &&
        adjusted < 58 &&
        updated.stack <= Math.max(BIG_BLIND * 25, newPot * 0.75) &&
        Math.random() < (isRiver ? 0.025 : 0.012);

      const valueAllIn =
        !isPreflop &&
        shortStack &&
        premiumHand &&
        Math.random() < (isShark ? 0.35 : isLag ? 0.28 : 0.18);

      const shouldAllIn = canAggress && (valueAllIn || rareAllInBluff);

      if (shouldAllIn) {
        const pay = updated.stack;
        updated.stack = 0;
        updated.bet += pay;
        updated.lastAction = rareAllInBluff ? `全下诈唬 ${updated.bet}` : `价值全下 ${updated.bet}`;
        newPot += pay;
        newBet = Math.max(newBet, updated.bet);
        addChipBurst(updated.id, pay);
        aiRaisesThisSequence += 1;
        logText = `${updated.name} ${updated.lastAction}`;
      } else if (callNeed > 0) {
        const foldThreshold =
          cfg.tightness +
          (facingBigRaise ? 16 : 0) +
          (isNit ? 8 : 0) -
          (isCallingStation ? 18 : 0) -
          (isLag ? 5 : 0);

        const shouldFold =
          !isCallingStation &&
          !premiumHand &&
          adjusted < foldThreshold &&
          Math.random() > bluffFrequency;

        if (shouldFold) {
          updated.folded = true;
          updated.lastAction = "弃牌";
          logText = `${updated.name} 弃牌`;
        } else {
          const preflopThreeBet =
            isPreflop &&
            canAggress &&
            !facingBigRaise &&
            (premiumHand || (isLag && strongHand && Math.random() < 0.18) || (isTricky && strongHand && Math.random() < 0.1));

          const postflopSemiBluff =
            !isPreflop &&
            canAggress &&
            (isFlop || isTurn) &&
            adjusted >= 54 &&
            adjusted < 76 &&
            (isLag || isTricky) &&
            Math.random() < bluffFrequency;

          const postflopValueRaise =
            !isPreflop &&
            canAggress &&
            adjusted >= cfg.raiseThreshold &&
            Math.random() < cfg.aggression;

          const wantsRaise = preflopThreeBet || postflopSemiBluff || postflopValueRaise;

          if (wantsRaise) {
            const raiseSize = isPreflop
              ? BIG_BLIND * (isLag ? 5 : isShark ? 4 : 3)
              : Math.max(
                  BIG_BLIND * 3,
                  Math.round((newPot * (isLag ? 0.65 : isShark ? 0.55 : 0.45)) / BIG_BLIND) * BIG_BLIND
                );
            const raiseTo = Math.min(newBet + raiseSize, updated.bet + updated.stack);
            const pay = Math.min(raiseTo - updated.bet, updated.stack);
            updated.stack -= pay;
            updated.bet += pay;
            updated.lastAction = postflopSemiBluff || (preflopThreeBet && !premiumHand)
              ? `偷鸡加注到 ${updated.bet}`
              : isLag
                ? `激进加注到 ${updated.bet}`
                : isShark
                  ? `价值加注到 ${updated.bet}`
                  : `加注到 ${updated.bet}`;
            newPot += pay;
            newBet = Math.max(newBet, updated.bet);
            addChipBurst(updated.id, pay);
            aiRaisesThisSequence += 1;
            logText = `${updated.name} ${updated.lastAction}`;
          } else {
            const pay = Math.min(callNeed, updated.stack);
            updated.stack -= pay;
            updated.bet += pay;
            updated.lastAction = callNeed > 0 ? `跟注 ${pay}` : "过牌";
            newPot += pay;
            addChipBurst(updated.id, pay);
            logText = `${updated.name} ${updated.lastAction}`;
          }
        }
      } else {
        const probeBet =
          !isPreflop &&
          canAggress &&
          playableHand &&
          Math.random() < (isLag ? 0.24 : isTricky ? 0.18 : isShark ? 0.14 : isNit ? 0.04 : 0.07);

        const bluffBet =
          !isPreflop &&
          canAggress &&
          !playableHand &&
          (isLag || isTricky) &&
          Math.random() < bluffFrequency * 0.65;

        if (probeBet || bluffBet) {
          const betSize = Math.max(
            BIG_BLIND * 2,
            Math.round((Math.max(newPot, BIG_BLIND * 4) * (bluffBet ? 0.38 : 0.5)) / BIG_BLIND) * BIG_BLIND
          );
          const pay = Math.min(betSize, updated.stack);
          updated.stack -= pay;
          updated.bet += pay;
          updated.lastAction = bluffBet ? `偷鸡下注 ${pay}` : `下注 ${pay}`;
          newPot += pay;
          newBet = Math.max(newBet, updated.bet);
          addChipBurst(updated.id, pay);
          aiRaisesThisSequence += 1;
          logText = `${updated.name} ${updated.lastAction}`;
        } else {
          updated.lastAction = "过牌";
          logText = `${updated.name} 过牌`;
        }
      }

      const nextActionLog = [logText, ...actionLog];

      newPlayers[idx] = updated;
      setPlayers([...newPlayers]);
      setPot(newPot);
      setCurrentBet(newBet);
      setActionLog((log) => [logText, ...log]);
      setMessage(logText);

      syncGameState({
        players: [...newPlayers],
        deck,
        board,
        pot: newPot,
        currentBet: newBet,
        street,
        message: logText,
        actionLog: nextActionLog,
        handOver: false,
        showAiCards,
      });

      await sleep(500);

      const active = newPlayers.filter((player) => !player.folded && player.stack >= 0);
      if (active.length <= 1) {
        const winner = active[0];
        newPlayers = newPlayers.map((player) => (player.id === winner.id ? { ...player, stack: player.stack + newPot } : player));
        setPlayers(newPlayers);
        setPot(0);
        setShowAiCards(true);
        setHandOver(true);
        setActingPlayerId(null);
        setIsResolving(false);
        const winLog = `${winner.name} 赢下底池 ${newPot}`;
        const winMessage = `${winner.name} 赢下底池。点击下一手。`;
        setActionLog((log) => [winLog, ...log]);
        setMessage(winMessage);
        syncGameState({
          players: newPlayers,
          deck,
          board,
          pot: 0,
          currentBet: newBet,
          street,
          message: winMessage,
          actionLog: [winLog, ...actionLog],
          handOver: true,
          showAiCards: true,
        });
        return;
      }
    }

    setPlayers(newPlayers);
    setPot(newPot);
    setCurrentBet(newBet);

    const heroAfterAi = newPlayers.find((p) => p.id === mySeatId) || newPlayers[0];
    const heroNeedsToRespond = !heroAfterAi.folded && heroAfterAi.stack > 0 && newBet > heroAfterAi.bet;

    if (heroNeedsToRespond) {
      setActingPlayerId(mySeatId);
      setIsResolving(false);
      const respondMessage = `AI加注到 ${newBet}，现在轮到你。需要跟注 ${newBet - heroAfterAi.bet}。`;
      const respondLog = `行动回到你：需要跟注 ${newBet - heroAfterAi.bet}`;
      setMessage(respondMessage);
      setActionLog((log) => [respondLog, ...log]);
      syncGameState({
        players: newPlayers,
        deck,
        board,
        pot: newPot,
        currentBet: newBet,
        street,
        message: respondMessage,
        actionLog: [respondLog, ...actionLog],
        handOver: false,
        showAiCards,
      });
      return;
    }

    setActingPlayerId(null);
    await sleep(450);
    advanceStreet(newPlayers, newPot);
    setIsResolving(false);
  }

  function advanceStreet(newPlayers: Player[], newPot: number) {
    let newDeck = [...deck];
    let newBoard = [...board];
    let nextStreet = street;

    if (street === "翻牌前") {
      newBoard = [newDeck.pop() as Card, newDeck.pop() as Card, newDeck.pop() as Card];
      nextStreet = "翻牌";
    } else if (street === "翻牌") {
      newBoard = [...newBoard, newDeck.pop() as Card];
      nextStreet = "转牌";
    } else if (street === "转牌") {
      newBoard = [...newBoard, newDeck.pop() as Card];
      nextStreet = "河牌";
    } else {
      showdown(newPlayers, newBoard, newPot);
      return;
    }

    const clearedPlayers = newPlayers.map((p) => ({ ...p, bet: 0, lastAction: p.folded ? "已弃牌" : "等待" }));
    const streetLog = `发出${nextStreet}：${newBoard.map(cardText).join(" ")}`;
    const streetMessage = `${nextStreet}圈。你行动。`;
    const nextActionLog = [streetLog, ...actionLog];

    setPlayers(clearedPlayers);
    setDeck(newDeck);
    setBoard(newBoard);
    setCurrentBet(0);
    setStreet(nextStreet);
    setActingPlayerId(mySeatId);
    setActionLog((log) => [streetLog, ...log]);
    setMessage(streetMessage);

    syncGameState({
      players: clearedPlayers,
      deck: newDeck,
      board: newBoard,
      pot: newPot,
      currentBet: 0,
      street: nextStreet,
      message: streetMessage,
      actionLog: nextActionLog,
      handOver: false,
      showAiCards,
    });
  }

  function showdown(finalPlayers = players, finalBoard = board, finalPot = pot) {
    const contenders = finalPlayers.filter((p) => !p.folded);
    const ranked = contenders.map((p) => ({ ...p, score: bestHandScore([...p.hand, ...finalBoard]) }));
    ranked.sort((a, b) => compareScore(b.score, a.score));
    const winner = ranked[0];
    const newPlayers = finalPlayers.map((p) => (p.id === winner.id ? { ...p, stack: p.stack + finalPot } : p));
    setPlayers(newPlayers);
    setPot(0);
    setShowAiCards(true);
    setHandOver(true);
    setActingPlayerId(null);
    setIsResolving(false);
    const showLog = `摊牌：${winner.name} 用 ${handName(winner.score)} 赢下 ${finalPot}`;
    const showMessage = `${winner.name} 摊牌获胜：${handName(winner.score)}。点击下一手继续。`;
    setActionLog((log) => [showLog, ...log]);
    setMessage(showMessage);
    syncGameState({
      players: newPlayers,
      deck,
      board: finalBoard,
      pot: 0,
      currentBet,
      street,
      message: showMessage,
      actionLog: [showLog, ...actionLog],
      handOver: true,
      showAiCards: true,
    });
  }

  function givePotToAi(newPlayers: Player[], newPot: number) {
    const aiWinner = newPlayers.find((p) => !p.isHero && !p.folded) || newPlayers.find((p) => !p.isHero);
    if (!aiWinner) return;
    const paid = newPlayers.map((p) => (p.id === aiWinner.id ? { ...p, stack: p.stack + newPot } : p));
    setPlayers(paid);
    setPot(0);
    setShowAiCards(true);
    setHandOver(true);
    setActingPlayerId(null);
    setIsResolving(false);
    const aiWinLog = `${aiWinner.name} 获得底池 ${newPot}`;
    setActionLog((log) => [aiWinLog, ...log]);
    syncGameState({
      players: paid,
      deck,
      board,
      pot: 0,
      currentBet,
      street,
      message: `${aiWinner.name} 获得底池。`,
      actionLog: [aiWinLog, ...actionLog],
      handOver: true,
      showAiCards: true,
    });
  }

  function PlayerSeat({ p }: { p: Player }) {
    const isActing = actingPlayerId === p.id;
    return (
      <motion.div
        animate={{ scale: isActing ? 1.05 : 1, y: isActing ? -6 : 0 }}
        transition={{ type: "spring", stiffness: 260, damping: 18 }}
        className={`relative rounded-2xl p-3 bg-emerald-950/80 border ${
          isActing
            ? "border-yellow-300 shadow-[0_0_25px_rgba(250,204,21,0.55)]"
            : p.folded
              ? "opacity-40 border-red-500"
              : "border-emerald-600"
        }`}
      >
        <div className="font-bold">{p.name}</div>
        <div className="text-sm text-emerald-200">筹码：{p.stack}</div>
        <div className="text-sm text-amber-200 font-bold">当前下注：{p.bet}</div>
        <div className="text-xs text-sky-200">上次行动：{p.lastAction}</div>
        <div className="text-xs text-emerald-300">{p.folded ? "已弃牌" : p.stack <= 0 ? "全下" : "游戏中"}</div>
        <div className="flex gap-1 mt-2">
          {p.hand.length ? (
            p.hand.map((c, i) => (
  <CardView
    key={i}
    card={c}
    hidden={gameMode === "multiplayer" || (!showAiCards && !handOver)}
  />
))
          ) : (
            <>
              <CardView hidden />
              <CardView hidden />
            </>
          )}
        </div>
        <ChipStack amount={p.bet} small />
        <AnimatePresence>
          {chipBursts.filter((burst) => burst.playerId === p.id).map((burst) => (
            <motion.div
              key={burst.id}
              initial={{ y: -10, opacity: 0, scale: 0.6 }}
              animate={{ y: 50, opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              className="absolute left-1/2 top-1/2 -translate-x-1/2 rounded-full bg-amber-400 text-black px-2 py-1 text-xs font-black shadow-lg"
            >
              +{burst.amount}
            </motion.div>
          ))}
        </AnimatePresence>
      </motion.div>
    );
  }

  return (
    <main className="min-h-screen bg-emerald-950 text-white p-4 md:p-6">
      <div className="mx-auto max-w-6xl space-y-5">
        <header className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h1 className="text-3xl md:text-4xl font-black">德州扑克GTO训练器</h1>
            <p className="text-emerald-200">Beta {APP_VERSION}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => {
                setGameMode("ai");
                setShowAiCards(false);
                resetGame("hard");
              }}
              className={`rounded-xl px-4 py-2 font-bold ${gameMode === "ai" ? "bg-white text-emerald-950" : "bg-emerald-800 text-white"}`}
            >
              AI模式
            </button>
            <button
              onClick={() => {
                setGameMode("multiplayer");
                setShowAiCards(false);
              }}
              className={`rounded-xl px-4 py-2 font-bold ${gameMode === "multiplayer" ? "bg-white text-emerald-950" : "bg-emerald-800 text-white"}`}
            >
              真人模式
            </button>
            <button
              onClick={() => setShowChangelog(true)}
              className="rounded-xl bg-sky-500 px-4 py-2 font-bold text-white"
            >
              更新日志
            </button>
          </div>
        </header>

        {gameMode === "multiplayer" && (
        <section className="rounded-2xl bg-neutral-950 border border-emerald-700 p-4 space-y-3">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <div>
              <div className="text-xl font-black">2人联机房间</div>
              <div className="text-sm text-emerald-200">{onlineMessage}</div>
              {room && (
                <div className="text-sm text-yellow-300 mt-1">
                  房间号：<span className="font-black tracking-widest">{room.code}</span> ｜ 玩家：{room.players.map((p) => p.name).join(" / ")}
                </div>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <button onClick={createOnlineRoom} className="rounded-xl bg-sky-500 px-4 py-2 font-bold">
                创建房间
              </button>
              <input
                value={roomCodeInput}
                onChange={(e) => setRoomCodeInput(e.target.value.toUpperCase())}
                placeholder="输入房间号"
                className="rounded-xl bg-neutral-900 border border-neutral-700 px-4 py-2 text-white uppercase w-32"
              />
              <button onClick={joinOnlineRoom} className="rounded-xl bg-indigo-500 px-4 py-2 font-bold">
                加入房间
              </button>
            </div>
          </div>
        </section>
        )}

        <section className="grid grid-cols-2 gap-3 md:max-w-md">
          <div className="rounded-xl bg-emerald-900/70 border border-emerald-700 px-4 py-3">
            <div className="text-xs text-emerald-200">底池</div>
            <motion.div key={pot} initial={{ scale: 1.12 }} animate={{ scale: 1 }} className="text-2xl font-black">
              {pot}
            </motion.div>
            <ChipStack amount={pot} small />
          </div>
          <div className="rounded-xl bg-emerald-900/70 border border-emerald-700 px-4 py-3">
            <div className="text-xs text-emerald-200">阶段</div>
            <div className="text-2xl font-black">{street}</div>
          </div>
        </section>

        <section className="rounded-[2rem] bg-green-800 border-4 border-amber-900 shadow-2xl p-4 md:p-8 space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {players.filter((p) => p.id !== mySeatId).map((p) => <PlayerSeat key={p.id} p={p} />)}
          </div>

          <div className="text-center space-y-3">
            <div className="text-emerald-100 font-bold">公共牌</div>
            <div className="flex justify-center gap-2 min-h-20">
              {board.length ? (
                board.map((c, i) => <CardView key={`${street}-${i}-${cardText(c)}`} card={c} />)
              ) : (
                <div className="text-emerald-200">还没有公共牌</div>
              )}
            </div>
          </div>

          <motion.div
            animate={{ scale: actingPlayerId === 0 || actingPlayerId === mySeatId ? 1.015 : 1 }}
            className={`relative rounded-2xl bg-emerald-950/80 border p-4 space-y-3 ${
              actingPlayerId === 0 || actingPlayerId === mySeatId ? "border-yellow-300 shadow-[0_0_25px_rgba(250,204,21,0.45)]" : "border-emerald-600"
            }`}
          >
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
              <div>
                <div className="text-xl font-black">你的手牌</div>
                <div className="text-emerald-200">筹码：{hero.stack}｜需跟注：{toCall}</div>
                <div className="text-xs text-sky-200">上次行动：{hero.lastAction}</div>
              </div>
              <div className="flex gap-2 pr-28 md:pr-40">
                {hero.hand.length ? hero.hand.map((c, i) => <CardView key={i} card={c} />) : <div className="text-emerald-200">点击开始新一手</div>}
              </div>
              <img
                src="/cat-cutout.png"
                alt="训练助手猫"
                className="pointer-events-none absolute right-4 top-6 z-10 w-24 md:w-36 drop-shadow-2xl select-none"
              />
            </div>

            <div className="flex flex-wrap gap-2">
              {handOver ? (
                <button
                  disabled={Boolean(room && !isRoomHost)}
                  onClick={startHand}
                  className="rounded-xl bg-white text-emerald-950 px-5 py-3 font-black disabled:opacity-40"
                >
                  {room && !isRoomHost ? "等待房主发牌" : "开始/下一手"}
                </button>
              ) : (
                <>
                  <button disabled={isResolving} onClick={() => updateHero("fold")} className="rounded-xl bg-red-600 px-5 py-3 font-black disabled:opacity-40">
                    弃牌
                  </button>
                  <button disabled={isResolving || hero.stack <= 0} onClick={() => updateHero("call")} className="rounded-xl bg-white text-emerald-950 px-5 py-3 font-black disabled:opacity-40">
                    {hero.stack <= toCall ? "全下跟注" : toCall > 0 ? `跟注 ${toCall}` : "过牌"}
                  </button>
                  <button disabled={isResolving || hero.stack <= 0} onClick={() => updateHero("raise", BIG_BLIND * 2)} className="rounded-xl bg-amber-400 text-black px-5 py-3 font-black disabled:opacity-40">
                    加注 +40
                  </button>
                  <button disabled={isResolving || hero.stack <= 0} onClick={() => updateHero("raise", BIG_BLIND * 5)} className="rounded-xl bg-orange-500 text-black px-5 py-3 font-black disabled:opacity-40">
                    大加注 +100
                  </button>
                  <button disabled={isResolving || hero.stack <= 0 || hero.stack <= toCall} onClick={() => updateHero("allin")} className="rounded-xl bg-purple-500 px-5 py-3 font-black disabled:opacity-40">
                    全下
                  </button>
                </>
              )}
              <button onClick={() => setShowGto((s) => !s)} className="rounded-xl bg-sky-500 px-5 py-3 font-black">
                {showGto ? "关闭GTO辅助" : "打开GTO辅助"}
              </button>
              {gameMode === "ai" && (
  <button
    onClick={() => setShowAiCards((s) => !s)}
    className="rounded-xl bg-indigo-500 px-5 py-3 font-black"
  >
    {showAiCards ? "隐藏AI手牌" : "显示AI手牌"}
  </button>
)}
              <button onClick={() => resetGame(aiLevel)} className="rounded-xl bg-emerald-700 px-5 py-3 font-black">
                重新开始
              </button>
            </div>

            <ChipStack amount={hero.bet} />
            <AnimatePresence>
              {chipBursts.filter((burst) => burst.playerId === 0).map((burst) => (
                <motion.div
                  key={burst.id}
                  initial={{ y: -10, opacity: 0, scale: 0.6 }}
                  animate={{ y: -50, opacity: 1, scale: 1 }}
                  exit={{ opacity: 0 }}
                  className="absolute right-6 top-10 rounded-full bg-amber-400 text-black px-2 py-1 text-xs font-black shadow-lg"
                >
                  +{burst.amount}
                </motion.div>
              ))}
            </AnimatePresence>
          </motion.div>
        </section>



        {showGto && (
          <section className="rounded-2xl bg-sky-950 border border-sky-600 p-5 space-y-2">
            <h2 className="text-2xl font-black">GTO辅助 / 近似训练建议</h2>
            <div>
              估算牌力：<span className="font-black">{advice.strength}%</span>
            </div>
            <div>
              底池赔率：<span className="font-black">{advice.potOdds}%</span>
            </div>
            <div>
              建议操作：<span className="font-black text-amber-300">{advice.action}</span>
            </div>
            <div className="text-sky-100">原因：{advice.reason}</div>
            <div className="text-xs text-sky-300 pt-2">注意：这是轻量训练算法，不是真正PioSolver/GTO Wizard级别的完整求解器。</div>
          </section>
        )}

        <AnimatePresence>
          {showChangelog && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
              onClick={() => setShowChangelog(false)}
            >
              <motion.div
                initial={{ y: 20, scale: 0.96, opacity: 0 }}
                animate={{ y: 0, scale: 1, opacity: 1 }}
                exit={{ y: 20, scale: 0.96, opacity: 0 }}
                transition={{ type: "spring", stiffness: 260, damping: 22 }}
                onClick={(e) => e.stopPropagation()}
                className="w-full max-w-2xl rounded-3xl border border-emerald-500/40 bg-neutral-950 p-6 shadow-2xl"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-2xl font-black">更新日志</h2>
                    <p className="text-sm text-emerald-300">当前版本：{APP_VERSION}</p>
                  </div>
                </div>

                <div className="mt-5 max-h-[65vh] overflow-y-auto space-y-4 pr-1 text-sm text-neutral-200 pb-6">

  <div className="rounded-2xl border border-emerald-700/60 bg-emerald-950/50 p-4">
    <div className="font-black text-white">v0.2.6-beta</div>
    <div>新增AI模式/真人模式切换；修复guest筹码动画；修复联机下注顺序；真人模式隐藏AI和对手手牌；更新日志只保留下方关闭按钮。</div>
  </div>

  <div className="rounded-2xl border border-emerald-700/60 bg-emerald-950/50 p-4">
    <div className="font-black text-white">v0.2.5-beta</div>
    <div>修复 guest 和房主看到同一副手牌的问题：房主座位为0，guest座位为5，各自显示自己的手牌。</div>
  </div>
                  <div className="rounded-2xl border border-emerald-700/60 bg-emerald-950/50 p-4">
                    <div className="font-black text-white">v0.2.5-beta</div>
                    <div>修复 guest 和房主看到同一副手牌的问题：房主座位为0，guest座位为5，各自显示自己的手牌。</div>
                  </div>
                  <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4">
                    <div className="font-black text-white">v0.2.4-beta</div>
                    <div>重写同步房间号逻辑：使用 activeRoomCode 保存当前房间，并让服务器向房间内所有客户端广播 gameSync。</div>
                  </div>
                  <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4">
                    <div className="font-black text-white">v0.2.3-beta</div>
                    <div>修复房主创建房间后没有记录 roomCreated，导致开始发牌时没有房间号、guest 一直等待同步的问题。</div>
                  </div>
                  <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4">
                    <div className="font-black text-white">v0.2.2-beta</div>
                    <div>修复手机端更新日志关闭按钮；修复 guest 端接收同步时闭包状态导致的牌局不同步。</div>
                  </div>
                  <div className="rounded-2xl border border-emerald-700/60 bg-emerald-950/50 p-4">
                    <div className="font-black text-white">v0.2.1-beta</div>
                    <div>修复联机不同步：只有房主可以发牌，AI行动、公共牌、摊牌和结算都会同步到同房间另一端。</div>
                  </div>
                  <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4">
                    <div className="font-black text-white">v0.2.0-beta</div>
                    <div>联机同步补丁：同房间内会同步开始新一手和玩家下注；第二位真人加入时替换鲨鱼AI，桌上保持6人。</div>
                  </div>
                  <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4">
                    <div className="font-black text-white">v0.1.7-beta</div>
                    <div>周思仪转了50人民币，所以加入训练助手猫在手牌右侧。</div>
                  </div>
                  <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4">
                    <div className="font-black text-white">v0.1.6-beta</div>
                    <div>AI大补丁：加入偷鸡下注、半诈唬加注、少量全下诈唬、价值全下和更明显的人格差异。</div>
                  </div>
                  <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4">
                    <div className="font-black text-white">v0.1.5-beta</div>
                    <div>标题更新为“德州扑克GTO训练器”，新增可打开的更新日志窗口。</div>
                  </div>
                  <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4">
                    <div className="font-black text-white">v0.1.4-beta</div>
                    <div>加入不同AI人格：疯狗、老油条、铁乌龟、跟注站、鲨鱼。</div>
                  </div>
                  <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4">
                    <div className="font-black text-white">v0.1.3-beta</div>
                    <div>限制翻牌前AI主动再加注和主动全下，减少疯狗桌问题。</div>
                  </div>
                  <div className="rounded-2xl border border-neutral-800 bg-neutral-900/70 p-4">
                    <div className="font-black text-white">v0.1.0-beta</div>
                    <div>基础德州扑克训练桌、AI牌手、GTO辅助、筹码动画和水印。</div>
                  </div>
                </div>

                <button
                  onClick={() => setShowChangelog(false)}
                  className="mt-4 w-full rounded-2xl bg-emerald-500 px-4 py-4 text-lg font-black text-black"
                >
                  关闭更新日志
                </button>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="fixed bottom-3 right-3 z-50 max-w-xs rounded-2xl border border-white/10 bg-black/70 px-4 py-3 text-right text-xs text-white/70 shadow-2xl backdrop-blur">
          <div className="font-black text-white">Poker Trainer {APP_VERSION}</div>
          <div>Created by 曹轩立 with assistance from ChatGPT</div>
          <div>For training purposes only. Not for commercial use.</div>
        </div>
      </div>
    </main>
  );
}